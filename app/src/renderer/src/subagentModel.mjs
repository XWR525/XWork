// subagent（子智能体）前端模型层：纯函数，无 React / 无 Electron 依赖
//
// 设计依据：功能设计文档/subagent前端表现设计.md v2.4
//   §5.1  phase 状态机（含世代号与实测的失败/取消判据）
//   §5.4(b) 工具 state 合并：状态单调化 + metadata 按键合并 + input 类型保护 + tool 名兜底
//   §5.4(c) 时间与错误载荷归一化（T0-② 实测：error = {type,message}，无 content/metadata）
//   §5.3 要点 1  <subagent> 包裹剥壳
//   §8.1  「可执行前提」：U4/U7/U8/U10/U12/U13 必须能离线 require ⇒ 逻辑集中在本文件
//
// 为什么必须独立成纯 JS（评审 v2-S-3）：App.jsx 是 JSX + React，Node 无法直接 require，
// 于是这些逻辑此前只能靠"看代码"保证正确；抽出来后单测（scripts/test-subagent-model.mjs）才能跑。

// ── 1) 工具 state 合并（P10）───────────────────────────────────────────────
// 引擎事件是不保证顺序、也不保证不重复的（SSE 断流重连会补推中间状态；同一全局 SSE 上
// 不同会话的事件交织），因此合并必须满足两条：
//   ① 状态不可回退（含终态之间：error 高于 completed，取先到者更保守）
//   ② metadata 按键合并且 prev 优先 —— 否则迟到的 progress 会把 metadata.status 写回 'running'，
//      使一张已完成的卡命中 phase 第 3 行被显示成「后台运行中」（并丢掉 truncated）
export const TOOL_STATUS_RANK = { pending: 0, streaming: 0, running: 1, completed: 2, error: 3 }
const TERMINAL_STATUS = new Set(['completed', 'error'])

/**
 * 合并工具 part 的 state。
 * @param {object|undefined} prev 已有 state
 * @param {object|undefined} next 事件带来的 state（progress 只带 metadata；success 带 output+metadata）
 */
export function mergeToolState(prev, next) {
  if (!prev) return next
  if (!next) return prev
  // 引擎 ToolState.Streaming.input 是【字符串】：不得覆盖已解析的对象，否则 P10 的 bug 换个形态复活
  const guard =
    typeof next.input === 'string' && prev.input && typeof prev.input === 'object' ? { input: prev.input } : null
  const merged = { ...prev, ...next, ...(guard || {}), time: { ...(prev.time || {}), ...(next.time || {}) } }
  const prevRank = TOOL_STATUS_RANK[prev.status]
  const nextRank = TOOL_STATUS_RANK[next.status]
  if (prev.status && next.status && nextRank < prevRank) {
    merged.status = prev.status
    const meta = { ...(next.metadata || {}), ...(prev.metadata || {}) }
    // prev 已是终态时，不允许任何来源把 status 改回 running（phase 第 3 行的判据）
    if (TERMINAL_STATUS.has(prev.status) && meta.status === 'running') delete meta.status
    merged.metadata = meta
  }
  return merged
}

/** tool 名兜底（评审 v2-M-12）：SSE 断流后 bridge 的 _toolNames 缓存缺项会给出 undefined */
export function resolveToolName(prevTool, nextTool) {
  return nextTool || prevTool || ''
}

/**
 * 渲染层本地时间戳：语义 = 「最后一次状态更新时刻」（v2.4 §5.4(c) 定稿）。
 * 注意：**不是**"最后一次产生输出的时刻"——progress 带 metadata 因而也会刷新它；
 * 若要改成只算真实输出，须在这里加 output/metadata 差异判断（本版不做）。
 * @param {object} state
 * @param {number} now 由调用方传入（便于单测）
 */
export function stampToolTime(state, now) {
  if (!state) return state
  return { ...state, time: { ...(state.time || {}), _tEnd: now } }
}

