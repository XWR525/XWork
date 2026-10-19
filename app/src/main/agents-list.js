// 智能体列表的轮询与整形（供输入区选择器；设计见 index.js 的 agents:list）
//
// 为什么单独成模块：index.js 强依赖 electron、无法在 node 下测试，
// 而这里的两个坑都出过真实事故（装完新包后只显示 build/plan），必须能回归：
//   ① 收敛判据过早满足：引擎启动后配置加载是异步的，实测 t≈2 s 时注册表已"稳定"但只有
//      4 项（.agents 尚未注册，约 3.8 s 才全量）→ 只看"连续两次样本相等"会拿到不完整列表。
//      故收敛 = 连续两次样本相等【且已包含期望条目】。
//   ② 并发调用互相作废：渲染层会并发发起多次查询（日志实测 3 次）。早期实现用"生成号"
//      后到作废先到，导致已完成的结果被丢弃并返回空列表 → 选择器回退成 build/plan。
//      故同工作区的并发调用合并为一次（coalesce），且只在工作区真的变化时才丢弃结果。

'use strict'

const DEFAULTS = {
  deadlineMs: 12_000,
  intervalMs: 400
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 API 响应取出 agent 数组（兼容 {data:[…]} 信封与裸数组） */
function agentArray(resp) {
  if (Array.isArray(resp)) return resp
  if (resp && Array.isArray(resp.data)) return resp.data
  return []
}

/**
 * 轮询直到注册表收敛：连续两次样本相等且包含期望条目。
 * @param {object} o
 * @param {object} o.bridge            需有 agents(dir)
 * @param {string} o.workspace
 * @param {Iterable<string>} [o.expectedIds] 期望出现的 id（工作区 .agents 推导；为空则只看稳定）
 * @param {object} [o.opts]            覆盖 DEFAULTS（测试用）
 * @returns {Promise<{list:Array, converged:boolean, waited:number, samples:number, lastError:string|null}>}
 */
async function waitForAgentRegistry({ bridge, workspace, expectedIds, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts }
  const want = [...(expectedIds || [])]
  const started = Date.now()
  let prev = null
  let list = []
  let samples = 0
  let lastError = null
  while (Date.now() - started < cfg.deadlineMs) {
    try {
      const cur = agentArray(await bridge.agents(workspace))
      list = cur
      samples++
      const ids = cur.map((a) => a.id)
      const hasExpected = want.every((x) => ids.includes(x))
      const same = prev && JSON.stringify([...ids].sort()) === JSON.stringify(prev)
      if (same && hasExpected) {
        return { list: cur, converged: true, waited: Date.now() - started, samples, lastError }
      }
      prev = [...ids].sort()
    } catch (e) {
      lastError = e.message // location 未加载时引擎返回 500 → 暂态，继续重试
    }
    await sleep(cfg.intervalMs)
  }
  return { list, converged: false, waited: Date.now() - started, samples, lastError }
}

/**
 * 整理成渲染层需要的形状：过滤内部智能体、标注来源、自定义排前、内置按 id 排序。
 *
 * 设计 §5.5(c) / 评审 v2-B-4 + v3-B-4（**硬前置**，必须在渲染层过滤之前完成）：
 *   · `mode` 改为**三值原值直通**（primary / subagent / all）。渲染层的两条过滤规则
 *     「主模式 = mode !== 'subagent'」「子智能体名册 = mode !== 'primary'」都以原值为前提；
 *     此前把"非 primary 一律压成 subagent"，会让 `mode:'all'` 的 agent 从两侧清单里同时消失。
 *   · `hidden` 过滤**保留在本层**（渲染层不再重复过滤，避免两处判据漂移）。
 *   · 补齐 `model` / `color` / `steps` / `permissions`：L2 卡片显示模型、头像底色（§5.6）、
 *     R6 的权限提醒与 v1.1 的权限摘要都要用；不下传这些字段就必须再改一次主进程。
 */
function shapeAgentList(rawList, expectedSet) {
  const exp = expectedSet instanceof Set ? expectedSet : new Set(expectedSet || [])
  return (rawList || [])
    .filter((a) => a && a.id && a.hidden !== true)
    .map((a) => ({
      id: a.id,
      name: a.name || a.id,
      description: a.description || '',
      // 引擎的合法取值是 primary|subagent|all（v2-openapi Agent.Info）；未知值保守归 subagent
      mode: a.mode === 'primary' || a.mode === 'all' ? a.mode : 'subagent',
      model: a.model ? { providerID: a.model.providerID || '', modelID: a.model.id || a.model.modelID || '' } : null,
      color: typeof a.color === 'string' ? a.color : '',
      steps: Number.isInteger(a.steps) ? a.steps : null,
      permissions: Array.isArray(a.permissions) ? a.permissions : [],
      source: exp.has(a.id) ? 'custom' : 'builtin'
    }))
    .sort((x, y) => {
      if (x.source !== y.source) return x.source === 'custom' ? -1 : 1
      return x.id.localeCompare(y.id)
    })
}

/**
 * 同工作区的并发查询合并器：相同 key 的并发调用共享同一个 Promise。
 * @returns {{run:(key:string, fn:()=>Promise<any>)=>Promise<any>, size:()=>number}}
 */
function createCoalescer() {
  const inflight = new Map()
  return {
    run(key, fn) {
      if (!inflight.has(key)) {
        const p = Promise.resolve()
          .then(fn)
          .finally(() => inflight.delete(key))
        inflight.set(key, p)
      }
      return inflight.get(key)
    },
    size: () => inflight.size
  }
}

module.exports = { waitForAgentRegistry, shapeAgentList, createCoalescer, agentArray, DEFAULTS }
