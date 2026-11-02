// 统计页纯函数：区间、引擎 stats 归一化、基础模式聚合、错误分类
// ⚠ 本文件不依赖 electron / fs / bridge，供 index.js 与 test-stats.cjs 共用。
const RANGE_KEYS = ['7d', '30d', 'year', 'all']
const DAY = 86400000
const TOOL_USAGE_LIMIT = 200
const MODEL_LIMIT = 12

function isRange(v) {
  return RANGE_KEYS.includes(v)
}

function rangeToBounds(range, now = Date.now()) {
  const end = new Date(now)
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (range === '7d') start.setDate(start.getDate() - 6)
  else if (range === '30d') start.setDate(start.getDate() - 29)
  else if (range === 'year') start.setMonth(0, 1)
  else return { from: undefined, to: end.getTime() }
  // 极端：1 月 1 日 00:00:00.000 的「今年」会 from === to；引擎会拒绝 >=
  const from = Math.min(start.getTime(), end.getTime() - 1)
  return { from, to: end.getTime() }
}

function heatmapBounds(now = Date.now()) {
  const end = new Date(now)
  const monday = new Date(now)
  const dow = (monday.getDay() + 6) % 7 // Monday=0
  monday.setDate(monday.getDate() - dow)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - 51 * 7)
  return { from: monday.getTime(), to: end.getTime() }
}

function systemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function normalizeTokens(raw) {
  const t = raw && typeof raw === 'object' ? raw : {}
  const cache = t.cache && typeof t.cache === 'object' ? t.cache : {}
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write)
  }
}

function tokenTotal(tokens) {
  return (
    num(tokens && tokens.input) +
    num(tokens && tokens.output) +
    num(tokens && tokens.reasoning) +
    num(tokens && tokens.cacheRead) +
    num(tokens && tokens.cacheWrite)
  )
}

function normalizeToolTotals(raw) {
  return {
    calls: num(raw && raw.calls),
    succeeded: num(raw && raw.succeeded),
    failed: num(raw && raw.failed),
    unfinished: num(raw && raw.unfinished)
  }
}

function normalizeTools(raw) {
  const mode = raw && ['none', 'summary', 'detail'].includes(raw.mode) ? raw.mode : 'none'
  const usage = Array.isArray(raw && raw.usage)
    ? raw.usage
        .filter((x) => x && typeof x.name === 'string' && x.name)
        .map((x) => ({
          name: x.name,
          calls: num(x.calls),
          succeeded: num(x.succeeded),
          failed: num(x.failed),
          unfinished: num(x.unfinished),
          durationP50: Number.isFinite(Number(x.durationP50)) && Number(x.durationP50) >= 0 ? Number(x.durationP50) : null
        }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, TOOL_USAGE_LIMIT)
    : []
  let totals = normalizeToolTotals(raw && raw.totals)
  if (!raw || !raw.totals) {
    totals = usage.reduce(
      (acc, x) => ({
        calls: acc.calls + x.calls,
        succeeded: acc.succeeded + x.succeeded,
        failed: acc.failed + x.failed,
        unfinished: acc.unfinished + x.unfinished
      }),
      { calls: 0, succeeded: 0, failed: 0, unfinished: 0 }
    )
  }
  return { mode, totals, usage: mode === 'detail' ? usage : [] }
}

function isValidDateKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

function normalizeActivity(raw) {
  if (!Array.isArray(raw)) return []
  const map = new Map()
  for (const x of raw) {
    if (!x || !isValidDateKey(x.date)) continue
    map.set(x.date, (map.get(x.date) || 0) + num(x.steps))
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, steps]) => ({ date, steps }))
}

function tokenObjectTotal(tokens) {
  if (typeof tokens === 'number') return num(tokens)
  return tokenTotal(normalizeTokens(tokens))
}

function normalizeModels(raw) {
  const src = Array.isArray(raw) ? raw : []
  const map = new Map()
  for (const m of src) {
    const model = (m && m.model) || m || {}
    const providerID = String(model.providerID || '')
    const id = String(model.id || model.modelID || '')
    if (!id) continue
    const key = providerID + '/' + id
    const prev = map.get(key) || { providerID, id, steps: 0, tokens: 0, cost: 0 }
    prev.steps += num(m && m.steps)
    prev.tokens += tokenObjectTotal(m && m.tokens)
    prev.cost += num(m && m.cost)
    map.set(key, prev)
  }
  const all = [...map.values()]
  const modelsTotal = all.reduce(
    (acc, m) => ({ steps: acc.steps + m.steps, tokens: acc.tokens + m.tokens }),
    { steps: 0, tokens: 0 }
  )
  const models = all
    .sort((a, b) => b.steps - a.steps || b.tokens - a.tokens)
    .slice(0, MODEL_LIMIT)
    .map((m) => ({ providerID: m.providerID, id: m.id, steps: m.steps, tokens: m.tokens, cost: m.cost }))
  return { models, modelsTotal }
}

function normalizeStats(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const tools = normalizeTools(r.tools)
  const { models, modelsTotal } = normalizeModels(r.models)
  return {
    sessions: num(r.sessions),
    subagents: num(r.subagents),
    prompts: num(r.prompts),
    steps: num(r.steps),
    tokens: normalizeTokens(r.tokens),
    tools,
    activeDays: num(r.activeDays),
    streak: num(r.streak),
    activity: normalizeActivity(r.activity),
    models,
    modelsTotal
  }
}

function normalizeHeatmap(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    activeDays: num(r.activeDays),
    streak: num(r.streak),
    activity: normalizeActivity(r.activity)
  }
}

function basicStatsFromSessions(rows) {
  const list = Array.isArray(rows) ? rows : []
  let sessions = 0
  let subagents = 0
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    if (s.parentID) subagents++
    else sessions++
    const t = normalizeTokens(s.tokens)
    tokens.input += t.input
    tokens.output += t.output
    tokens.reasoning += t.reasoning
    tokens.cacheRead += t.cacheRead
    tokens.cacheWrite += t.cacheWrite
  }
  return {
    sessions,
    subagents,
    prompts: 0,
    steps: 0,
    tokens,
    tools: { mode: 'none', totals: { calls: 0, succeeded: 0, failed: 0, unfinished: 0 }, usage: [] },
    activeDays: 0,
    streak: 0,
    activity: [],
    models: [],
    modelsTotal: { steps: 0, tokens: 0 }
  }
}

function isNotFound(e) {
  if (!e) return false
  if (e.status === 404 || e.status === 405) return true
  return /\b(404|405)\b/.test(String(e.message || ''))
}

function classifyStatsError(e) {
  if (!e) return 'error'
  if (e.code === 'ETIMEDOUT' || e.timeout || e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout'
  const msg = String(e.message || '')
  if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'ECONNRESET' || /ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET/i.test(msg)) {
    return 'engine_off'
  }
  return 'error'
}

module.exports = {
  RANGE_KEYS,
  DAY,
  isRange,
  rangeToBounds,
  heatmapBounds,
  systemTimezone,
  normalizeTokens,
  tokenTotal,
  normalizeStats,
  normalizeHeatmap,
  basicStatsFromSessions,
  isNotFound,
  classifyStatsError,
  isValidDateKey
}
