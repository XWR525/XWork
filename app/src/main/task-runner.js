// 任务执行器：任务引擎（独立进程）生命周期、固定会话复用、执行流水线、结果持久化、系统通知
// 依赖：electron 运行时（engine/bridge/settings），由 index.js 组装并注入依赖
const fs = require('node:fs')
const path = require('node:path')
const { Engine, healthCheck } = require('./engine')
const { Bridge } = require('./bridge')
const { applyToOpencode } = require('./settings')
const { HISTORY_LIMIT } = require('./tasks')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 占位符渲染：{{date}} / {{date:-1d}} / {{date:+7d}}（按任务执行时刻的本地日期）
function renderPlaceholders(text, now = new Date()) {
  return String(text || '').replace(/\{\{\s*date\s*([+-]\d+d)?\s*\}\}/g, (_m, off) => {
    const d = new Date(now)
    if (off) d.setDate(d.getDate() + parseInt(off, 10))
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  })
}

// 任务执行错误：携带原因码（IPC 返回给渲染层提示）
class TaskExecutionError extends Error {
  constructor(message, reason) {
    super(message)
    this.reason = reason || 'unknown'
  }
}

// 单个任务的单次执行上下文（保障事件分派/超时/完成回调隔离）
class TaskRun {
  constructor(runner, task) {
    this.runner = runner
    this.task = task
    this.session = null // 固定会话（'task-<id>'）
    this.startedAt = Date.now()
    this.finished = false
    this.timer = null // 执行超时定时器
    this.autoAnswered = false // 执行中出现 question 被自动默认应答（§9：历史留痕「已默认应答」）
    this.result = null // 最终结果 { status, summary, durationMs, endedAt, error?, autoAnswered }
    this.waitResolve = null // 等待执行结束的 resolver（runTask 用）
  }

  // 统一收尾：构造结果对象并唤醒 runTask；持久化由 runTask 循环结束后统一执行（含重试次数）
  finish(status, summary) {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    const failed = status === 'failed' || status === 'timeout'
    this.result = {
      status, // completed | failed | timeout
      summary: summary || '',
      durationMs: Date.now() - this.startedAt,
      endedAt: Date.now(),
      error: failed ? summary || '' : undefined, // 失败/超时详情（历史条目用）
      autoAnswered: this.autoAnswered || false // question 默认应答留痕
    }
    if (this.runner.current === this) this.runner.current = null
    this.runner.scheduleRecycle()
    if (this.waitResolve) this.waitResolve(this.result)
  }
}

class TaskRunner {
  constructor({ store, notify, settings, effectiveConfig, ensureGit, mainXdgHome, onStatusChange }) {
    this.store = store // TaskStore
    this.notify = notify // (body) => void（系统通知）
    this.settings = settings // Settings 实例
    this.effectiveConfig = effectiveConfig // () => 有效配置（含 enginePort）
    this.ensureGit = ensureGit || (() => ({ ok: true })) // ensureWorkdirGit(dir, {init})
    this.mainXdgHome = mainXdgHome // 主引擎数据目录（任务引擎在其下建 tasks/ 子目录）
    this.onStatusChange = onStatusChange || null // 可选：任务状态变更回调（渲染层实时刷新用）

    this.taskEngine = null // 任务引擎进程实例
    this.taskBridge = null // 任务引擎 Bridge
    this.engineWorkspace = null // 任务引擎当前工作区（进程级 cwd，不同工作区必须重启）
    this.watchPromise = null // 任务引擎全局事件流
    this.current = null // 当前执行中的 TaskRun（全局串行，同一时间仅一个任务）
    this.recycleTimer = null // 空闲回收定时器（5 分钟无任务即停引擎）
  }

  // ---- 端口与引擎生命周期 ----

  // 动态端口：从主引擎端口 +1 起顺延探测，找到空闲端口
  async pickFreePort() {
    const base = this.effectiveConfig().enginePort
    for (let p = base + 1; p < base + 60; p++) {
      const h = await healthCheck(p, 500)
      if (!h || !h.healthy) return p
    }
    throw new TaskExecutionError('未找到空闲端口（主引擎端口 ' + base + ' 顺延 59 个均被占用）', 'no_port')
  }

