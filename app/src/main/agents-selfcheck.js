// .agents 桥接自检（设计 v2.1 §5.6）
//
// 为什么独立成模块：index.js 强依赖 electron，无法在 node 下直接测试；
// 而自检的收敛判据（三段式注册表、激活暂态、回显断言）恰恰是最容易写错、也最难手工复现的部分。
// 本模块只依赖注入的 bridge 与 agentsBridge，可在真机上直接单测（见 test-agents-bridge-selfcheck.cjs）。
//
// 四条硬约束（全部来自实测，改任何一条都会引入假告警或假通过）：
//   ① 必须【带 location 并校验回显】：不带参数永远查「引擎进程启动目录」，而 workspace:switch 是
//      不换进程的热切换 → 会比对【上一个工作区】（假告警；同名条目还会假通过）。点号形态会被引擎静默忽略。
//   ② 必须【轮询至收敛】：注册表是三段式（0 → 仅内置 → 全量），"非空"这个判据会在"仅内置"平台期就成立。
//   ③ 首次 0 条是【激活暂态】：对某 location 的首次查询本身即触发加载，不是失败。
//   ④ 样本不得跌破峰值 90%（抑制 locationReload 的全局清空窗口，多实例会互相干扰）。

'use strict'

const DEFAULTS = {
  deadlineMs: 15_000,
  intervalMs: 1_000,
  initialDelayMs: 1_000, // 首次查询本身触发 location 激活，给引擎一点时间
  collapseRatio: 0.9,
  // 进度宽限（V4 尖刺后新增）：到 deadline 时若"注册表仍在增长"或"部分期望条目已出现"，
  // 说明引擎还在加载而不是失败 —— 再给这么多时间，避免冷启动误报。
  // 依据：V4 实测（空 npm 插件缓存）HTTP 就绪 0.62 s → 首次含期望 2.86 s → 稳定 3.13 s，
  // 即进程启动后约 3 s 完成；15 s 已是 4.8× 余量，但首次运行（需联网装插件）无上界，故加此保护。
  graceMs: 10_000,
  maxExtensions: 2
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal && signal.cancelled) return resolve()
    const t = setTimeout(resolve, ms)
    if (signal && typeof signal.onCancel === 'function') signal.onCancel(() => clearTimeout(t))
  })

/** 从 API 响应里取 id/name 列表（兼容 {data:[...]} 信封与裸数组） */
function idList(resp) {
  if (Array.isArray(resp)) return resp.map((x) => x.id ?? x.name)
  if (resp && Array.isArray(resp.data)) return resp.data.map((x) => x.id ?? x.name)
  return null
}

/** 该域的样本是否已稳定（需要"连续两次相等"；扩展过宽限时基线被重置，故需重新积累一次） */
function domainStable(domain, prev, list, want, peak, ratio) {
  const hasAll = want.every((x) => list.includes(x))
  const notCollapsed = list.length >= Math.ceil(peak * ratio)
  const same = prev && JSON.stringify([...list].sort()) === JSON.stringify(prev)
  return !!(same && hasAll && notCollapsed)
}

/**
 * 对一个工作区跑收敛式自检。
 * @param {object} o
 * @param {object} o.bridge            Bridge 实例（需有 agents(dir)/commands(dir)）
 * @param {object} o.agentsBridge      agents-bridge 模块（expectedEntries/inspectAgentsBridge）
 * @param {string} o.workspace         目标工作区（绝对路径）
 * @param {object} [o.signal]          {cancelled:boolean} 取消标记（被新调度取代时置 true）
 * @param {object} [o.opts]            覆盖 DEFAULTS
 * @returns {Promise<{status:'no-op'|'links-bad'|'ok'|'not-converged'|'cancelled', ...}>}
 */
