// opencode V2 HTTP API 桥：会话、消息（异步 prompt + 事件等待）、权限/提问应答、全局事件流归一化
//
// V2 与 V1 的核心差异（Phase 0 实测，详见 功能设计文档/迁移文档.md）：
// 1. 强制 HTTP Basic Auth（用户名 opencode，密码由 engine 注入 OPENCODE_SERVER_PASSWORD）
// 2. 发消息改为异步收件箱：POST /prompt 立即返回，完成靠事件（session.execution.*）
// 3. 事件封包扁平化：{type, data}，事件名全面改名 —— 本文件做归一化层，
//    对渲染层/任务引擎输出 V1 形状（{type, properties} + V1 事件名 + V1 消息结构），上层零改动
// 4. 消息列表为扁平判别条目（user/assistant/idle），此处整形回 V1 的 {info, parts}
const { DEFAULT_PORT } = require('./engine')

// V2 权限 action → XWork 存储键（与 settings.js 的 V2_ACTION_MAP 互逆；归一化 permission.asked 时使用，
// 渲染层权限档位配置仍以 V1 键名存取）
const ACTION_TO_KEY = {
  shell: 'bash',
  subagent: 'task',
  read: 'read',
  edit: 'edit',
  glob: 'glob',
  grep: 'grep',
  webfetch: 'webfetch',
  websearch: 'websearch',
  external_directory: 'external_directory',
  question: 'question'
}

// 等待首个 step 完成的兜底上限（V1 同步 POST 无超时；此处防御 SSE 断连/事件丢失导致的永久挂起）
const FIRST_STEP_TIMEOUT_MS = 600_000

// 分页页数上限（仅防御 cursor 不前进导致的死循环；正常情况下由 cursor.next=null 自然结束）
// 100 条/页：消息 100 页 = 10000 条，会话列表 20 页 = 2000 个
const MAX_MESSAGE_PAGES = 100
const MAX_SESSION_PAGES = 20

// location 查询参数编码（openapi 声明为 style=deepObject + explode=true）。
// 三个坑（实测，详见 功能设计文档/agents目录junction桥接设计.md §5.6 与 J11/J18）：
//   ① 不带 location → 引擎解析「引擎进程启动目录」的注册表。XWork 的 workspace:switch 是【不换进程】热切换，
//      所以工作区切换后不带参数的查询会拿到【上一个工作区】的数据（假告警，同名条目还会假通过）；
//   ② 写成 `location.directory=`（点号）→ 引擎【静默忽略】并回落到启动目录，仍返回 200（最难发现的形态）；
//   ③ `?location=` 单值 → 400。故必须保留中括号，值用 encodeURIComponent。
function locationQuery(directory) {
  return 'location[directory]=' + encodeURIComponent(directory)
}

// locationReload 的本地超时：_reqRaw 是【共用底座】（长耗时端点如 session.prompt 也在用），
// 绝不能给它加全局 timeout，否则会截断正常对话。故超时只作用于这一次 reload 调用。
// 实测冷态 reload 可达 72.4 s、热态 378–666 ms（设计 §5.5 第 2 点 / J8′）
const RELOAD_TIMEOUT_MS = 90_000

// 工具输出 content[]（[{type:'text', text}]）→ 纯文本
function joinContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}

