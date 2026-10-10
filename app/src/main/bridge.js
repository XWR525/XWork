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

// 工具输出 content[]（[{type:'text', text}]）→ 纯文本
function joinContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
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

  // 统一请求：自动 Basic Auth + {data} 解包 + 204 → null；失败抛出带状态码与响应片段的错误
  async _req(method, p, body) {
    const res = await fetch(this.base + p, {
      method,
      headers: this._headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
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
    const json = await res.json()
    return json && typeof json === 'object' && 'data' in json ? json.data : json
  }

  // ---- 会话 ----

  // 会话列表（V1 兼容：附带 directory 字段 = location.directory，供工作区登记/清理使用）
  async listSessions() {
    const out = []
    let cursor = ''
    for (let page = 0; page < 10; page++) {
      const p = '/api/session?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
      const data = await this._req('GET', p)
      const rows = Array.isArray(data) ? data : []
      for (const s of rows) out.push({ ...s, directory: s.location?.directory || s.directory })
      const next = data && !Array.isArray(data) ? data.cursor?.next : null
      if (!rows.length || !next) break
      cursor = next
    }
    return out
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
    if (agent) {
      try {
        await this.switchAgent(sessionID, agent)
      } catch (e) {
        // 未知 agent 名不阻塞发送（V2 对 agent 校验更严），记录后继续
        console.warn('[bridge] switchAgent failed (ignored):', e.message)
      }
    }
    await this.prompt(sessionID, text)
    // 等待首个 step 完成：优先事件等待（SSE 存活时），否则轮询兜底
    let asstID = null
    if (this._sseConnected) {
      asstID = await this._waitFirstStep(sessionID)
    } else {
      asstID = await this._pollFirstStep(sessionID)
    }
    // 拉取权威数据并返回目标 assistant 消息（V1 形状）
    try {
      const msgs = await this.getMessages(sessionID)
      const assts = msgs.filter((m) => m.info.role === 'assistant')
      const hit = asstID ? assts.find((m) => m.info.id === asstID) : null
      if (hit) return hit
      if (assts.length) return assts[assts.length - 1]
    } catch {
      /* 拉取失败则返回最小占位，避免上层 undefined 崩溃 */
    }
    return {
      info: { id: asstID || 'unknown', role: 'assistant', finish: 'error', error: { name: 'EngineError', message: '未获取到模型回复' } },
      parts: []
    }
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
            state: {
              status: c.state?.status || (c.executed ? 'completed' : 'pending'),
              input: c.state?.input,
              output: joinContent(c.state?.content),
              metadata: c.state?.metadata,
              time: c.time
            }
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
    return null // idle / model-switched / agent-switched 等非消息条目
  }

  async getMessages(sessionID) {
    // 升序分页拉全量（V1 GET 返回全量数组；默认 limit=100 封顶 20 页 ≈ 2000 条，足够会话回看）
    const entries = []
    let cursor = ''
    for (let page = 0; page < 20; page++) {
      const p =
        `/api/session/${sessionID}/message?limit=100&order=asc` +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
      const data = await this._req('GET', p)
      const rows = Array.isArray(data) ? data : []
      entries.push(...rows)
      const next = data && !Array.isArray(data) ? data.cursor?.next : null
      if (!rows.length || !next) break
      cursor = next
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
  // 实测（迁移文档 Phase 4-A）：新增/删除 provider 与模型、权限规则均即时生效；且**不会打断正在运行的任务**
  async locationReload() {
    await this._req('POST', '/api/location/reload', {})
    return true
  }

  // 引擎当前已加载的配置文档清单（[{type:'document', path, info:<解析后的配置>}]）——用于热重载后校验生效
  async configEntries() {
    const data = await this._req('GET', '/api/config')
    return Array.isArray(data) ? data : []
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
            part: { id: d.id, callID: d.id, type: 'tool', tool: d.name, state: { status: 'pending', input: {}, time: {} } }
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
              state: { status: 'running', input: d.input || {}, time: {} }
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
              state: { status: 'running', metadata: d.metadata, time: {} }
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
              state: { status: 'completed', output: joinContent(d.content), metadata: d.metadata, time: {} }
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
              state: { status: 'error', error: d.error || d.message || '工具执行失败', time: {} }
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

module.exports = { Bridge }
