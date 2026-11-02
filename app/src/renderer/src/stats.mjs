// 统计页渲染层纯函数（无 DOM / window 依赖，供 App.jsx 与 test-stats.cjs 共用）
export const RANGE_OPTIONS = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'year', label: '今年' },
  { key: 'all', label: '全部' }
]

const DAY = 86400000
const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

export function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US')
}

export function fmtTokenCompact(n) {
  const v = Number(n) || 0
  if (v >= 999950) return trimZero((v / 1e6).toFixed(1)) + 'M'
  if (v >= 1e3) return trimZero((v / 1e3).toFixed(1)) + 'k'
  return String(Math.round(v))
}

function trimZero(s) {
  return s.replace(/\.0$/, '')
}

export function fmtPct(n) {
  const v = Number(n)
  return Number.isFinite(v) ? v.toFixed(1) + '%' : '—'
}

export function fmtDuration(ms) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v < 0) return '—'
  if (v < 1000) return Math.round(v) + 'ms'
  if (v < 60000) return (v / 1000).toFixed(1) + 's'
  const m = Math.floor(v / 60000)
  const s = Math.round((v % 60000) / 1000)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export function fmtDateMD(date) {
  return typeof date === 'string' && date.length >= 10 ? date.slice(5) : '—'
}

// 字数对比用的参考书（按常见篇幅取整；只用于趣味换算，不承诺精确版本）
export const BOOKS = [
  { name: '诗经', chars: 30000 },
  { name: '酉阳杂俎', chars: 150000 },
  { name: '史记', chars: 500000 },
  { name: '西游记', chars: 800000 },
  { name: '资治通鉴', chars: 3000000 }
]

export function nearestBook(chars) {
  const v = Math.max(0, Number(chars) || 0)
  let best = BOOKS[0]
  for (const b of BOOKS) {
    if (Math.abs(b.chars - v) < Math.abs(best.chars - v)) best = b
  }
  return best
}

export function bookEquiv(chars) {
  const v = Math.max(0, Number(chars) || 0)
  if (!v) return ''
  const book = nearestBook(v)
  const ratio = v / book.chars
  return `约 ${ratio >= 0.1 ? ratio.toFixed(1) : ratio.toFixed(2)} 本《${book.name}》`
}

// 字数统一用「万字」：不足 1 万保留一位小数，其余取整（约数，向下取整避免夸大）
export function fmtCharsWan(chars) {
  const v = Math.max(0, Number(chars) || 0)
  const wan = v / 10000
  if (wan > 0 && wan < 1) return `${wan.toFixed(1)}万字`
  return `${fmtInt(Math.floor(wan))}万字`
}

// 统计页自动刷新边界：每小时的 :00 与 :30（本地时区）
export function nextHalfHourAt(now = Date.now()) {
  const d = new Date(now)
  d.setSeconds(0, 0)
  if (d.getMinutes() < 30) d.setMinutes(30)
  else d.setHours(d.getHours() + 1, 0, 0, 0)
  return d.getTime()
}

export function tokenTotal(tokens) {
  if (!tokens) return 0
  return (
    (Number(tokens.input) || 0) +
    (Number(tokens.output) || 0) +
    (Number(tokens.reasoning) || 0) +
    (Number(tokens.cacheRead) || 0) +
    (Number(tokens.cacheWrite) || 0)
  )
}

export function tokenSegments(tokens) {
  const total = tokenTotal(tokens)
  if (!total) return []
  const raw = [
    { key: 'input', label: '输入', value: Number(tokens.input) || 0 },
    { key: 'cache', label: '缓存读', value: Number(tokens.cacheRead) || 0 },
    { key: 'output', label: '输出', value: Number(tokens.output) || 0 },
    { key: 'reasoning', label: '推理', value: Number(tokens.reasoning) || 0 }
  ]
  if ((Number(tokens.cacheWrite) || 0) > 0) {
    raw.push({ key: 'cacheWrite', label: '缓存写', value: Number(tokens.cacheWrite) || 0 })
  }
  return raw.map((x) => ({ ...x, pct: (x.value / total) * 100 }))
}

export function cacheHitRate(tokens) {
  if (!tokens) return null
  const input = Number(tokens.input) || 0
  const cache = Number(tokens.cacheRead) || 0
  if (input + cache <= 0) return null
  return (cache / (input + cache)) * 100
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function parseDateKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null
  return dt
}

function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() + n)
  return x
}