  // 确保任务引擎在线：工作区与当前引擎一致且健康则复用，否则重启（进程级 cwd 随工作区变化必须重启）
  async ensureEngine(workspace) {
    if (this.taskEngine && this.engineWorkspace === workspace) {
      const s = await this.taskEngine.status()
      if (s.running) return
      // 进程已退出（onExit 已清理引用）→ 重新拉起
      this.taskEngine = null
      this.taskBridge = null
    }
    if (this.taskEngine) {
      await this.stopEngine()
    }
    // 工作区校验：不存在则失败（不启动引擎空转）
    if (!workspace || !fs.existsSync(workspace)) {
      throw new TaskExecutionError('任务工作区不存在: ' + workspace, 'no_workspace')
    }
    // git 保证：任务文件变更留有快照、可回退
    try {
      this.ensureGit(workspace, { init: true })
    } catch (e) {
      console.warn('[task-engine] git ensure failed:', e.message)
    }
    // 端口 + spawn（force 强制新进程，绝不复用端口上其他健康服务）
    const port = await this.pickFreePort()
    const xdgHome = path.join(this.mainXdgHome, 'tasks')
    const engine = new Engine({
      port,
      xdgHome,
      cwd: workspace,
      extraEnv: () => this.settings.env(), // 模型 API Key 环境变量
      onExit: (code) => this.onEngineExit(code)
    })
    await engine.start({ force: true })
    // 每次执行前重写配置：provider 最新 + 全部 allow（无人值守）
    applyToOpencode(path.join(xdgHome, 'config', 'opencode', 'opencode.json'), this.settings, { allPermissions: true })
    this.taskEngine = engine
    this.taskBridge = new Bridge(port)
    this.enginePort = port
    this.engineWorkspace = workspace
    // 订阅任务引擎全局事件流（执行完成/失败/question 应答）；SSE 断开（引擎停止/退出）时静默收尾
    this.watchPromise = this.taskBridge
      .watchGlobal((evt) => this.handleEvent(evt))
      .catch((e) => {
        console.warn('[task-engine] event stream ended:', e.message)
      })
    console.log('[task-engine] ready port=', port, 'workspace=', workspace)
  }

  async stopEngine() {
    clearTimeout(this.recycleTimer)
    this.recycleTimer = null
    if (this.taskEngine) {
      try {
        await this.taskEngine.stop()
      } catch (e) {
        console.warn('[task-engine] stop failed:', e.message)
      }
    }
    this.taskEngine = null
    this.taskBridge = null
    this.engineWorkspace = null
    this.enginePort = null
    this.watchPromise = null
  }

  // 引擎意外退出：执行中任务标记 failed（附退出码），不自动重试
  onEngineExit(code) {
    console.log('[task-engine] exited code=', code)
    this.taskEngine = null
    this.taskBridge = null
    this.engineWorkspace = null
    this.enginePort = null
    if (this.current) {
      this.current.finish('failed', '任务引擎意外退出（退出码 ' + code + '）')
    }
  }

  // 空闲 5 分钟无任务：停止引擎释放资源（空闲 = 当前无执行中任务）
  scheduleRecycle() {
    clearTimeout(this.recycleTimer)
    this.recycleTimer = setTimeout(() => {
      if (this.current) return // 有任务执行中不回收
      this.stopEngine()
    }, 5 * 60 * 1000)
  }

  // ---- 事件处理 ----

  handleEvent(evt) {
    const run = this.current
    if (!run) return
    const sid = evt.properties?.sessionID
    if (!run.session || sid !== run.session.id) return
    if (evt.type === 'session.idle') {
      this.onSessionIdle(run)
    } else if (evt.type === 'session.error') {
      const err = evt.properties?.error
      this.onSessionError(run, (err && err.message) || err || '执行失败')
    } else if (evt.type === 'question.asked') {
      this.answerQuestions(run, evt.properties)
    }
  }

