// opencode HTTP API 桥：会话、消息、权限响应、全局事件流
const { net } = require('electron')
const { DEFAULT_PORT } = require('./engine')

class Bridge {
  constructor(port = DEFAULT_PORT) {
    this.port = port
    this.base = `http://127.0.0.1:${port}`
  }

  async listSessions() {
    const res = await fetch(`${this.base}/session`)
    if (!res.ok) throw new Error(`GET /session ${res.status}`)
    return await res.json()
  }

  // 已加载的模型提供商列表（设置页模型下拉用）
  async getProviders() {
    const res = await fetch(`${this.base}/provider`)
    if (!res.ok) throw new Error(`GET /provider ${res.status}`)
    return await res.json()
  }

  async deleteSession(sessionID) {
    const res = await fetch(`${this.base}/session/${sessionID}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`DELETE session ${res.status}`)
    return res.ok
  }

  async renameSession(sessionID, title) {
    const res = await fetch(`${this.base}/session/${sessionID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title })
    })
    if (!res.ok) throw new Error(`PATCH session ${res.status}`)
    return await res.json()
  }

  async createSession(title, permission) {
    const body = { title }
    if (permission && permission.length) body.permission = permission
    const res = await fetch(`${this.base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`POST /session ${res.status}: ${await res.text()}`)
    return await res.json()
  }

  // 同步发送消息：等待完整回复返回；实时过程由全局事件流推送
  // agent 为 opencode 模式（build/plan），随消息绑定到会话并持久化
  // 注意：这里用 Electron net.fetch（Chromium 网络栈）而非全局 fetch——
  // 全局 fetch（undici）有 300s 的 headers/body 默认超时，长任务首个 step 等待快照时会被掐断，
  // 导致「等待超时」被误报为发送失败（任务实际仍在推进，由事件流继续推送）
  async sendMessage(sessionID, text, model, agent) {
    const body = { model, parts: [{ type: 'text', text }] }
    if (agent) body.agent = agent
    const res = await net.fetch(`${this.base}/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`POST message ${res.status}: ${await res.text()}`)
    return await res.json()
  }

  async getMessages(sessionID) {
    const res = await fetch(`${this.base}/session/${sessionID}/message`)
    if (!res.ok) throw new Error(`GET message ${res.status}`)
    return await res.json()
  }

  // 中断正在运行的任务；返回 true 表示已停止
  async abortMessage(sessionID) {
    const res = await fetch(`${this.base}/session/${sessionID}/abort`, { method: 'POST' })
    if (!res.ok) throw new Error(`POST abort ${res.status}`)
    return res.ok
  }

  // 压缩会话（等效 opencode TUI 的 /compact）：引擎将历史总结为摘要并替换（保留近期内容）
  // 走 v1 summarize 接口（v2 的 /api/session/{id}/compact 是未实现存根，恒返回 503），需指定总结所用模型
  // 异步执行，进度经全局事件流推送（message.updated / session.idle）
  async compactSession(sessionID, model) {
    const res = await fetch(`${this.base}/session/${sessionID}/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerID: model.providerID, modelID: model.modelID })
    })
    if (!res.ok) throw new Error(`POST summarize ${res.status}`)
    return res.ok
  }

  async respondPermission(sessionID, permissionID, response) {
    const res = await fetch(`${this.base}/session/${sessionID}/permissions/${permissionID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response })
    })
    if (!res.ok) {
      console.error('[perm:respond] FAILED', res.status, (await res.text()).slice(0, 200))
    }
    return res.ok
  }

  // 回答 AI 的提问（ask 工具）：answers 为字符串数组，按问题顺序对应每题选中的选项 label
  async answerQuestion(requestID, answers) {
    const res = await fetch(`${this.base}/question/${requestID}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers })
    })
    if (!res.ok) {
      console.error('[question:reply] FAILED', res.status, (await res.text()).slice(0, 200))
    }
    return res.ok
  }

  // 拒绝 AI 的提问（不回答，通知 AI 继续）
  async rejectQuestion(requestID) {
    const res = await fetch(`${this.base}/question/${requestID}/reject`, { method: 'POST' })
    if (!res.ok) {
      console.error('[question:reject] FAILED', res.status, (await res.text()).slice(0, 200))
    }
    return res.ok
  }

  // 订阅全局事件流，onEvent 收到规范化后的 { type, properties }
  async watchGlobal(onEvent) {
    const res = await fetch(`${this.base}/global/event`, {
      headers: { accept: 'text/event-stream' }
    })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop()
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        try {
          const evt = JSON.parse(line.slice(6))
          const payload = evt.payload || {}
          onEvent({ type: payload.type, properties: payload.properties || {} })
        } catch {
          /* 忽略解析失败帧 */
        }
      }
    }
  }
}

module.exports = { Bridge }
