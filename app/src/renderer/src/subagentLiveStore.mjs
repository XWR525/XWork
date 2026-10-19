// subagent 实时摘要 store：模块级、纯 JS（无 React / 无 Electron）
//
// 设计依据：功能设计文档/subagent前端表现设计.md v2.4 §5.1（数据模型）、§5.7（性能与节流）、§8.1 U6
//
// 为什么要 store 而不是把摘要放进 App 的 state（评审 v2-B-4）：
//   SubagentCard 位于 memo 化的 MessageView 内部，MessageView 的 props 里没有摘要。
//   若把摘要经 props 下传，每次节流 setState 都会让父会话【每一条】消息的 memo 失效，
//   非流式消息还会重跑 marked.parse ⇒ 正是"子会话高频 delta 导致渲染抖动"的根因。
//   改为卡片自订阅后，只有"该 childSid 的摘要变了"的那张卡重渲染。
//
// ★ 三条契约（缺一条就会出问题，U6 逐条固化）：
//   ① getSnapshot 未变化时必须返回【同一对象引用】——否则 useSyncExternalStore 无限重渲染
//   ② subscribe 必须【稳定】：同一 childSid 拿到同一函数（用 subscriber(sid)），
//      否则每次渲染都退订/重订，节流窗口内发生的通知会丢
//   ③ digest 必须【先写数据、再通知】——通知到达时 getSnapshot 必须已是新值

/** 默认节流：与 timings.subagentLiveMs 对齐（见设计 §5.7） */
export const SUBAGENT_LIVE_THROTTLE_MS = 200

const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled'])