// ── 2) 错误载荷归一化（T0-② 实测）──────────────────────────────────────────
// 实测（本机会话库，2026-10-16）：
//   快照路径 state 的键恰为 status/input/error（【无 content、无 metadata】）
//   state.error 恒为对象 {type, message}；type ∈ permission.rejected / tool.execution / unknown / aborted
// 事件路径（session.tool.error）的 d.error 形态尚无样本 ⇒ 对象取 message、字符串原样、空回落
export function normalizeToolError(err) {
  if (err === undefined || err === null || err === '') return { text: '', type: '', raw: null }
  if (typeof err === 'string') return { text: err, type: '', raw: null }
  const text = err.message || err.error || ''
  return { text: String(text || ''), type: String(err.type || ''), raw: err }
}

/** 取消/中断判定：优先结构化 error.type（实测 'aborted'），文案仅作兜底 */
export function isCancelledError(text, type) {
  if (String(type || '').toLowerCase() === 'aborted') return true
  return /interrupt|cancel/i.test(String(text || ''))
}

// ── 3) <subagent> 包裹剥壳（§5.3 要点 1）──────────────────────────────────
const SUBAGENT_WRAP = /^<subagent\b([^>]*)>\s*([\s\S]*?)\s*<\/subagent>$/
export function unwrapSubagentOutput(output) {
  const s = output === undefined || output === null ? '' : String(output)
  const m = s.match(SUBAGENT_WRAP)
  if (!m) return { wrapped: false, text: s, state: '', description: '' }
  const attrs = m[1] || ''
  const state = (attrs.match(/\bstate="([^"]*)"/) || [])[1] || ''
  const description = (attrs.match(/\bdescription="([^"]*)"/) || [])[1] || ''
  return { wrapped: true, text: m[2], state, description }
}

// ── 4) 结论摘要与身份降级 ─────────────────────────────────────────────────
/**
 * 结论摘要：优先子会话实时摘要的 finalText，其次 output 剥壳后的首行。
 * 返回 { text, from } —— from ∈ 'live' | 'output' | 'none'
 */
export function conclusionText({ partState, live, maxLen = 120 } = {}) {
  const fromLive = live && live.finalText ? String(live.finalText) : ''
  const raw = fromLive || unwrapSubagentOutput(partState && partState.output).text
  if (!raw) return { text: '', from: 'none' }
  const first = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l) || ''
  const flat = first.replace(/\s+/g, ' ').slice(0, maxLen)
  return { text: flat, from: fromLive ? 'live' : 'output' }
}

/**
 * 身份降级级别（I3 + 评审 v1-M-5，v2.4 按实测确认）：
 *   1 = 有 input.agent/description、但【无 metadata.sessionID】⇒ 正常显示名字与描述，仅不能下钻
 *       （T0-② 实测：错误态没有 metadata ⇒ 失败卡必然走这一级）
 *   2 = 连 input.agent 都没有 ⇒ 「未知子智能体」，退化展示，不按调用顺序编造
 */
export function identityLevel(partState) {
  const input = (partState && partState.input) || {}
  return input.agent ? 1 : 2
}

/** 身份绑定（I3）：只认 metadata.sessionID，取不到则不绑定（不按顺序推断） */
export function childSessionId(partState) {
  const meta = (partState && partState.metadata) || {}
  return typeof meta.sessionID === 'string' && meta.sessionID ? meta.sessionID : ''
}

// ── 5) phase 判定（§5.1 v2.4）─────────────────────────────────────────────
export const PHASE = {
  pending: 'pending',
  running: 'running',
  background: 'background',
  finalizing: 'finalizing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  unknown: 'unknown'
}

/** 终态判定：终态不再受世代号/超时影响 */
export function isTerminalPhase(phase) {
  return phase === PHASE.completed || phase === PHASE.failed || phase === PHASE.cancelled
}

/**
 * 判定子智能体卡片的 phase。
 *
 * @param {object}   o
 * @param {object}   o.partState     工具 part 的 state（**必须已过 mergeToolState 单调化**）
 * @param {object}   [o.live]        subagentLiveStore 的摘要（{ finalText, updatedAt, staleGeneration }）
 * @param {number}   [o.generation]  当前引擎世代号（主进程 engine:status / server.connected 透出）
 * @param {string}   [o.outcome]     子会话 Session.Info.outcome（succeeded|failed|interrupted，可缺省）
 * @param {number}   [o.now]
 * @param {number}   [o.graceMs]     finalizing / 纠偏的宽限（timings.subagentOutcomeGraceMs）
 * @param {number}   [o.unknownAfterMs] 无事件多久降级 unknown（timings.subagentUnknownAfterMs）
 * @param {boolean}  [o.allowBackground] T0-③ 通过前必须为 false（后台态先按 completed 呈现）
 */