async function runSelfCheck({ bridge, agentsBridge, workspace, signal = {}, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts }
  const exp = agentsBridge.expectedEntries(workspace)
  if (exp.files === 0) return { status: 'no-op', workspace }

  // 联接体检：只有【该域确实有期望条目、却缺链】才算异常。
  // 反例（阶段 5 测试暴露）：工作区只有 .agents/agents/、没有 .agents/commands/ 时，
  // commands 槽位天然是 missing 且期望为空 —— 那是 no-op，不该让整个自检短路（否则真问题被掩盖）。
  const insp = agentsBridge.inspectAgentsBridge(workspace)
  const expected = {
    agents: [...exp.agents],
    commands: [...exp.commands]
  }
  const bad = Object.entries(insp.links).find(([rel, v]) => {
    if (v.state === 'ok') return false
    const domain = /commands$/.test(rel) ? 'commands' : 'agents'
    return expected[domain].length > 0
  })
  if (bad) return { status: 'links-bad', workspace, rel: bad[0], linkState: bad[1].state }

  await sleep(cfg.initialDelayMs, signal)
  if (signal.cancelled) return { status: 'cancelled', workspace }

  const startedAt = Date.now()
  const peak = { agents: 0, commands: 0 }
  const prev = { agents: null, commands: null }
  const stable = { agents: expected.agents.length === 0, commands: expected.commands.length === 0 }
  const lastErr = { agents: null, commands: null }
  const lastSample = { agents: null, commands: null }
  let deadlineAt = startedAt + cfg.deadlineMs
  let extensions = 0
  let progressed = false // 每轮重置；到点判断要用它（故不能声明在循环体内）

  while (true) {
    if (signal.cancelled) return { status: 'cancelled', workspace }
    if (Date.now() >= deadlineAt) {
      // 到点：仍未稳定但"引擎还在加载"的迹象 → 宽限而不是误报。冷启动（首次运行需联网装 npm 插件）
      // 没有上界，故最多宽限 maxExtensions 次。
      // 判据必须是【有部分数据或仍在变化】：全部为空（引擎未就绪 / location 未加载返回 500）
      // 属于明确失败，不得宽限——否则一个连不上的引擎会被拖满所有宽限窗口。
      const nonEmpty = (d) => (lastSample[d]?.length ?? 0) > 0
      const unmet = (d) => !stable[d] && expected[d].length > 0
      const stillLoading =
        progressed || (unmet('agents') && nonEmpty('agents')) || (unmet('commands') && nonEmpty('commands'))
      if (stillLoading && extensions < cfg.maxExtensions) {
        extensions++
        deadlineAt = Date.now() + cfg.graceMs
        // 必须【重置稳定基线】：宽限前的最后样本与宽限后的首个样本可能相同，
        // 若不重置，"连续两次相等"会立刻成立，宽限就失去意义
        prev.agents = null
        prev.commands = null
        console.log(`[agents-selfcheck] 注册表仍在加载，宽限 ${cfg.graceMs}ms（第 ${extensions} 次）`)
      } else {
        break
      }
    }
    // 本轮的"有进展"证据：样本变化、条数增长、或已有部分期望条目落地
    progressed = false
    for (const domain of ['agents', 'commands']) {
      if (stable[domain]) continue
      const want = expected[domain]
      let list = null
      try {
        const resp = domain === 'agents' ? await bridge.agents(workspace) : await bridge.commands(workspace)
        list = idList(resp)
        if (list === null) lastErr[domain] = 'unexpected response shape'
      } catch (e) {
        // location 未加载时引擎返回 500；bridge 抛错。这是暂态，继续轮询（不可判失败）
        lastErr[domain] = e.message
      }
      if (list !== null) {
        peak[domain] = Math.max(peak[domain], list.length)
        lastSample[domain] = list
        if (!prev[domain] || JSON.stringify([...list].sort()) !== JSON.stringify(prev[domain])) progressed = true
        if (list.some((x) => want.includes(x))) progressed = true // 部分期望条目已落地
        if (domainStable(domain, prev[domain], list, want, peak[domain], cfg.collapseRatio)) stable[domain] = true
        prev[domain] = [...list].sort()
      }
    }
    if (stable.agents && stable.commands) {
      return {
        status: 'ok',
        workspace,
        elapsedMs: Date.now() - startedAt,
        agents: expected.agents.length,
        commands: expected.commands.length,
        extensions
      }
    }
    await sleep(cfg.intervalMs, signal)
  }

  return {
    status: 'not-converged',
    workspace,
    elapsedMs: Date.now() - startedAt,
    expected,
    lastSample,
    lastErr,
    extensions
  }
}

/** 把自检结果翻译成给用户的一句话（null = 无需提示） */
function describeSelfCheck(result) {
  switch (result.status) {
    case 'ok':
      return `.agents 已加载 ${result.agents} 个智能体 / ${result.commands} 个命令（经 junction）`
    case 'not-converged': {
      const err = Object.entries(result.lastErr || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')
      return `.agents 定义可能未被引擎加载（期望 ${result.expected.agents.length} 智能体 / ${result.expected.commands.length} 命令）${err ? '：' + err : ''}；可尝试重启引擎`
    }
    default:
      return null // no-op / links-bad / cancelled：不在此处提示
  }
}

module.exports = { runSelfCheck, describeSelfCheck, idList, DEFAULTS }