export function currentStreak(activity, today = new Date()) {
  const active = new Set(
    (activity || [])
      .filter((x) => x && x.steps > 0 && parseDateKey(x.date))
      .map((x) => x.date)
  )
  const anchor = active.has(ymd(today)) ? today : addDays(today, -1)
  if (!active.has(ymd(anchor))) return 0
  let n = 0
  for (let d = anchor; active.has(ymd(d)); d = addDays(d, -1)) n++
  return n
}

function heatLevel(steps) {
  if (!steps) return 0
  if (steps < 25) return 1
  if (steps < 60) return 2
  if (steps < 120) return 3
  return 4
}

export function buildHeatmap(activity, weeks = 52, today = new Date()) {
  const byDate = new Map()
  for (const x of activity || []) {
    if (!x || !parseDateKey(x.date)) continue
    byDate.set(x.date, (byDate.get(x.date) || 0) + (Number(x.steps) || 0))
  }
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const dow = (end.getDay() + 6) % 7
  const lastMonday = addDays(end, -dow)
  const start = addDays(lastMonday, -(weeks - 1) * 7)
  const cells = []
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i)
    const date = ymd(d)
    const future = d > end
    const steps = future ? 0 : byDate.get(date) || 0
    cells.push({ date, steps, level: heatLevel(steps), future })
  }
  const months = []
  let lastKey = ''
  for (let w = 0; w < weeks; w++) {
    const d = addDays(start, w * 7)
    const key = d.getFullYear() + '-' + d.getMonth()
    if (key !== lastKey) {
      months.push({ label: MONTH_LABELS[d.getMonth()], start: w, span: 1 })
      lastKey = key
    } else {
      months[months.length - 1].span++
    }
  }
  return { weeks, cells, months }
}

export function percentShares(values) {
  const nums = (values || []).map((v) => Math.max(0, Number(v) || 0))
  const total = nums.reduce((a, b) => a + b, 0)
  if (!total) return nums.map(() => 0)
  const raw = nums.map((v) => (v / total) * 100)
  const rounded = raw.map((v) => Math.round(v * 10) / 10)
  const sum = rounded.reduce((a, b) => a + b, 0)
  const last = rounded.length - 1
  if (last >= 0) rounded[last] = Math.max(0, Math.round((rounded[last] + (100 - sum)) * 10) / 10)
  return rounded
}

export function topTools(tools, n = 6) {
  if (!tools || tools.mode !== 'detail' || !Array.isArray(tools.usage)) {
    return { rows: [], rest: 0 }
  }
  const rows = tools.usage.slice(0, n)
  const calls = tools.totals ? Number(tools.totals.calls) || 0 : rows.reduce((a, x) => a + (Number(x.calls) || 0), 0)
  return { rows, rest: Math.max(0, calls - rows.reduce((a, x) => a + (Number(x.calls) || 0), 0)) }
}

const PERSONAS = [
  { test: (s) => s.bash >= 30, name: '命令狂魔', desc: (s) => `bash 占全部工具调用的 ${Math.round(s.bash)}%。` },
  { test: (s) => s.files >= 50, name: '文件管家', desc: (s) => `读取与编辑占 ${Math.round(s.files)}%，文件是主战场。` },
  { test: (s) => s.search >= 25, name: '搜索侦探', desc: (s) => `grep/glob 占 ${Math.round(s.search)}%，先找再动手。` },
  { test: (s) => s.web >= 15, name: '网上冲浪', desc: (s) => `联网搜索/抓取占 ${Math.round(s.web)}%。` },
  { test: (s) => s.agent >= 10, name: '甩手掌柜', desc: (s) => `子智能体占 ${Math.round(s.agent)}%，会叫人。` }
]

export function pickPersona(tools) {
  if (!tools || tools.mode !== 'detail' || !tools.totals || !(tools.totals.calls > 0)) return null
  const calls = tools.totals.calls
  const by = (names) =>
    (tools.usage || []).filter((x) => names.includes(x.name)).reduce((a, x) => a + (Number(x.calls) || 0), 0)
  const shares = {
    bash: (by(['bash', 'shell']) / calls) * 100,
    files: (by(['read', 'edit', 'write']) / calls) * 100,
    search: (by(['grep', 'glob']) / calls) * 100,
    web: (by(['websearch', 'webfetch']) / calls) * 100,
    agent: (by(['subagent', 'task']) / calls) * 100
  }
  const found = PERSONAS.find((p) => p.test(shares))
  if (!found) return { name: '全能选手', desc: '工具用得比较均衡，没有明显偏科。' }
  return { name: found.name, desc: found.desc(shares) }
}