export function judgePhase({
  partState,
  live = null,
  generation = null,
  outcome = '',
  now = Date.now(),
  graceMs = 5000,
  unknownAfterMs = 15000,
  // T0-③ 已于 2026-10-19 闭环（载荷 + 完成通知均实测），故默认允许后台态。
  // 注意：引擎**不会**更新 part 的 `metadata.status`（后台化后永远是 'running'），
  // 所以后台态的终态纠正在下面的完成态分支里由 synthetic 通知或会话 outcome 收口。
  allowBackground = true
} = {}) {
  const st = partState || {}
  const status = st.status
  const meta = st.metadata || {}
  const out = unwrapSubagentOutput(st.output)

  // 0) 防御行（v2.4：本机 0 次观测，仅防"completed + 包裹属性声明失败/取消"的老形态）
  if (status === 'completed' && out.wrapped && (out.state === 'error' || out.state === 'cancelled')) {
    return out.state === 'cancelled' ? PHASE.cancelled : PHASE.failed
  }

  // 1) / 2) 错误态：取消优先（结构化 errorType，文案兜底）
  if (status === 'error') {
    const e = normalizeToolError(st.error)
    return isCancelledError(e.text, st.errorType || e.type) ? PHASE.cancelled : PHASE.failed
  }

  const landedAt = (st.time && (st.time.end ?? st.time._tEnd)) ?? null
  // 注意用 typeof 判断而不是真值判断：时间戳 0 是合法值（旧时间戳/单调时钟起点），
  // 用 `live.updatedAt ?` 会把 0 当成"没有时间戳"，导致超时兜底失效（单测抓到过）
  const silentFor = live && typeof live.updatedAt === 'number' ? now - live.updatedAt : null
  const generationChanged =
    !!live && live.staleGeneration != null && generation != null && live.staleGeneration !== generation

  // 3) / 4) / 5) 完成态
  if (status === 'completed') {
    if (allowBackground && meta.status === 'running') {
      // 后台态的**终态纠正**（实测：引擎不会把 metadata.status 从 running 改掉）：
      //  ① synthetic 完成通知：父会话里那条 `metadata.source='subagent'` 的消息带 `state`，
      //     由 App 在 messages 变化时写入摘要的 `noticeState`；
      //  ② 会话记录的 outcome（succeeded/failed/interrupted）作为第二来源。
      const n = live && live.noticeState
      if (n === 'completed') return PHASE.completed
      if (n === 'error') return PHASE.failed
      if (n === 'cancelled') return PHASE.cancelled
      if (outcome === 'succeeded') return PHASE.completed
      if (outcome === 'failed') return PHASE.failed
      if (outcome === 'interrupted') return PHASE.cancelled
      return PHASE.background
    }
    const summaryReady = (live && live.finalText) || out.text || out.wrapped
    const withinGrace = landedAt != null && now - landedAt < graceMs
    if (!summaryReady && (withinGrace || meta.truncated === true)) return PHASE.finalizing
    return PHASE.completed
  }

  // 6) 运行中
  if (status === 'running') {
    // 6a) 世代号已变（引擎换进程）⇒ 旧世代的运行态一律不可信
    if (generationChanged) return PHASE.unknown
    // 6b) 纠偏：part 停跑超过宽限、且子会话 outcome 已终态 ⇒ 以 outcome 收口
    if (silentFor != null && silentFor >= graceMs && outcome) {
      if (outcome === 'succeeded') return PHASE.completed
      if (outcome === 'failed') return PHASE.failed
      if (outcome === 'interrupted') return PHASE.cancelled
    }
    // 6c) 兜底：长时间无事件且无 outcome ⇒ 状态未知
    if (silentFor != null && silentFor >= unknownAfterMs) return PHASE.unknown
    return PHASE.running
  }

  // 7) 其余（引擎 streaming / 桥自造 pending / 无状态）
  if (generationChanged) return PHASE.unknown
  if (silentFor != null && silentFor >= unknownAfterMs) return PHASE.unknown
  return PHASE.pending
}