// 路径归一化（仅用于回显比对：大小写 + 分隔符 + 尾部分隔符差异）
function normDir(p) {
  return String(p || '')
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

// 工具错误载荷归一化（设计 §5.4(c)：引擎差异只在这一处收敛）
// 实测（T0-② 尖刺，2026-10-16，本机会话库）：
//   · 快照路径 state 的键恰为 status/input/error（【无 content、无 metadata】）
//   · state.error 恒为对象 { type, message }，type ∈ permission.rejected / tool.execution / unknown / aborted
//   · 取消/中断有结构化判据 error.type === 'aborted'（文案形如 "Tool execution interrupted: shell"）
// 事件路径（session.tool.error）的 d.error 尚无样本 ⇒ 对象取 message、字符串原样、空回落。
// 与渲染层 subagentModel.normalizeToolError 同源规则；两侧不互相 require，以保持 main/renderer 依赖边界。
function normalizeToolErrorShape(err) {
  if (err === undefined || err === null || err === '') return { text: '', type: '', raw: null }
  if (typeof err === 'string') return { text: err, type: '', raw: null }
  return { text: String(err.message || err.error || ''), type: String(err.type || ''), raw: err }
}

/**
 * location 回显断言（设计 §5.6 / 评审 M-13）。
 * 三个端点（/api/agent、/api/command、/api/config）的响应体自带 `location.directory`，
 * 这是"本次查询确实针对目标工作区"的**唯一直接证据**。
 * 为什么必须有它：参数写成点号形态时引擎【静默回落】到启动目录并返回 200 —— 只校验"URL 带了 location"
 * 无法发现这种回归，自检会给出假通过。
 */
function ensureLocationEcho(json, expectDirectory, endpoint) {
  const got = json && json.location && json.location.directory
  if (!got) {
    const err = new Error(`${endpoint}: 响应缺少 location.directory，无法确认查询目标`)
    err.code = 'ELOCATIONNOECHO'
    throw err
  }
  if (normDir(got) !== normDir(expectDirectory)) {
    const err = new Error(`${endpoint}: location 回显不匹配（期望 ${expectDirectory}，实得 ${got}）—— 可能是 location 参数形态错误（点号会被静默忽略）`)
    err.code = 'ELOCATIONMISMATCH'
    throw err
  }
  return got
}

class Bridge {
  constructor(port = DEFAULT_PORT, { password = '' } = {}) {
    this.port = port
    this.base = `http://127.0.0.1:${port}`
    this.password = password
    this._sseConnected = false // watchGlobal 存活标记（sendMessage 等待策略据此选择事件等待或轮询兜底）
    this._waiters = [] // sendMessage 两段式等待器 {sessionID, resolve, timer, done}
    this._formMap = new Map() // formID → { sessionID, fieldKeys[] }（form.created 时登记，question 应答时换算）
    this._reasoning = new Map() // `${sessionID}:${messageID}:${ordinal}` → 已累积思考文本
    this._toolNames = new Map() // `${sessionID}:${callID}` → 工具名（input.started 登记，called 补齐）
    this._activeAsst = new Map() // sessionID → 最近 step 的 assistantMessageID
  }

  // ---- HTTP 基础 ----

  _headers(json = false) {
    const h = { Authorization: 'Basic ' + Buffer.from('opencode:' + this.password).toString('base64') }
    if (json) h['content-type'] = 'application/json'
    return h
  }

  // 底层请求：自动 Basic Auth + 204 → null；失败抛出带状态码与响应片段的错误。
  // 返回**完整响应信封**（不拆 {data}）——分页端点（/api/session、/api/session/{id}/message）
  // 的形状是 {data, cursor}，cursor 是分页游标：一旦被拆掉，分页就永远只能取到第一页
  // opts.timeoutMs：仅对本次调用生效的 AbortSignal 超时（默认不设，见 RELOAD_TIMEOUT_MS 的说明）
  async _reqRaw(method, p, body, opts = {}) {
    const { timeoutMs } = opts
    let res
    try {
      res = await fetch(this.base + p, {
        method,
        headers: this._headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
      })
    } catch (e) {
      // 超时必须与普通失败区分（调用方的降级策略不同：超时 = 结果未知，不能判定业务失败）
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        const err = new Error(`${method} ${p} timeout after ${timeoutMs}ms`)
        err.code = 'ETIMEDOUT'
        err.timeout = true
        throw err
      }
      throw e
    }
    if (res.status === 204) return null
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 300)
      } catch {
        /* ignore */
      }
      throw new Error(`${method} ${p} ${res.status}${detail ? ': ' + detail : ''}`)
    }
    return await res.json()
  }

  // 统一请求：自动 `{data}` 解包；非分页端点用这个，分页端点必须用 _reqRaw
  // opts.timeoutMs 透传给 _reqRaw；opts.expectDirectory 用于 location 回显断言（见 ensureLocationEcho）
  async _req(method, p, body, opts = {}) {
    const json = await this._reqRaw(method, p, body, opts)
    if (opts.expectDirectory !== undefined) ensureLocationEcho(json, opts.expectDirectory, p)
    return json && typeof json === 'object' && 'data' in json ? json.data : json
  }

  // ---- 会话 ----

  // 会话列表（V1 兼容：附带 directory 字段 = location.directory，供工作区登记/清理使用）
  // 分页：SessionsResponse = { data, cursor }，必须用 _reqRaw 保留 cursor 才能翻页
  // （旧实现用 _req 拆掉信封后读不到 cursor.next，超过 100 个会话时列表被静默截断）
  // 会话列表 + 「是否触达分页上限」的**局部**元数据（设计 §5.4(a) ③ / 评审 v3-M-3）。
  // 为什么返回对象而不是用实例字段承载 truncated：bridge 是单例，
  // session:list（渲染层高频刷新）与 workspace:list 会并发调用同一方法，
  // 实例级标志会被后完成的调用覆盖 ⇒ 可能用"下界"覆盖工作区计数（正是要修的那个 bug）。
  async listSessionsWithMeta() {
    const out = []
    let cursor = ''
    for (let page = 0; page < MAX_SESSION_PAGES; page++) {
      const p = '/api/session?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
      const env = await this._reqRaw('GET', p)
      const rows = Array.isArray(env?.data) ? env.data : []
      for (const s of rows) out.push({ ...s, directory: s.location?.directory || s.directory })
      cursor = env?.cursor?.next || ''
      if (!rows.length || !cursor) break
    }
    const truncated = !!cursor
    if (truncated) console.warn(`[bridge] listSessions 达到分页上限（${MAX_SESSION_PAGES} 页），更早的会话未列出`)
    return { rows: out, truncated }
  }

  // 兼容入口：返回形状不变（session:list IPC 直接把数组交给渲染层，改形状会波及所有调用点）
  async listSessions() {
    return (await this.listSessionsWithMeta()).rows
  }

  // 已加载的模型提供商列表（{location, data} 原样返回；渲染层模型下拉实际来自设置模型组，此接口为遗留保留）
  async getProviders() {
    return await this._req('GET', '/api/provider')
  }

  async deleteSession(sessionID) {
    await this._req('DELETE', `/api/session/${sessionID}`)
    return true
  }

  async renameSession(sessionID, title) {
    await this._req('PATCH', `/api/session/${sessionID}`, { title })
    return { id: sessionID, title }
  }

  // 创建会话：title 可选（不传则由引擎自动生成标题）；permissions 可选（V2 有序规则集）；
  // location 可选（V2 多目录：显式指定会话归属的工作区目录，不传则用引擎进程的启动目录）
  async createSession(title, permissions, location) {
    const body = {}
    if (title) body.title = title
    if (Array.isArray(permissions) && permissions.length) body.permissions = permissions
    if (location && typeof location === 'string') body.location = { directory: location }
    return await this._req('POST', '/api/session', body)
  }

  // ---- 消息（V2 异步收件箱模型） ----

  // 切换会话绑定模型（V2 模型绑定于会话；Model.Ref 用 id 字段，V1 叫 modelID）
  async switchModel(sessionID, model) {
    await this._req('POST', `/api/session/${sessionID}/model`, {
      model: { providerID: model.providerID, id: model.modelID }
    })
    return true
  }

  async switchAgent(sessionID, agent) {
    await this._req('POST', `/api/session/${sessionID}/agent`, { agent })
    return true
  }

  /**
   * 切换 agent 的**带信号**版本（设计 §5.5(b) / 评审 v2-B-4 的落点修正）。
   * 为什么必须由主进程返回信号：渲染层只拿到 messageSend 的最终消息，看不到 switchAgent 的失败，
   * 于是"用户显式选了一个不可用/无权限的智能体"会静默按引擎默认 agent 发送。
   * @returns {null | {agent:string, message:string}} 失败时返回结构化信号，成功返回 null
   */
  async _switchAgentSafe(sessionID, agent) {
    try {
      await this.switchAgent(sessionID, agent)
      return null
    } catch (e) {
      // 未知 agent 名不阻塞发送（V2 对 agent 校验更严），但必须把失败**带回去**给用户看
      console.warn('[bridge] switchAgent failed (reported to renderer):', e.message)
      return { agent, message: e.message }
    }
  }

  // 投递用户消息（立即返回收件箱回执，不等待模型回复）
  // 体形自适应：V2 各构建 prompt 体不同 —— opencode2 2.6+ 为扁平 {text}；
  // 1.18.x 的 V2 兼容层为嵌套 {prompt:{text}}（实测报错 Missing key at ["prompt"]）。
  // 首次调用探测并记住可用形态，后续直接使用。
  // skills：可选，显式附件技能列表（传 [] 用于尝试抑制引擎按提示词意图自动注入的 prompt-mode 技能，见 R11）
  async prompt(sessionID, text, skills) {
    const styles = this._promptStyle ? [this._promptStyle] : ['flat', 'nested']
    let lastErr = null
    for (const style of styles) {
      try {
        const body = style === 'flat' ? { text } : { prompt: { text } }
        if (Array.isArray(skills)) body.skills = skills
        const data = await this._req('POST', `/api/session/${sessionID}/prompt`, body)
        if (this._promptStyle !== style) {
          console.log('[bridge] prompt 体形确定为:', style)
          this._promptStyle = style
        }
        return data
      } catch (e) {
        lastErr = e
        // 仅「缺 prompt 键」类 400 才切换形态；其他错误（鉴权/会话不存在等）直接抛
        if (!/^POST .* 40[04]/.test(e.message) || !/prompt/i.test(e.message)) throw e
      }
    }
    throw lastErr
  }

  // 同步发送消息（V1 兼容入口）：确保模型/agent 绑定 → prompt → 等待首个 step 完成 → 返回该 assistant 消息（V1 形状）
  // 实时过程仍由全局事件流推送；多 turn 任务由 session.idle（归一化自 execution.succeeded）收尾
  async sendMessage(sessionID, text, model, agent) {
    if (model && model.providerID && model.modelID) await this.switchModel(sessionID, model)
    const agentSwitchFailed = agent ? await this._switchAgentSafe(sessionID, agent) : null
    await this.prompt(sessionID, text)
    // 等待首个 step 完成：优先事件等待（SSE 存活时），否则轮询兜底
    let asstID = null
    if (this._sseConnected) {
      asstID = await this._waitFirstStep(sessionID)
    } else {
      asstID = await this._pollFirstStep(sessionID)
    }
    // 拉取权威数据并返回目标 assistant 消息（V1 形状）
    // agent 切换失败信号只在失败时附加（成功路径的返回形状保持完全不变）
    const attach = (msg) => (agentSwitchFailed ? { ...msg, agentSwitchFailed } : msg)
    try {
      const msgs = await this.getMessages(sessionID)
      const assts = msgs.filter((m) => m.info.role === 'assistant')
      const hit = asstID ? assts.find((m) => m.info.id === asstID) : null
      if (hit) return attach(hit)
      if (assts.length) return attach(assts[assts.length - 1])
    } catch {
      /* 拉取失败则返回最小占位，避免上层 undefined 崩溃 */
    }
    return attach({
      info: { id: asstID || 'unknown', role: 'assistant', finish: 'error', error: { name: 'EngineError', message: '未获取到模型回复' } },
      parts: []
    })
  }

  // 事件等待：由 watchGlobal 的内部分发在首个「带 finish 的 message.updated / session.idle / session.error」时唤醒
  _waitFirstStep(sessionID) {
    return new Promise((resolve) => {
      const w = { sessionID, resolve, done: false, timer: null }
      w.timer = setTimeout(() => {
        if (w.done) return
        w.done = true
        console.warn('[bridge] waitFirstStep timeout (SSE)')
        resolve(this._activeAsst.get(sessionID) || null)
      }, FIRST_STEP_TIMEOUT_MS)
      this._waiters.push(w)
    })
  }

  // 轮询兜底（SSE 未连接场景）：等待出现「完成态」的新 assistant 消息
  async _pollFirstStep(sessionID) {
    const deadline = Date.now() + FIRST_STEP_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      try {
        const msgs = await this.getMessages(sessionID)
        const assts = msgs.filter((m) => m.info.role === 'assistant' && m.info.finish)
        if (assts.length) return assts[assts.length - 1].info.id
      } catch {
        /* 引擎可能仍在启动，继续轮询 */
      }
    }
    return null
  }

  // 内部分发：唤醒该会话的等待器（在 watchGlobal 归一化后调用）
  _notifyWaiters(type, props) {
    const finishes =
      type === 'session.idle' ||
      type === 'session.error' ||
      (type === 'message.updated' && props.info && props.info.finish)
    if (!finishes) return
    for (const w of this._waiters) {
      if (w.done || w.sessionID !== props.sessionID) continue
      w.done = true
      clearTimeout(w.timer)
      w.resolve(props.messageID || this._activeAsst.get(w.sessionID) || null)
    }
    this._waiters = this._waiters.filter((w) => !w.done)
  }

  // ---- 消息列表整形：V2 扁平条目 → V1 {info, parts} ----

  // 工具 part 的 state 整形（设计 §5.4(c) P11 + v3-B-3/v3-M-7）
  //   · 时间：引擎快照是 { created, ran, completed }（只有 created 必填），
  //     而消费端（ToolCard）读 { start, end } —— 此前两边对不上，导致所有工具卡都不显示时间。
  //     start 取 ran（执行开始；created 含模型生成工具参数的时间，长参数工具偏差可达秒级）
  //     end 取 completed ?? ran
  //   · 错误：按 normalizeToolErrorShape 归一化为字符串 error + errorType（取消判定）+ errorRaw
  _mapToolState(c) {
    const st = c.state || {}
    const state = {
      status: st.status || (c.executed ? 'completed' : 'pending'),
      input: st.input,
      output: joinContent(st.content),
      metadata: st.metadata,
      time: {
        start: c.time?.ran ?? c.time?.created,
        end: c.time?.completed ?? c.time?.ran
      }
    }
    if (st.error !== undefined && st.error !== null) {
      const e = normalizeToolErrorShape(st.error)
      state.error = e.text || '工具执行失败'
      state.errorType = e.type
      state.errorRaw = e.raw
    }
    return state
  }

  _mapMessageEntry(e) {
    if (!e || typeof e !== 'object') return null
    const created = e.time?.created
    if (e.type === 'user') {
      return {
        info: { id: e.id, role: 'user', time: { created }, sessionID: e.sessionID },
        parts: [{ id: e.id + '-text', type: 'text', text: e.text || '' }]
      }
    }
    if (e.type === 'assistant') {
      const info = {
        id: e.id,
        role: 'assistant',
        time: { created },
        finish: e.finish,
        agent: e.agent,
        providerID: e.model?.providerID,
        modelID: e.model?.id,
        tokens: e.tokens,
        cost: e.cost,
        sessionID: e.sessionID,
        // V2 条目级快照：start = 本轮编辑前 tree，end = 本轮编辑后 tree，files = 本轮变更文件
        // （V1 中快照挂在 part 上，此处为 V2 适配；undo 的 T_before 提取依赖它）
        snapshot: e.snapshot
      }
      if (e.error) info.error = { name: e.error.type || 'Error', message: e.error.message || '', data: e.error }
      const parts = (Array.isArray(e.content) ? e.content : []).map((c, i) => {
        if (c.type === 'text') return { id: c.id || `${e.id}-c${i}`, type: 'text', text: c.text || '' }
        if (c.type === 'reasoning') return { id: c.id || `${e.id}-r${i}`, type: 'reasoning', text: c.text || '' }
        if (c.type === 'tool') {
          return {
            id: c.id,
            callID: c.id,
            type: 'tool',
            tool: c.name,
            state: this._mapToolState(c)
          }
        }
        return { id: c.id || `${e.id}-c${i}`, type: c.type, text: c.text || '' }
      })
      return { info, parts }
    }
    // 压缩条目：V2 为独立顶层条目 {type:'compaction', status, reason, model, summary}，
    // V1 的渲染层靠「user 消息含 type='compaction' 的 part」显示「历史对话已压缩」标记
    // （实测确认：不映射会被当未知条目丢弃 → 压缩成功后 UI 无任何反馈）
    if (e.type === 'compaction') {
      return {
        info: { id: e.id, role: 'user', time: { created }, sessionID: e.sessionID, compaction: { status: e.status, reason: e.reason, summary: e.summary } },
        parts: [{ id: e.id + '-compaction', type: 'compaction', text: e.summary || '' }]
      }
    }
    // synthetic 消息（设计 §5.4(d) P12）：只映射 metadata.source === 'subagent' 的通知，
    // 其余一律丢弃（引擎内部通知不得灌进 UI，见 §5.4(d) 与"原生 type='system' 不映射"的约定）。
    // 实测（T0-③，2026-10-16）：synthetic 是 session_message 的一等条目（会出现在 GET /message 里），
    //   形如 { metadata:{ source, state, … }, time:{created}, text, description } —— 【没有顶层 sessionID】，
    //   故绑定目标只能取 metadata.childID；本次样本是 source='shell'（后台 shell 命令完成通知），
    //   subagent 走同一机制、键为 childID/agent/state（V10）。
    if (e.type === 'synthetic' && e.metadata && e.metadata.source === 'subagent') {
      const notice = {
        childID: e.metadata.childID || '',
        agent: e.metadata.agent || '',
        state: e.metadata.state || '', // completed | error | cancelled（V10；注意不是 failed）
        description: e.description || ''
      }
      return {
        info: { id: e.id, role: 'system', time: { created }, subagentNotice: notice },
        parts: [{ id: e.id + '-synthetic', type: 'synthetic', text: e.text || '', subagentNotice: notice }]
      }
    }
    return null // idle / model-switched / agent-switched / 其余 synthetic（含指令通知型 system）等非消息条目
  }

  async getMessages(sessionID) {
    // 升序分页拉全量。V2 契约（openapi SessionMessagesResponse）：{ data: [...], cursor: { previous, next } }
    // 两条必须遵守的规则（实测踩过，二者叠加会导致长会话只能回看到首页 100 条）：
    // ① cursor 在整个信封里，用 _req 拆 {data} 会把它丢掉 → 循环第一页就 break；
    // ② cursor 与 order 互斥，组合会 400 InvalidCursorError（"Cursor cannot be combined with order"），
    //    故仅首页带 order=asc，后续页只带 cursor（cursor 自身已编码排序方向）
    const entries = []
    let cursor = ''
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const p = cursor
        ? `/api/session/${sessionID}/message?limit=100&cursor=${encodeURIComponent(cursor)}`
        : `/api/session/${sessionID}/message?limit=100&order=asc`
      const env = await this._reqRaw('GET', p)
      const rows = Array.isArray(env?.data) ? env.data : []
      entries.push(...rows)
      cursor = env?.cursor?.next || ''
      if (!rows.length || !cursor) break
    }
    if (cursor) {
      console.warn(`[bridge] getMessages(${sessionID}) 达到分页上限（${MAX_MESSAGE_PAGES} 页），会话末尾仍有消息未加载`)
    }
    const out = []
    for (const e of entries) {
      const m = this._mapMessageEntry(e)
      if (m) out.push(m)
    }
    return out
  }

  async abortMessage(sessionID) {
    await this._req('POST', `/api/session/${sessionID}/interrupt`)
    return true
  }

  // 压缩会话：V2 为 POST /api/session/{id}/compact（无需指定模型，总结模型由引擎配置决定）
  // 异步执行，进度经全局事件流推送（session.idle 收尾）
  async compactSession(sessionID) {
    await this._req('POST', `/api/session/${sessionID}/compact`, {})
    return true
  }

  // ---- 配置热重载（V2 能力）----
  // POST /api/location/reload：让引擎重新读取配置（opencode.json / AGENTS.md 等），无需重启进程。
  // 实测（迁移文档 Phase 4-A）：新增/删除 provider 与模型、权限规则均即时生效；且**不会打断正在运行的任务**。
  //
  // ⚠ 三点实测约束（设计 §5.5 第 2 点 / J12 / J8′）：
  //   ① 它是**全局**动作：会清空并重建【所有已加载 location】的注册表（多实例会互相干扰）；
  //   ② 冷态可耗时 **72.4 s**（热态 378–666 ms），故必须带超时，否则会长时间阻塞 workspace:switch；
  //   ③ 客户端 abort **不能阻止**服务端清空：实测响应返回后约 2 s 注册表才被清空、约 4 s 恢复。
  //      因此"超时"只意味着**结果未知**（调用方不得据此判定业务失败，见 index.js 的降级处理）。
  async locationReload() {
    await this._req('POST', '/api/location/reload', {}, { timeoutMs: RELOAD_TIMEOUT_MS })
    return true
  }

  // 引擎当前已加载的配置文档清单（[{type:'document', path, info:<解析后的配置>}]）——用于热重载后校验生效。
  // directory 给定时按该 location 查询：热切换工作区后不带参数的查询会列出【上一个工作区】的配置根
  // （评审 M-5）——既有调用点（tryHotReload 只匹配全局 opencode.json）因为全局目录与 location 无关而未暴露该问题。
  async configEntries(directory) {
    const p = '/api/config' + (directory ? '?' + locationQuery(directory) : '')
    const data = await this._req('GET', p, undefined, directory ? { expectDirectory: directory } : {})
    return Array.isArray(data) ? data : []
  }

  // ---- 按 location 的只读查询（设计 §5.6；agents 桥接自检用）----
  // 必须带 location：否则永远返回「引擎进程启动目录」的注册表（J11/J18）
  async agents(directory) {
    return await this._req('GET', '/api/agent?' + locationQuery(directory), undefined, {
      expectDirectory: directory
    })
  }

  async commands(directory) {
    return await this._req('GET', '/api/command?' + locationQuery(directory), undefined, {
      expectDirectory: directory
    })
  }

  // 引擎信息（version/pid/urls）——pid 可用于确认引擎是否被重启过
  async info() {
    return await this._req('GET', '/api/info')
  }

  // ---- 回退（V2 三段式：stage → commit / clear）----
  // 注意 Phase 0 实测：stage/commit 能正确裁剪对话，但文件恢复未生效（files 恒空、工作区不变，R10），
  // 上层 undo 依赖的快照补偿逻辑在 Phase 2 重构；本方法仅保留引擎调用通路
  async revertStage(sessionID, messageID) {
    return await this._req('POST', `/api/session/${sessionID}/revert/stage`, { messageID, files: true })
  }

  async revertCommit(sessionID) {
    await this._req('POST', `/api/session/${sessionID}/revert/commit`)
    return true
  }

  async revertClear(sessionID) {
    await this._req('DELETE', `/api/session/${sessionID}/revert`)
    return true
  }

  // ---- 权限应答（V2 三值：once / always / reject）----

  async respondPermission(sessionID, permissionID, response) {
    try {
      await this._req('POST', `/api/session/${sessionID}/permission/${permissionID}/reply`, { decision: response })
    } catch (e) {
      console.error('[perm:respond] FAILED', e.message)
      return false
    }
    return true
  }

  // pending 权限列表（Phase 3「已保存授权/重连恢复」用；Phase 1 保留通路）
  async listPendingPermissions() {
    const data = await this._req('GET', '/api/permission/request')
    return Array.isArray(data) ? data : []
  }

  // ---- 提问（V2 form 体系；question 工具产生 metadata.kind='question' 的 form）----

  async answerQuestion(requestID, answers) {
    // requestID 即 formID；字段键与类型在 form.created 时登记于 _formMap
    let meta = this._formMap.get(requestID)
    if (!meta) {
      // 事件登记缺失（如桥刚启动错过 form.created）：从引擎 pending 列表补查
      try {
        const forms = await this.listPendingForms()
        const f = (Array.isArray(forms) ? forms : []).find((x) => x.id === requestID)
        if (f) {
          meta = { sessionID: f.sessionID, fields: (f.fields || []).map((x) => ({ key: x.key, type: x.type })) }
          this._formMap.set(requestID, meta)
        }
      } catch {
        /* 查询失败按缺失处理 */
      }
    }
    if (!meta) {
      console.error('[question:reply] FAILED 未找到对应 form:', requestID)
      return false
    }
    // 载荷形状换算（关键，实测踩坑）：渲染层沿用 V1 语义，每题答案本身是**数组**（多选），
    // 而 V2 单选字段要求**字符串**（数组会被拒：FormInvalidAnswerError "Expected string for form field: q0"）。
    // 故：多选字段保留数组，其余取首个元素转字符串。
    const fields = meta.fields && meta.fields.length ? meta.fields : (meta.fieldKeys || []).map((k) => ({ key: k }))
    const answer = {}
    fields.forEach((f, i) => {
      const v = answers[i]
      if (v === undefined || v === null) return
      const multi = /multi/i.test(String(f.type || ''))
      if (Array.isArray(v)) {
        if (multi) answer[f.key] = v
        else if (v.length) answer[f.key] = String(v[0])
      } else {
        answer[f.key] = String(v)
      }
    })
    try {
      await this._req('POST', `/api/session/${meta.sessionID}/form/${requestID}/reply`, { answer })
    } catch (e) {
      console.error('[question:reply] FAILED', e.message)
      return false
    }
    this._formMap.delete(requestID)
    return true
  }

  async rejectQuestion(requestID) {
    const meta = this._formMap.get(requestID)
    try {
      await this._req('DELETE', `/api/session/${meta?.sessionID || ''}/form/${requestID}`)
    } catch (e) {
      console.error('[question:reject] FAILED', e.message)
      return false
    }
    this._formMap.delete(requestID)
    return true
  }

  // pending form 列表（Phase 1 保留通路）
  async listPendingForms() {
    const data = await this._req('GET', '/api/form')
    return Array.isArray(data) ? data : []
  }

  // ---- 全局事件流：SSE 解帧 + V2→V1 归一化 ----

  // 订阅全局事件流，onEvent 收到规范化后的 V1 形状 { type, properties }
  // 同时向内部等待器分发（sendMessage 两段式等待依赖此通路）
  async watchGlobal(onEvent) {
    const res = await fetch(`${this.base}/api/event`, {
      headers: { accept: 'text/event-stream', ...this._headers() }
    })
    if (!res.ok) throw new Error(`GET /api/event ${res.status}`)
    this._sseConnected = true
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop()
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          let evt
          try {
            evt = JSON.parse(line.slice(6))
          } catch {
            continue /* 忽略解析失败帧 */
          }
          for (const norm of this._normalizeEvent(evt)) {
            try {
              onEvent(norm)
            } catch {
              /* 单事件消费方异常不中断事件流 */
            }
            this._notifyWaiters(norm.type, norm.properties || {})
          }
        }
      }
    } finally {
      this._sseConnected = false
    }
  }

  // V2 事件 → V1 形状事件数组（多数一一对应；execution.failed 同时产出 session.error + session.idle）
  _normalizeEvent(evt) {
    const type = evt?.type
    const d = evt?.data || {}
    const out = []
    switch (type) {
      case 'server.connected':
        out.push({ type: 'server.connected', properties: {} })
        break
      case 'session.created':
        out.push({ type: 'session.created', properties: { sessionID: d.sessionID, title: d.title } })
        break
      case 'session.updated':
        out.push({ type: 'session.updated', properties: { sessionID: d.sessionID, title: d.title } })
        break
      case 'session.text.delta':
        out.push({
          type: 'message.part.delta',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            partID: 't' + (d.ordinal ?? 0),
            field: 'text',
            delta: d.delta || ''
          }
        })
        break
      case 'session.text.ended':
        out.push({
          type: 'message.part.updated',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            part: { id: 't' + (d.ordinal ?? 0), type: 'text', text: d.text || '' }
          }
        })
        break
      case 'session.retry.scheduled': {
        // V2 引擎自带重试调度（供应商限流/网络抖动时自动重试）：
        // 透出为 session.retry 供上层感知（渲染层 default 分支忽略；任务引擎记录日志）。
        // 职责划分：引擎内重试 = 单次请求级（透明）；任务引擎的外层重试 = 任务级兜底（整任务重跑）
        const err = d.error || {}
        out.push({
          type: 'session.retry',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            attempt: d.attempt,
            at: d.at,
            error: { name: err.type || 'Error', message: err.message || '' }
          }
        })
        break
      }
      case 'session.reasoning.started':
      case 'session.reasoning.delta':
      case 'session.reasoning.ended': {
        // V1 思考流经 message.part.updated 全量替换；V2 为增量，这里在桥内累积成全文再下发
        const key = `${d.sessionID}:${d.assistantMessageID}:${d.ordinal ?? 0}`
        if (type === 'session.reasoning.started') this._reasoning.set(key, '')
        const cur = this._reasoning.get(key) || ''
        const full = type === 'session.reasoning.ended' ? d.text || cur : cur + (d.delta || '')
        this._reasoning.set(key, full)
        if (type === 'session.reasoning.ended') this._reasoning.delete(key)
        out.push({
          type: 'message.part.updated',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            part: { id: 'r' + (d.ordinal ?? 0), type: 'reasoning', text: full }
          }
        })
        break
      }
      case 'session.tool.input.started':
        this._toolNames.set(`${d.sessionID}:${d.id}`, d.name)
        out.push({
          type: 'message.part.updated',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            part: { id: d.id, callID: d.id, type: 'tool', tool: d.name, state: { status: 'pending', input: {}, time: { start: evt.created } } }
          }
        })
        break
      case 'session.tool.called':
        out.push({
          type: 'message.part.updated',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            part: {
              id: d.id,
              callID: d.id,
              type: 'tool',
              tool: this._toolNames.get(`${d.sessionID}:${d.id}`) || d.name,
              state: { status: 'running', input: d.input || {}, time: { start: evt.created } }
            }
          }
        })
        break
      case 'session.tool.progress':
        out.push({
          type: 'message.part.updated',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            part: {
              id: d.id,
              callID: d.id,
              type: 'tool',
              tool: this._toolNames.get(`${d.sessionID}:${d.id}`),
              // progress 刻意【不带 time】（设计 §5.4(c)）：否则会把后到的 progress 当成
              // 时间更新，覆盖掉 started/called 写入的 start
              state: { status: 'running', metadata: d.metadata }
            }
          }
        })
        break
      case 'session.tool.success':
        out.push({
          type: 'message.part.updated',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            part: {
              id: d.id,
              callID: d.id,
              type: 'tool',
              tool: this._toolNames.get(`${d.sessionID}:${d.id}`),
              state: { status: 'completed', output: joinContent(d.content), metadata: d.metadata, time: { end: evt.created } }
            }
          }
        })
        break
      case 'session.tool.error':
        out.push({
          type: 'message.part.updated',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            part: {
              id: d.id,
              callID: d.id,
              type: 'tool',
              tool: this._toolNames.get(`${d.sessionID}:${d.id}`) || d.name,
              // 错误载荷归一化（T0-②）：error 统一为字符串，errorType 保留结构化类型
              // （取消判定用 errorType==='aborted'，不再靠文案猜测），errorRaw 留原始对象排障
              state: (() => {
                const e = normalizeToolErrorShape(d.error !== undefined ? d.error : d.message)
                return {
                  status: 'error',
                  error: e.text || '工具执行失败',
                  errorType: e.type,
                  errorRaw: e.raw,
                  time: { end: evt.created }
                }
              })()
            }
          }
        })
        break
      case 'session.step.started':
        this._activeAsst.set(d.sessionID, d.assistantMessageID)
        break // 无 V1 对应事件（V1 step-start 亦不产生渲染动作）
      case 'session.step.ended':
        out.push({
          type: 'message.updated',
          properties: {
            sessionID: d.sessionID,
            messageID: d.assistantMessageID,
            info: { finish: d.finish, tokens: d.tokens, cost: d.cost }
          }
        })
        break
      case 'session.step.failed':
        out.push({
          type: 'message.updated',
          properties: { sessionID: d.sessionID, messageID: d.assistantMessageID, info: { finish: 'error' } }
        })
        break
      case 'session.execution.succeeded':
        // 附带 session.updated 触发列表刷新（标题生成/时间戳更新后的兜底同步）
        out.push({ type: 'session.updated', properties: { sessionID: d.sessionID } })
        out.push({ type: 'session.idle', properties: { sessionID: d.sessionID } })
        break
      case 'session.execution.failed': {
        const err = d.error || {}
        out.push({
          type: 'session.error',
          properties: {
            sessionID: d.sessionID,
            error: { name: err.type || 'Error', message: err.message || '执行失败', data: err }
          }
        })
        out.push({ type: 'session.idle', properties: { sessionID: d.sessionID } })
        break
      }
      case 'permission.asked':
        out.push({
          type: 'permission.asked',
          properties: {
            sessionID: d.sessionID,
            id: d.id,
            permission: ACTION_TO_KEY[d.action] || d.action, // 渲染层权限档位以 V1 键名存取（bash/task）
            action: d.action,
            resources: d.resources,
            save: d.save,
            message: d.message
          }
        })
        break
      case 'form.created': {
        const form = d.form
        if (form && Array.isArray(form.fields)) {
          this._formMap.set(form.id, {
            sessionID: form.sessionID,
            // 字段键 + 类型（类型用于应答时区分「单选需字符串 / 多选可用数组」，见 answerQuestion）
            fields: form.fields.map((f) => ({ key: f.key, type: f.type }))
          })
          // question 工具产生的 form 归一化为 V1 question.asked；其余 form（Phase 2+ 能力）暂不下发
          if ((form.metadata && form.metadata.kind === 'question') || !form.metadata) {
            out.push({
              type: 'question.asked',
              properties: {
                id: form.id,
                sessionID: form.sessionID,
                questions: form.fields.map((f) => ({
                  header: f.title && f.description ? f.title : '',
                  question: f.description || f.title || f.key,
                  options: (f.options || []).map((o) => ({ label: o.label, description: o.description, value: o.value })),
                  multiple: f.type === 'multiselect' || f.type === 'multi',
                  custom: !!f.custom
                }))
              }
            })
          }
        }
        break
      }
      case 'form.replied':
        this._formMap.delete(d.id)
        break
      case 'form.cancelled':
      case 'form.removed':
        this._formMap.delete(d.id)
        break
      case 'session.revert.staged':
        out.push({ type: 'session.revert.staged', properties: d })
        break
      case 'session.revert.committed':
        out.push({ type: 'session.revert.committed', properties: d })
        break
      default:
        // 其余 V2 事件（inbox/usage/retry/资源同步/location/shell 等）渲染层与任务引擎均不消费，丢弃
        break
    }
    return out
  }
}

// 导出纯函数便于单测（locationQuery 的中括号形态与回显断言是最易回归的两处）
module.exports = { Bridge, locationQuery, ensureLocationEcho, normDir, RELOAD_TIMEOUT_MS }