  onSessionIdle(run) {
    if (run.finished) return
    this.summaryOf(run).then((summary) => run.finish('completed', summary))
  }

  onSessionError(run, err) {
    if (run.finished) return
    run.finish('failed', String(err).slice(0, 300))
  }

  // 取会话最新 assistant 文本作为结果摘要（截断到 200 字）
  async summaryOf(run) {
    try {
      const msgs = await this.taskBridge.getMessages(run.session.id)
      for (const m of [...msgs].reverse()) {
        if (m.info?.role === 'assistant') {
          const text = (m.parts || [])
            .filter((p) => p.type === 'text')
            .map((p) => p.text || '')
            .join('')
            .trim()
          if (text) return text.slice(0, 200)
        }
      }
    } catch {
      /* 取不到摘要时回退固定文案 */
    }
    return '任务已完成'
  }

  // question 自动应答：选第一项作为默认回答；独立 60s 短超时，失败按失败处理并 abort
  async answerQuestions(run, props) {
    const reqId = props.requestID
    const questions = props.questions || []
    const answers = questions.map((q) => (q.options && q.options.length ? q.options[0] : ''))
    if (!reqId) {
      this.onSessionError(run, '提问应答失败（缺少 requestID）')
      return
    }
    try {
      const ok = await Promise.race([
        this.taskBridge.answerQuestion(reqId, answers),
        sleep(60 * 1000).then(() => false)
      ])
      if (!ok) throw new Error('应答接口超时或失败')
      // §9 留痕：question 已自动默认应答，标记到 run，持久化时写入历史条目（UI 展示「已默认应答」）
      run.autoAnswered = true
    } catch (e) {
      this.abort(run)
      this.onSessionError(run, '提问自动应答失败: ' + e.message)
    }
  }

  async abort(run) {
    try {
      if (this.taskBridge && run.session) await this.taskBridge.abortMessage(run.session.id)
    } catch {
      /* 引擎可能已退出 */
    }
  }

  // ---- 会话管理 ----

  // 固定会话：会话 id 持久化在任务.sessionID（引擎分配），跨次执行累积上下文；
  // 会话被删后重建并更新映射
  async ensureSession(task) {
    // 已映射且仍存在 → 复用
    if (task.sessionID) {
      try {
        const sessions = await this.taskBridge.listSessions()
        const list = Array.isArray(sessions) ? sessions : sessions.sessions || []
        const found = list.some((s) => s.id === task.sessionID)
        if (found) return { id: task.sessionID }
      } catch {
        /* 列表查询失败则尝试重建 */
      }
    }
    // 不存在 → 创建并以任务名作为标题
    const created = await this.taskBridge.createSession('task-' + task.id, null)
    const sid = created.id
    task.sessionID = sid
    const saved = this.store.get(task.id)
    if (saved) this.store.upsert({ ...saved, sessionID: sid })
    return { id: sid }
  }

  // 上下文收敛：消息量超阈值自动 compact（保留近期内容、历史总结为摘要）
  async maybeCompact(sid) {
    try {
      const msgs = await this.taskBridge.getMessages(sid)
      const textCount = msgs.length
      if (textCount < 40) return
      console.log('[task-engine] compact session', sid, 'messages=', textCount)
      await this.taskBridge.compactSession(sid, this.current?.task.model)
      await sleep(3000) // compact 异步执行，等待事件流推进
    } catch {
      /* compact 失败不阻断执行（上下文继续累积） */
    }
  }

  // ---- 执行流水线 ----