// ── 6) 渲染层字段白名单（评审 v2-B-3 + v3-S-7 收敛）────────────────────────
// 为什么单独成函数：`normalize()`、`settleApply()`、`applyPartUpdated()` 的占位分支
// 各自维护了一份"字段白名单"，任何新增字段（如 subagentNotice）漏掉一处就会
// 只在 SSE 路径存在、GET 路径全丢，并被 streamCacheRef 缓存整个会话生命周期。
const PART_KEYS = ['id', 'callID', 'type', 'text', 'tool', 'state', 'subagentNotice', 'streaming']

/** 工具/文本/思考/通知 part 的整形（三处共用） */
export function normalizePart(p) {
  if (!p || typeof p !== 'object') return p
  const out = {}
  for (const k of PART_KEYS) {
    if (p[k] !== undefined) out[k] = k === 'text' ? p[k] || '' : p[k]
  }
  if (out.text === undefined) out.text = ''
  return out
}

/** 子智能体通知条（synthetic，role='system'）的数据规整 */
export function normalizeSubagentNotice(notice) {
  if (!notice || typeof notice !== 'object') return null
  return {
    childID: notice.childID || '',
    agent: notice.agent || '',
    state: notice.state || '',
    description: notice.description || ''
  }
}

// ── 7) 呈现映射（§5.8 文案表 / §5.6 状态胶囊 / §5.2 字段来源表）─────────────
/** §5.8：phase → 中文徽标文案 */
export const PHASE_LABEL = {
  pending: '准备中',
  running: '运行中',
  background: '后台运行中',
  finalizing: '收尾中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知'
}
export function phaseLabel(phase) {
  return PHASE_LABEL[phase] || String(phase || '')
}
/** §5.8 可终止列：仅 running/background（finalizing 不可终止：工具已返回） */
export function canTerminate(phase) {
  return phase === PHASE.running || phase === PHASE.background
}
/**
 * 状态胶囊类名：复用既有 `.tool-status` 的命名，注意失败态类名是 `error` 而不是 `failed`；
 * cancelled/unknown/background/finalizing 是本设计新增的修饰类（§5.6 要求显式声明底色与描边）。
 */
export function statusClassOf(phase) {
  if (phase === PHASE.completed) return 'completed'
  if (phase === PHASE.failed) return 'error'
  if (phase === PHASE.running) return 'running'
  return String(phase || 'pending')
}

