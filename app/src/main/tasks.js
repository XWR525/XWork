// 定时任务核心模块：cron 解析/时间计算、任务存储、调度器
// 依赖：无外部依赖（Node 内置），可独立验证
// 存储文件：xwork-tasks.json（与 xwork-settings.json 同级，由外部传入路径）
const fs = require('node:fs')
const path = require('node:path')

// ============ cron 解析与时间计算 ============
// 5 字段：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6，周日=0)
// 支持语法：* / 数字 / 逗号列表 / 步进 */N（每 N 小时模板依赖步进，属必要扩展）
// 不支持的语法（设计取舍）：区间 1-5、混合步进 1-10/2 等复杂写法
// 任务历史保留上限（条/任务）：超出滚动丢弃最旧，防止 xwork-tasks.json 无限膨胀
const HISTORY_LIMIT = 100
const CRON_FIELDS = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 6 } // 周日=0（与本地 getDay() 一致）
]

// 解析单字段：* / 数字 / 逗号列表 / */N → 返回有序数字数组；* 返回 null（匹配任意）
function parseField(spec, field) {
  if (spec === '*') return null
  if (/^\*\/\d+$/.test(spec)) {
    const step = Number(spec.slice(2))
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`cron 字段「${field.name}」步进值非法: ${spec}`)
    }
    const set = []
    for (let v = field.min; v <= field.max; v += step) set.push(v)
    return set
  }
  const set = new Set()
  for (const part of String(spec).split(',')) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < field.min || n > field.max) {
      throw new Error(`cron 字段「${field.name}」取值非法: ${part}`)
    }
    set.add(n)
  }
  return [...set].sort((a, b) => a - b)
}

// 解析完整 cron 表达式 → 5 元素数组（数字数组或 null）；@startup 为应用启动时特殊标记
function parseCron(expr) {
  if (expr === '@startup') return null
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron 表达式必须为 5 段（分 时 日 月 周），收到 ${parts.length} 段: ${expr}`)
  }
  return parts.map((p, i) => parseField(p, CRON_FIELDS[i]))
}

// 校验 cron 表达式是否合法（UI/IPC 调用）
function isValidCron(expr) {
  if (expr === '@startup') return true
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

// 某本地时刻是否命中 cron：分/时/月 必须匹配；日与周按标准 cron 语义——两者都指定时任一匹配（OR），
// 仅一方指定时按指定方匹配，都通配才算命中任意一天
function matchCronAt(expr, date) {
  const fields = parseCron(expr)
  if (!fields) return false // @startup 不走时钟匹配
  const [mins, hours, days, months, weeks] = fields
  const m = date.getMinutes()
  const h = date.getHours()
  const d = date.getDate()
  const mo = date.getMonth() + 1
  const w = date.getDay()
  if (mins && !mins.includes(m)) return false
  if (hours && !hours.includes(h)) return false
  if (months && !months.includes(mo)) return false
  if (days && weeks) return days.includes(d) || weeks.includes(w)
  if (days) return days.includes(d)
  if (weeks) return weeks.includes(w)
  return true
}

// 计算下一个命中时刻（本地时区，从 from 的下一分钟起逐分钟推进，上限 5 年防死循环）
function nextRunAfter(expr, from = new Date()) {
  const fields = parseCron(expr)
  if (!fields) throw new Error('@startup 没有可计算的下一执行时刻')
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1) // 从下一分钟开始找
  const deadline = d.getTime() + 5 * 366 * 24 * 60 * 60 * 1000
  while (d.getTime() <= deadline) {
    if (matchCronAt(expr, d)) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  return null // 5 年内无命中（极端情况，正常配置不会发生）
}

// cron 人话描述（UI 列表展示「下次执行时间」用）；无法识别的回退为原表达式
function describeCron(expr) {
  if (expr === '@startup') return '应用启动时'
  let fields
  try {
    fields = parseCron(expr)
  } catch {
    return '无效计划'
  }
  const hour = fields[1] ? fields[1][0] : 0
  const min = fields[0] ? fields[0][0] : 0
  const week = fields[4]
  const day = fields[3]
  const time = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`
  const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  // 每 N 小时模板（分钟为 0 步进：0 0 */N 或分钟固定 0 时小时步进）
  const hourStep = expr.match(/0 (\*\/\d+) \* \* \*/)
  if (hourStep) {
    const n = Number(hourStep[1].slice(2))
    return `每 ${n} 小时整点`
  }
  // 每天 HH:MM：0 9 * * *（日/月/周均通配）
  if (fields[0] && fields[1] && !fields[2] && !fields[3] && !fields[4]) {
    if (fields[0].length === 1 && fields[1].length === 1) return `每天 ${time}`
  }
  // 每周 W 天 HH:MM：0 9 * * 1（日、月通配，周指定单值）
  if (week && week.length === 1 && !fields[2] && !fields[3]) {
    return `每周${weekNames[week[0]]} ${time}`
  }
  return expr
}