export function createSubagentStore(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()

  const summaries = new Map() // childSid -> summary（引用稳定：未变则不变）
  const listeners = new Map() // childSid -> Set<cb>
  const timers = new Map() // childSid -> 待触发的通知定时器
  const stableSubs = new Map() // childSid -> 稳定的 subscribe 函数（契约②）
  // 通知条去重（设计 §5.3 第 8 点）：本会话里【已知存在 subagent tool part】的子会话 id。
  // 由 App 在 messages 变化时同步（历史会话）与事件路径（实时）共同填充；
  // 判定为"part 存在"时，synthetic 通知条折叠成一行，避免同一件事出现两张卡。
  const knownChildren = new Set()
  let throttleMs = typeof opts.throttleMs === 'number' ? opts.throttleMs : SUBAGENT_LIVE_THROTTLE_MS
  let generation = null
  // 运行时注入（由 App 提供，避免把这些高频/易变数据塞进 memo 化的 MessageView props）
  let timings = {}
  let outcomeResolver = null
  let agentRoster = new Map()
  let watchTimer = null

  function emit(childSid) {
    timers.delete(childSid)
    const set = listeners.get(childSid)
    if (!set) return
    for (const cb of Array.from(set)) {
      try {
        cb()
      } catch {
        /* 单个订阅者异常不影响其它卡片 */
      }
    }
  }

  function schedule(childSid) {
    if (timers.has(childSid)) return
    const timer = setTimeout(() => emit(childSid), throttleMs)
    // Node（离线单测）下不阻塞进程退出；浏览器/Electron 下 setTimeout 返回数字，无 unref
    if (timer && typeof timer.unref === 'function') timer.unref()
    timers.set(childSid, timer)
  }

  const emptySummary = (patch) => ({
    parentSid: '',
    phase: 'pending',
    startedAt: now(),
    updatedAt: now(),
    steps: 0,
    toolCount: 0,
    lastKind: '',
    lastText: '',
    finalText: '',
    staleGeneration: null,
    staleReason: '',
    ...patch
  })

  function subscribe(childSid, cb) {
    let set = listeners.get(childSid)
    if (!set) {
      set = new Set()
      listeners.set(childSid, set)
    }
    set.add(cb)
    return function unsubscribe() {
      const cur = listeners.get(childSid)
      if (!cur) return
      cur.delete(cb)
      if (!cur.size) listeners.delete(childSid)
    }
  }

  /** 契约②：同一 childSid 恒返回同一个函数（组件侧可直接交给 useSyncExternalStore） */
  function subscriber(childSid) {
    let fn = stableSubs.get(childSid)
    if (!fn) {
      fn = (cb) => subscribe(childSid, cb)
      stableSubs.set(childSid, fn)
    }
    return fn
  }

  return {
    /** 契约①：未 digest 过返回 null；digest 过则返回稳定引用（未变更时同一对象） */
    get(childSid) {
      return summaries.get(childSid) || null
    },

    subscriber,

    subscribe,

    /** 契约③：写入新对象（引用变化）后再安排通知；节流窗口内的多次写入只通知一次 */
    digest(childSid, patch) {
      if (!childSid || !patch || typeof patch !== 'object') return null
      const prev = summaries.get(childSid)
      const next = prev ? { ...prev, ...patch, updatedAt: now() } : emptySummary({ ...patch, startedAt: now() })
      summaries.set(childSid, next)
      schedule(childSid)
      return next
    },

    /** 当前引擎世代号（主进程 engine:status / server.connected 透出后写入） */
    setGeneration(g) {
      generation = g
    },
    getGeneration() {
      return generation
    },

    /**
     * 引擎换进程（或退出）：把【未终态】的摘要标记为属于某个世代。
     * phase 计算用 `live.staleGeneration !== 当前世代` 把这类卡片降级为 unknown
     * ——注意不能靠"改写消息"实现（快照会把 part 写回 running，见设计 §5.7 ①）。
     */
    markStale(reason) {
      let n = 0
      for (const [sid, s] of Array.from(summaries.entries())) {
        if (TERMINAL_PHASES.has(s.phase)) continue
        summaries.set(sid, { ...s, staleGeneration: generation, staleReason: reason || '', updatedAt: now() })
        schedule(sid)
        n++
      }
      return n
    },

    /** 回收某父会话下的全部子智能体摘要（删父会话 / undo 回退 / 切会话清理） */
    gc(parentSid) {
      let n = 0
      for (const [sid, s] of Array.from(summaries.entries())) {
        if (s.parentSid !== parentSid) continue
        summaries.delete(sid)
        const t = timers.get(sid)
        if (t) {
          clearTimeout(t)
          timers.delete(sid)
        }
        stableSubs.delete(sid)
        const set = listeners.get(sid)
        if (set) for (const cb of Array.from(set)) { try { cb() } catch { /* 忽略 */ } }
        listeners.delete(sid)
        n++
      }
      return n
    },

    /** 全量清空（引擎重启且无法判定世代时使用；正常路径优先 markStale 保留可追溯信息） */
    reset() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      summaries.clear()
      listeners.clear()
      stableSubs.clear()
      return true
    },

    // ── 运行时注入（设计 §5.7：不能让这些数据进 memo 化的 MessageView props）──────
    setTimings(t) {
      timings = t && typeof t === 'object' ? t : {}
    },
    timings() {
      return timings
    },
    setOutcomeResolver(fn) {
      outcomeResolver = typeof fn === 'function' ? fn : null
    },
    /** 名册注入（批次 5）：供卡片显示"模型"与头像底色（agent 的 model/color 来自 /api/agent） */
    setAgentRoster(list) {
      agentRoster = new Map((Array.isArray(list) ? list : []).map((a) => [a.id, a]))
    },
    agentRosterOf(agentId) {
      return (agentId && agentRoster.get(agentId)) || null
    },
    /** 子会话 Session.Info.outcome（succeeded|failed|interrupted）；缺失返回 '' */
    outcomeOf(childSid) {
      if (!outcomeResolver) return ''
      try {
        return outcomeResolver(childSid) || ''
      } catch {
        return ''
      }
    },

    /**
     * 心跳：定时把【非终态】条目的 updatedAt 之外的信息重新通知一次。
     * 为什么需要：`finalizing` 的宽限、`running` 的纠偏（outcome 已终态）与超时降级 `unknown`
     * 都是【时间驱动】的，而 store 只在数据变化时通知；没有心跳，卡片会停在最后一次事件的状态。
     * 只在存在非终态条目时运行，且只通知这些 childSid ⇒ 不影响已完成的卡片。
     */
    startWatch(intervalMs = 3000) {
      if (watchTimer) return
      const tick = () => {
        const ts = now()
        for (const [sid, s] of Array.from(summaries.entries())) {
          if (TERMINAL_PHASES.has(s.phase)) continue
          // 只更新"观测时间"，让订阅者重算 judgePhase（含 outcome 纠偏与超时降级）
          summaries.set(sid, { ...s, watchedAt: ts })
          schedule(sid)
        }
      }
      watchTimer = setInterval(tick, intervalMs)
      if (watchTimer && typeof watchTimer.unref === 'function') watchTimer.unref()
    },
    stopWatch() {
      if (watchTimer) clearInterval(watchTimer)
      watchTimer = null
    },

    /** 节流时长可调（timings.subagentLiveMs；store 在模块加载期创建，早于配置到达） */
    setThrottleMs(ms) {
      if (typeof ms === 'number' && ms > 0) throttleMs = ms
    },

    // ── 通知条去重（§5.3 第 8 点）────────────────────────────────────────────
    /** 用当前会话里所有 subagent tool part 的 childSid 覆盖式同步（App 在 messages 变化时调用） */
    setKnownChildren(ids) {
      knownChildren.clear()
      for (const id of ids || []) if (id) knownChildren.add(id)
    },
    addKnownChild(id) {
      if (id) knownChildren.add(id)
    },
    /** part 是否存在于本会话（实时事件建立过摘要，或历史消息里扫到过）⇒ 通知条应折叠为一行 */
    isKnownChild(id) {
      return !!id && (knownChildren.has(id) || summaries.has(id))
    },

    // ── 测试/诊断用 ───────────────────────────────────────────────
    size() {
      return summaries.size
    },
    listenerCount(childSid) {
      const set = listeners.get(childSid)
      return set ? set.size : 0
    },
    hasPendingNotify(childSid) {
      return timers.has(childSid)
    }
  }
}