/** shell 活动行的命令压缩（单行、≤64 字，避免把整段脚本贴进活动行） */
export function shortCommand(cmd) {
  const first = String(cmd || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()
  return first.length > 64 ? first.slice(0, 61) + '…' : first
}

/**
 * 展开态兜底轮询的决策（设计 §5.7「事件镜像为主，断流才轮询」+ ⑤ 连续失败上限）。
 * 为什么抽成纯函数：轮询逻辑写在组件里无法离线测，而"什么时候该停"正是最容易写错的地方
 * （停早了过程不刷新；停晚了引擎已死还在空转）。
 * @returns {'skip'|'poll'|'stop'}
 *   stop  = 已有结论（终态）或连续失败达上限 ⇒ 停止轮询并提示
 *   poll  = 距最后一条事件超过 staleMs 且未达上限 ⇒ 拉一次快照兜底
 *   skip  = 事件流正常，什么都不做
 */
export function pollDecision({ terminal, sinceEventMs, staleMs = 8000, failCount = 0, maxFail = 3 } = {}) {
  if (terminal) return 'stop'
  if (failCount >= maxFail) return 'stop'
  if (!(sinceEventMs >= staleMs)) return 'skip'
  return 'poll'
}

/**
 * 头像底色的安全取值（设计 §5.6 / 评审 v2-S-1）：
 * `Agent.Info.color` 是**任意字符串**，直接塞进 style 等于给外部数据开了一个样式注入面。
 * 只接受 #rgb / #rrggbb / rgb() / rgba() / hsl() / hsla() 这几种形态，其余返回 ''（回落 color-mix 主题色）。
 */
export function safeAgentColor(color) {
  const s = String(color || '').trim()
  if (!s || s.length > 32) return ''
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s
  if (/^rgba?\(\s*[\d.\s,%]+\)$/i.test(s)) return s
  if (/^hsla?\(\s*[\d.\s,%deg]+\)$/i.test(s)) return s
  return ''
}

/**
 * 由父会话的 `subagent` 工具 part 派生 store 摘要（纯函数，事件处理与卡片自愈共用）。
 * 返回 { childSid, patch }；`patch` 只含"父侧权威"的字段：
 *   phase / agent / description / finalText（结论摘要）/ errorText
 * 计数（steps/toolCount）与活动行来自子会话事件，见 subagentLiveStore.reduceChildEvent。
 */
export function livePatchFromSubagentPart(part, { prev = null, generation = null, now = Date.now(), timings = {} } = {}) {
  const st = (part && part.state) || {}
  const childSid = childSessionId(st)
  const out = unwrapSubagentOutput(st.output)
  const input = st.input || {}
  const phase = judgePhase({
    partState: st,
    live: prev,
    generation,
    now,
    graceMs: timings.subagentOutcomeGraceMs,
    unknownAfterMs: timings.subagentUnknownAfterMs
  })
  const concluded = phase === PHASE.completed || phase === PHASE.failed || phase === PHASE.cancelled
  const err = normalizeToolError(st.error)
  const patch = {
    phase,
    agent: input.agent || (prev && prev.agent) || '',
    description: input.description || out.description || (prev && prev.description) || ''
  }
  if (concluded && out.text) patch.finalText = (prev && prev.finalText) || out.text
  if (phase === PHASE.failed || phase === PHASE.cancelled) patch.errorText = err.text || (prev && prev.errorText) || ''
  return { childSid, patch }
}


// ── 执行中的一行提示（2026-10-19 优化）──────────────────────────────────────
// 旧文案是 `AI 正在执行中… 正在${tool}`，直接拼英文工具名 ⇒ 出现「正在subagent」这种半截中文+英文。
// 这里统一：工具名给中文短标签；子智能体额外显示"在等谁"（agent + 描述），让人知道卡在哪。
export const TOOL_LABEL_ZH = {
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  patch: '修改文件',
  glob: '查找文件',
  grep: '搜索内容',
  shell: '执行命令',
  webfetch: '抓取网页',
  websearch: '联网搜索',
  todowrite: '更新待办',
  todoread: '读取待办',
  question: '向你提问',
  subagent: '子智能体',
  task: '子智能体'
}

/** 工具名 → 中文短标签（未知工具回落原名，不吞信息） */
export function toolLabelZh(name) {
  const raw = String(name || '')
  const key = raw.toLowerCase()
  return TOOL_LABEL_ZH[key] || raw || '工具'
}

const trimEllipsis = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/**
 * 执行中提示文案（busy hint）：
 *  - stopping            → 「正在停止…」
 *  - 子智能体            → 「AI 正在等待 子智能体 · general 完成：执行 PowerShell 等待」
 *  - 其它工具            → 「AI 正在执行命令…」
 *  - thinking / writing  → 各自短句
 * @param {{kind?:string, tool?:string, input?:object}|null} step
 * @param {boolean} stopping
 */
export function busyHintText(step, stopping = false) {
  if (stopping) return '正在停止…'
  if (!step || !step.kind) return 'AI 正在执行中…'
  if (step.kind === 'tool') {
    const tool = String(step.tool || '')
    const input = step.input || {}
    if (tool === 'subagent' || tool === 'task') {
      const who = input.agent ? `子智能体 · ${String(input.agent)}` : '子智能体'
      const desc = trimEllipsis(input.description, 24)
      return desc ? `AI 正在等待 ${who} 完成：${desc}` : `AI 正在等待 ${who} 完成`
    }
    return `AI 正在${toolLabelZh(tool)}…`
  }
  if (step.kind === 'thinking') return 'AI 正在思考…'
  if (step.kind === 'writing') return 'AI 正在生成回复…'
  return 'AI 正在执行中…'
}