// ============ 任务数据模型 ============

// 任务默认值（设计文档 §5.1）：超时默认 30 分钟、重试默认 2 次、固定 build 模式
const DEFAULT_TASK = {
  agent: 'build',
  enabled: true,
  timeoutMs: 30 * 60 * 1000,
  retries: 2,
  lastRunAt: null,
  nextRunAt: null,
  lastResult: null
}

function genTaskId() {
  return 'task-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// 归一化任务定义：补默认值、剔除未知字段，返回新对象（不修改入参）
function normalizeTask(raw, id) {
  return {
    id: raw.id || id || genTaskId(),
    name: String(raw.name || '').trim(),
    workspace: String(raw.workspace || ''),
    prompt: String(raw.prompt || ''),
    model: raw.model && raw.model.modelID ? { providerID: raw.model.providerID, modelID: raw.model.modelID } : null,
    agent: raw.agent === 'plan' ? 'plan' : DEFAULT_TASK.agent, // 定时任务固定 build（仅兼容旧数据）
    schedule: String(raw.schedule || ''),
    sessionID: raw.sessionID || null, // 固定会话 id（引擎分配，删除任务时同步清理）
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_TASK.enabled,
    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TASK.timeoutMs,
    retries: Number.isInteger(raw.retries) && raw.retries >= 0 ? raw.retries : DEFAULT_TASK.retries,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    lastRunAt: raw.lastRunAt || null,
    nextRunAt: raw.nextRunAt || null,
    lastResult: raw.lastResult && raw.lastResult.status
      ? {
          status: String(raw.lastResult.status),
          summary: String(raw.lastResult.summary || ''),
          durationMs: Number.isFinite(raw.lastResult.durationMs) ? raw.lastResult.durationMs : 0,
          endedAt: raw.lastResult.endedAt || null
        }
      : null,
    // 执行历史（全量保留有上限：超出 HISTORY_LIMIT 滚动丢最旧；load 时兜底截断）
    history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_LIMIT) : []
  }
}

// ============ 任务存储（内存 cache + 整体写盘 + 损坏兜底） ============
class TaskStore {
  constructor(file) {
    this.file = file
    this.cache = null
  }

  load() {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.cache = {
        version: 1,
        tasks: Array.isArray(raw.tasks) ? raw.tasks.map((t) => normalizeTask(t)) : []
      }
    } catch {
      this.cache = { version: 1, tasks: [] } // 文件不存在或损坏 → 空结构
    }
    return this.cache
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2))
    return this.cache
  }

  list() {
    return this.load().tasks
  }

  get(id) {
    return this.load().tasks.find((t) => t.id === id) || null
  }

  upsert(task) {
    const data = this.load()
    const norm = normalizeTask(task)
    const i = data.tasks.findIndex((t) => t.id === norm.id)
    if (i >= 0) data.tasks[i] = norm
    else data.tasks.push(norm)
    this.save()
    return norm
  }

  remove(id) {
    const data = this.load()
    data.tasks = data.tasks.filter((t) => t.id !== id)
    this.save()
  }
}