/** 事件源 → 摘要 patch 的映射（思考 / 工具 / 写作），供事件分支复用，避免散落的字符串判断 */
export function liveActivityFromEvent(kind, detail) {
  switch (kind) {
    case 'reasoning':
      return { lastKind: 'thinking', lastText: '正在思考…' }
    case 'tool':
      return { lastKind: 'tool', lastText: detail ? `正在 ${detail}…` : '正在执行工具…' }
    case 'text':
      return { lastKind: 'writing', lastText: '正在生成报告…' }
    case 'shell':
      return { lastKind: 'tool', lastText: detail ? `正在 shell：${detail}` : '正在 shell…' }
    default:
      return { lastKind: 'working', lastText: detail || '执行中…' }
  }
}

/** 子会话事件的归集状态（计数用 Set 去重，避免断流重连的重复帧把计数刷高） */
export function newChildEventState() {
  return { stepMids: new Set(), toolIds: new Set(), texts: new Map(), lastTextMid: '' }
}

/**
 * 纯函数归约：子会话（childSid === 事件 sessionID）的事件 → 摘要 patch。
 * 覆盖设计 §5.2 的「活动行」与「展开按钮计数」：
 *   · steps     = 见过的 assistant 文本消息数（按 messageID 去重）
 *   · toolCount = 见过的工具 part 数（按 part.id 去重）
 *   · finalText = 最后一条文本消息的全文（结论文案取首行，见 conclusionText）
 */
export function reduceChildEvent(state, type, props, now = Date.now()) {
  const s = {
    stepMids: new Set(state?.stepMids || []),
    toolIds: new Set(state?.toolIds || []),
    texts: new Map(state?.texts || []),
    lastTextMid: state?.lastTextMid || ''
  }
  let activity = null
  if (type === 'message.part.updated') {
    const part = (props && props.part) || {}
    const mid = part.messageID || (props && props.messageID) || ''
    if (part.type === 'text') {
      if (mid) {
        s.stepMids.add(mid)
        s.texts.set(mid, part.text || '')
        s.lastTextMid = mid
      }
      activity = liveActivityFromEvent('text')
    } else if (part.type === 'reasoning') {
      activity = liveActivityFromEvent('reasoning')
    } else if (part.type === 'tool') {
      if (part.id) s.toolIds.add(part.id)
      const cmd = part.state && part.state.input && part.state.input.command
      activity = part.tool === 'shell' ? liveActivityFromEvent('shell', shortActivity(cmd)) : liveActivityFromEvent('tool', part.tool)
    }
  } else if (type === 'message.part.delta') {
    if (props && props.field === 'text' && props.messageID) {
      s.texts.set(props.messageID, (s.texts.get(props.messageID) || '') + (props.delta || ''))
      s.lastTextMid = props.messageID
      activity = liveActivityFromEvent('text')
    }
  }
  const patch = {
    steps: s.stepMids.size,
    toolCount: s.toolIds.size,
    finalText: s.texts.get(s.lastTextMid) || '',
    updatedAt: now
  }
  if (activity) {
    patch.lastKind = activity.lastKind
    patch.lastText = activity.lastText
  }
  return { state: s, patch }
}