  // 执行任务（调度器 onFire 回调）：串行、带重试、结果持久化 + 通知
  // 历史只记录最终结果一次（含实际尝试次数），中间失败重试不单独落历史
  async runTask(task, { force = false } = {}) {
    if (this.current) return { ok: false, reason: 'busy' }
    let result = null
    let attempts = 1 // 实际尝试次数（首次 + 最终结果确定前失败的重试）
    const maxAttempts = Math.max(0, task.retries || 0) + 1 // 首次 + 重试次数
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        console.log('[task-run] retry', task.id, 'attempt', attempt)
        await sleep(attempt * 5000) // 退避重试
      }
      result = await this.executeOnce(task)
      attempts = attempt
      if (result.status !== 'failed') break
    }
    this.persistResult(task, result, { attempts })
    this.notifyResult(task, result)
    this.onStatusChange?.(task.id, result)
    return { ok: result.status === 'completed', result }
  }

  // 单次执行：发送消息 + 等待事件完成；按任务超时 abort
  async executeOnce(task) {
    const run = new TaskRun(this, task)
    this.current = run
    // 执行超时定时器
    run.timer = setTimeout(() => {
      this.abort(run)
      run.finish('timeout', '执行超时（' + Math.round(task.timeoutMs / 60000) + ' 分钟）')
    }, task.timeoutMs)
    try {
      await this.ensureEngine(task.workspace)
      run.session = await this.ensureSession(task)
      await this.maybeCompact(run.session.id)
      const prompt = renderPlaceholders(task.prompt)
      await this.taskBridge.sendMessage(run.session.id, prompt, task.model, task.agent)
      // 发送成功，等待事件流判定完成/失败/超时
      return await new Promise((resolve) => { run.waitResolve = resolve })
    } catch (e) {
      if (!run.finished) {
        run.finish('failed', (e && e.message) || String(e))
      }
      return run.result || { status: 'failed', summary: String(e), durationMs: Date.now() - run.startedAt, endedAt: Date.now() }
    }
  }

  // 立即执行某任务（UI「立即执行」按钮）：绕过调度器 wait，强制入队
  async runNow(task) {
    if (this.current) return { ok: false, reason: 'busy' }
    return this.runTask(task, { force: true })
  }

  // 判断某任务是否正在执行（定时与立即执行共用 current 锁；渲染层 _running 依据）
  isCurrent(id) {
    return !!(this.current && this.current.task.id === id)
  }

  // 持久化任务执行结果到存储：更新 lastResult/lastRunAt，并追加一条历史记录（上限 HISTORY_LIMIT，超出滚动丢最旧）
  persistResult(task, result, opts = {}) {
    const t = this.store.get(task.id)
    if (!t) return
    t.lastRunAt = result.endedAt || Date.now()
    t.lastResult = {
      status: result.status,
      summary: result.summary || '',
      durationMs: result.durationMs || 0,
      endedAt: result.endedAt || null
    }
    t.nextRunAt = null // 下次执行时间在下次命中时重新计算
    t.history = t.history || []
    t.history.push({
      runAt: t.lastRunAt,
      status: result.status,
      summary: result.summary || '',
      durationMs: result.durationMs || 0,
      error: result.error || null, // 失败/超时详情
      attempts: Number.isInteger(opts.attempts) ? opts.attempts : 1, // 实际尝试次数（含重试）
      autoAnswered: !!result.autoAnswered // question 默认应答留痕（§9）
    })
    if (t.history.length > HISTORY_LIMIT) t.history.splice(0, t.history.length - HISTORY_LIMIT)
    this.store.upsert(t)
  }

  // 系统通知（仅窗口不在前台时由 index.js 的 notify 决策，这里直接调用）
  notifyResult(task, result) {
    const ok = result.status === 'completed'
    const prefix = ok ? '✅' : result.status === 'timeout' ? '⏱' : '❌'
    const statusText = { completed: '已完成', failed: '执行失败', timeout: '执行超时' }[result.status] || result.status
    const summary = result.summary ? '\n' + String(result.summary).slice(0, 120) : ''
    this.notify(`定时任务「${task.name}」${statusText}${summary}`)
  }

  // 删除任务的固定会话（删除任务时清理孤儿会话）
  async deleteTaskSession(task) {
    if (!this.taskBridge) return
    if (!task.sessionID) return
    try {
      await this.taskBridge.deleteSession(task.sessionID)
    } catch {
      /* 会话可能不存在 */
    }
  }

  // 应用退出清理
  async dispose() {
    clearTimeout(this.recycleTimer)
    this.recycleTimer = null
    this.current = null
    await this.stopEngine()
  }
}

module.exports = { TaskRunner, renderPlaceholders, TaskExecutionError }