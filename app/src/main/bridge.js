// opencode HTTP API 桥：会话、消息、权限响应、全局事件流
const { DEFAULT_PORT } = require('./engine')

const DEFAULT_MODEL = { providerID: 'deepseek', modelID: 'deepseek-v4-flash' }

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
  async sendMessage(sessionID, text, model = DEFAULT_MODEL) {
    const res = await fetch(`${this.base}/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, parts: [{ type: 'text', text }] })
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

module.exports = { Bridge, DEFAULT_MODEL }