/** 活动行命令压缩（与 subagentModel.shortCommand 同规则；此处内联以避免 store → model 的循环依赖） */
function shortActivity(cmd) {
  const first = String(cmd || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()
  return first.length > 64 ? first.slice(0, 61) + '…' : first
}

/**
 * 展开态的消息镜像总线（设计 §5.1 ③ / §5.7「事件镜像为主、断流才轮询」）。
 *
 * 为什么用"总线 + 快照种子"而不是把子会话消息塞进 App state：
 *   展开的是【某一张卡】的时间线；把它放进 App state 会让整个消息列表重渲染（正是 B-4 要避免的）。
 *   这里按 childSid 隔离：只有订阅了该 childSid 的组件收到通知。
 *
 * 关键约束（设计 §5.7）：**单一真源** —— 快照只做种子，之后一律由事件增量维护；
 * 若同时存在 `streamCacheRef[childSid]`（子会话曾被当作当前会话打开过），也把事件投到这里，
 * 避免两套镜像分叉。
 */
export function createSubagentStream({ applyPart, applyDelta } = {}) {
  const messages = new Map() // childSid -> messages[]
  const subs = new Map() // childSid -> Set<cb>
  const lastEvent = new Map() // childSid -> ts
  const stableSubs = new Map()

  function notify(sid) {
    const set = subs.get(sid)
    if (!set) return
    for (const cb of Array.from(set)) {
      try {
        cb()
      } catch {
        /* 单订阅者异常不影响其它 */
      }
    }
  }

  function subscribe(sid, cb) {
    let set = subs.get(sid)
    if (!set) {
      set = new Set()
      subs.set(sid, set)
    }
    set.add(cb)
    return () => {
      const cur = subs.get(sid)
      if (!cur) return
      cur.delete(cb)
      if (!cur.size) subs.delete(sid)
    }
  }

  return {
    subscriber(sid) {
      let fn = stableSubs.get(sid)
      if (!fn) {
        fn = (cb) => subscribe(sid, cb)
        stableSubs.set(sid, fn)
      }
      return fn
    },
    subscribe,
    has(sid) {
      return messages.has(sid)
    },
    get(sid) {
      return messages.get(sid) || null
    },
    /** 种子快照（首次展开时调用）；重复 seed 会覆盖为最新权威快照 */
    seed(sid, list) {
      if (!sid) return null
      messages.set(sid, Array.isArray(list) ? list : [])
      lastEvent.set(sid, Date.now())
      notify(sid)
      return messages.get(sid)
    },
    /** 事件增量：仅对已 seed 的 childSid 生效（未展开的卡片不维护镜像，零成本） */
    publish(sid, event) {
      if (!sid || !messages.has(sid)) return false
      const cur = messages.get(sid) || []
      let next = cur
      try {
        if (event && event.kind === 'part' && typeof applyPart === 'function') {
          next = applyPart(cur, event.part, event.mid)
        } else if (event && event.kind === 'delta' && typeof applyDelta === 'function') {
          next = applyDelta(cur, event.props)
        }
      } catch {
        next = cur
      }
      if (next !== cur) messages.set(sid, next)
      lastEvent.set(sid, Date.now())
      notify(sid)
      return true
    },
    lastEventAt(sid) {
      return lastEvent.get(sid) || 0
    },
    /** 收起卡片时释放（设计 §5.7：收起/终态/切会话即停止并回收） */
    drop(sid) {
      messages.delete(sid)
      lastEvent.delete(sid)
      stableSubs.delete(sid)
      const set = subs.get(sid)
      if (set) for (const cb of Array.from(set)) { try { cb() } catch { /* 忽略 */ } }
      subs.delete(sid)
      return true
    },
    /** 引擎退出/重启时回收全部镜像（设计 §5.7 ①：清 subagentStreamStore） */
    reset() {
      const sids = Array.from(messages.keys())
      messages.clear()
      lastEvent.clear()
      for (const sid of sids) notify(sid)
      return sids.length
    }
  }
}