// ============ 调度器 ============
// 每分钟 tick：整分对齐、时间跳变重算、命中触发 onFire（执行器接入）
class Scheduler {
  constructor(store, { onFire, now } = {}) {
    this.store = store
    this.onFire = onFire || null // 命中回调：由执行器接入，接收任务对象
    this.now = now || (() => Date.now()) // 可注入时间源（测试用）
    this.timer = null
    this.pendingTimer = null
    this.running = new Set() // 运行中任务 id（防重入，运行中命中则跳过本次）
  }

  // 启动调度：先对齐到下一个整分边界，之后每分钟 tick
  start() {
    if (this.timer) return
    const wait = 60000 - (this.now() % 60000)
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      this.tick()
      this.timer = setInterval(() => this.tick(), 60000)
    }, wait)
  }

  stop() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    if (this.timer) clearInterval(this.timer)
    this.pendingTimer = null
    this.timer = null
  }

  // 每分钟执行一次：对每个启用任务做命中判断，命中则触发 onFire
  async tick() {
    const d = new Date(this.now())
    let fired = 0
    for (const task of this.store.list()) {
      if (!task.enabled || this.running.has(task.id)) continue
      if (task.schedule === '@startup') continue // 启动时由 fireNow 触发，不走时钟
      if (!matchCronAt(task.schedule, d)) continue
      fired++
      this.running.add(task.id)
      // 先执行、后更新状态：onFire 返回 busy（已有任务在执行，本次命中未真正执行——
      // 立即执行 runNow 或定时任务互斥都会命中）或 discarded（入队后任务被删除/禁用，
      // 本次触发被丢弃）时不更新 lastRunAt/nextRunAt，避免任务被标记为已执行、下次时间被
      // 推后一个周期（实际未跑，静默漏跑），或把已删除的任务写回复活
      let ok = false
      try {
        const res = await this.onFire?.(task)
        ok = !res || (res.reason !== 'busy' && res.reason !== 'discarded')
      } catch {
        /* 执行器自身错误由执行器处理，调度器不中断 */
      }
      if (ok) {
        task.lastRunAt = d.getTime()
        task.nextRunAt = nextRunAfter(task.schedule, task.lastRunAt)
        this.store.upsert(task)
      }
    }
    return fired
  }

  // 应用启动时触发全部 @startup 任务（运行前提满足时由外部调用一次）
  async fireNow() {
    for (const task of this.store.list()) {
      if (!task.enabled || task.schedule !== '@startup' || this.running.has(task.id)) continue
      this.running.add(task.id)
      let ok = false
      try {
        const res = await this.onFire?.(task)
        ok = !res || (res.reason !== 'busy' && res.reason !== 'discarded')
      } catch {
        /* 同 tick */
      }
      if (ok) {
        task.lastRunAt = this.now()
        this.store.upsert(task)
      }
    }
  }

  // 外部登记运行锁（立即执行 runNow 时调用，防 tick 重复命中同一任务；执行完成后由 markDone 释放）
  markRunning(id) {
    this.running.add(id)
  }

  // 执行完成/失败后释放运行锁（由执行器调用）
  markDone(id) {
    this.running.delete(id)
  }

  isRunning(id) {
    return this.running.has(id)
  }

  // 计算任务下次执行时刻（UI 展示「下次执行时间」用；@startup 返回 -1 表示无固定时刻）
  computeNextRunAt(task, from = new Date(this.now())) {
    if (task.schedule === '@startup') return -1
    try {
      return nextRunAfter(task.schedule, from)
    } catch {
      return null
    }
  }
}

module.exports = {
  TaskStore,
  Scheduler,
  parseCron,
  isValidCron,
  matchCronAt,
  nextRunAfter,
  describeCron,
  genTaskId,
  normalizeTask,
  HISTORY_LIMIT
}