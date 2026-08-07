// 主进程入口：窗口管理 + IPC 桥 + 引擎生命周期
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { Engine } = require('./engine')
const { Bridge } = require('./bridge')
const { Settings, applyToOpencode, MASK } = require('./settings')
const logger = require('./logger')
const JSZip = require('jszip')

// 尽早初始化文件日志：补丁 console 后，后续所有主进程输出同时落盘
logger.init()

let win = null
let engine = null
let bridge = null
let sseActive = false

const xdgHome =
  process.env.XWORK_OPCODE_HOME || path.join(app.getPath('userData'), 'opencode')

// 设置存储与 opencode 配置文件
const settings = new Settings(path.join(xdgHome, 'xwork-settings.json'))
const opencodeConfig = path.join(xdgHome, 'config', 'opencode', 'opencode.json')

// 工作区注册表：应用自维护所有发生过会话/切换的工作区
// （opencode 的 /session 按当前项目过滤且作用域漂移，不可作为跨工作区数据源，注册表保证稳定）
const wsRegistryFile = path.join(xdgHome, 'xwork-workspaces.json')
const wsKey = (dir) => String(dir).replace(/\\/g, '/').toLowerCase()
function wsLoad() {
  try {
    const list = JSON.parse(fs.readFileSync(wsRegistryFile, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}
function wsSave(list) {
  try {
    fs.mkdirSync(path.dirname(wsRegistryFile), { recursive: true })
    fs.writeFileSync(wsRegistryFile, JSON.stringify(list, null, 2))
  } catch (e) {
    console.error('[ws] registry save failed:', e.message)
  }
}
// 登记工作区（幂等）：仅在「在此工作区发起首次对话」时调用，是该工作区正式成立的节点；
// 刷新最近使用时间，重复调用不会重复计数
function wsRecord(dir) {
  if (!dir || typeof dir !== 'string') return
  const list = wsLoad()
  let item = list.find((x) => wsKey(x.dir) === wsKey(dir))
  if (!item) {
    item = { dir, name: dir.split(/[\\/]/).pop() || dir, count: 0, last: 0 }
    list.push(item)
  }
  item.name = dir.split(/[\\/]/).pop() || dir
  item.last = Date.now()
  wsSave(list)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'XWork',
    // 无边框自绘标题栏（与暗色 UI 统一），窗口控制由渲染层按钮 + IPC 完成
    frame: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      // 窗口最小化/后台时不禁流定时器与动画（打字机、任务状态渲染保持实时）
      backgroundThrottling: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('engine:event', { type: 'app.ready', properties: {} })
  })
}

// 全局事件流转发到渲染进程（异常后自动重连）
function startGlobalWatch() {
  if (sseActive) return
  sseActive = true
  const loop = async () => {
    while (sseActive) {
      try {
        console.log('[sse] connecting...')
        await bridge.watchGlobal((evt) => {
          console.log('[sse] event:', evt.type)
          if (win && !win.isDestroyed()) win.webContents.send('engine:event', evt)
        })
        console.log('[sse] stream closed')
      } catch (e) {
        console.error('[sse] disconnected:', e.message)
      }
      if (!sseActive) break
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  loop()
}

app.whenReady().then(async () => {
  const cfg = settings.load()
  engine = new Engine({
    xdgHome,
    cwd: cfg.workspace || null, // 工作区（上次打开的目录）
    extraEnv: () => settings.env(), // 注入模型 API Key 环境变量
    onExit: (code) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('engine:event', {
          type: 'engine.exited',
          properties: { code }
        })
      }
    }
  })
  bridge = new Bridge()
  createWindow()
  try {
    applyToOpencode(opencodeConfig, settings) // 保证 provider 段与设置一致
    await engine.start()
    startGlobalWatch()
  } catch (e) {
    console.error('engine start failed:', e.message)
    win.webContents.send('engine:event', {
      type: 'engine.error',
      properties: { message: e.message }
    })
  }
})

ipcMain.handle('engine:start', async () => {
  const st = await engine.start()
  startGlobalWatch()
  return st
})

ipcMain.handle('engine:status', () => engine.status())

// 重启引擎：安装技能后需重启才能识别新技能（stop → 强制新进程，保留当前工作区）
ipcMain.handle('engine:restart', async () => {
  try {
    await engine.stop()
    const st = await engine.start({ force: true })
    console.log('[engine] restart done, running=', st.running)
    return { ok: true, status: st }
  } catch (e) {
    console.error('[engine] restart failed:', e.message)
    return { ok: false, error: e.message || '重启引擎失败' }
  }
})

// 应用版本信息（设置页「关于」使用）
ipcMain.handle('app:info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${process.platform} ${process.arch}`
}))

// 渲染进程日志转发（preload 补丁 console 后经此写入主进程日志文件）
ipcMain.on('log:write', (_e, { level, text }) => {
  if (typeof text !== 'string' || !['INFO', 'WARN', 'ERROR'].includes(level)) return
  logger.renderer(level, text)
})

// 在文件资源管理器中打开日志目录（设置页「日志」按钮）
ipcMain.handle('log:open', async () => {
  const dir = logger.dir()
  if (!dir) return { ok: false }
  const err = await shell.openPath(dir)
  return err ? { ok: false } : { ok: true }
})

// 用系统默认浏览器打开外部链接（仅允许 http/https，防止打开本地文件等危险协议）
ipcMain.handle('shell:open-external', async (_e, url) => {
  if (typeof url !== 'string') return
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return
    await shell.openExternal(url)
  } catch {
    /* 忽略无效 URL */
  }
})

// ===== 自动更新（electron-updater，仅打包版启用） =====
let updater = null

// 开发模式无 app-update.yml 且不宜联网检查，故仅打包版初始化
if (app.isPackaged) {
  const { autoUpdater } = require('electron-updater')
  updater = autoUpdater
  updater.autoDownload = false // 检测到新版本后由用户在 UI 点击「立即下载」，避免静默占用带宽
  updater.logger = logger.updaterLogger() // 更新日志写入 logs/updater.log，便于排查更新问题
  for (const evt of [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error'
  ]) {
    updater.on(evt, (data) => sendUpdateEvent(evt, data))
  }
}

// 更新事件经现有 engine:event 通道推送渲染层（type 为 update.*，供设置页展示）
function sendUpdateEvent(evt, data) {
  if (!win || win.isDestroyed()) return
  let properties = {}
  if (evt === 'update-available' || evt === 'update-downloaded') {
    properties = { version: data?.version }
  } else if (evt === 'download-progress') {
    properties = { percent: data?.percent ?? 0 }
  } else if (evt === 'error') {
    properties = { message: data?.message || String(data || '未知错误') }
  }
  win.webContents.send('engine:event', { type: `update.${evt}`, properties })
}

ipcMain.handle('update:check', async () => {
  if (!updater) return { ok: false, disabled: true }
  try {
    await updater.checkForUpdates()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message || '检查更新失败' }
  }
})

ipcMain.handle('update:download', async () => {
  if (!updater) return { ok: false, disabled: true }
  try {
    await updater.downloadUpdate()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message || '下载更新失败' }
  }
})

ipcMain.handle('update:install', () => {
  if (!updater) return { ok: false, disabled: true }
  updater.quitAndInstall()
  return { ok: true }
})

// 选择工作区文件夹（系统目录选择对话框）
ipcMain.handle('workspace:pick', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(win, {
    title: '选择工作区文件夹',
    buttonLabel: '打开',
    properties: ['openDirectory']
  })
  return canceled || !filePaths.length ? null : filePaths[0]
})

// 切换工作区：持久化路径 → 重启引擎（新 cwd）→ 返回新状态
ipcMain.handle('workspace:switch', async (_e, dir) => {
  if (!dir || typeof dir !== 'string') return { ok: false, error: '无效的目录路径' }
  let stat
  try {
    stat = fs.statSync(dir)
  } catch {
    return { ok: false, error: '目录不存在' }
  }
  if (!stat.isDirectory()) return { ok: false, error: '所选路径不是文件夹' }
  console.log('[ws] switch start, dir=', dir)
  settings.save({ workspace: dir })
  engine.setCwd(dir)
  await engine.stop()
  console.log('[ws] stop done, forcing restart')
  const st = await engine.start({ force: true }) // 强制新进程：cwd 是进程级属性，必须换进程才生效
  console.log('[ws] restart done, running=', st.running, 'workspace=', st.workspace)
  return { ok: true, status: st }
})

// 懒加载读取目录（文件树用，单层）
ipcMain.handle('workspace:list-dir', async (_e, dir) => {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    return entries
      .map((en) => ({ name: en.name, type: en.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  } catch (e) {
    return { error: e.message }
  }
})

// 所有工作区：注册表为基准 + 尽力用 /session 回填历史目录与会话数
ipcMain.handle('workspace:list', async () => {
  const list = wsLoad()
  // 尽力回填：引擎可用时按 /session 聚合目录与计数（作用域漂移/接口异常时静默降级为注册表）
  try {
    const sessions = await bridge.listSessions()
    const byKey = new Map(list.map((x) => [wsKey(x.dir), x]))
    const fresh = new Map() // key -> { n, last }
    for (const s of sessions) {
      const dir = s.directory
      if (!dir || typeof dir !== 'string') continue
      const key = wsKey(dir)
      const t = s.time?.updated || s.time?.created || 0
      const f = fresh.get(key) || { n: 0, last: 0 }
      f.n += 1
      if (t > f.last) f.last = t
      fresh.set(key, f)
      if (!byKey.has(key)) {
        byKey.set(key, { dir, name: dir.split(/[\\/]/).pop() || dir, count: 0, last: 0 })
        list.push(byKey.get(key))
      }
    }
    for (const [key, f] of fresh) {
      const it = byKey.get(key)
      it.count = Math.max(it.count, f.n) // 取较大值，避免作用域漂移导致计数缩水
      if (f.last > it.last) it.last = f.last
    }
    wsSave(list)
  } catch (e) {
    console.warn('[ws] backfill skipped:', e.message)
  }
  // 路径已不存在于当前电脑时标记（渲染层以删除线展示）
  for (const it of list) it.exists = fs.existsSync(it.dir)
  const sorted = list.sort((a, b) => b.last - a.last)
  console.log('[ws] all workspaces:', sorted.length)
  return sorted
})

// 删除工作区（仅路径不存在的条目）：移除注册表条目 + 删除该目录下的引擎会话，避免被 /session 回填复活
ipcMain.handle('workspace:delete', async (_e, dir) => {
  if (!dir || typeof dir !== 'string') return { ok: false, error: '无效的目录路径' }
  const key = wsKey(dir)
  wsSave(wsLoad().filter((x) => wsKey(x.dir) !== key))
  let sessionsDeleted = 0
  let warning = ''
  try {
    const sessions = await bridge.listSessions()
    for (const s of sessions) {
      if (s.directory && wsKey(s.directory) === key) {
        await bridge.deleteSession(s.id)
        sessionsDeleted += 1
      }
    }
  } catch (e) {
    warning = '引擎未连接，仅移除列表项，会话未删除'
  }
  console.log(`[ws] delete ${dir}, sessions deleted=${sessionsDeleted}`)
  return { ok: true, sessionsDeleted, warning }
})

// 自绘标题栏窗口控制（无边框窗口的最小化/最大化/关闭）
ipcMain.on('window:minimize', () => win?.minimize())
ipcMain.on('window:maximize', () => {
  if (!win) return
  win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('window:close', () => win?.close())

// 文件右键菜单操作
// 用系统默认程序打开文件/目录
ipcMain.handle('file:open', async (_e, abs) => {
  if (!abs || typeof abs !== 'string') return { ok: false, error: '无效路径' }
  const err = await shell.openPath(abs)
  return err ? { ok: false, error: err } : { ok: true }
})
// 在系统文件管理器中定位并选中
ipcMain.handle('file:show-in-folder', (_e, abs) => {
  if (!abs || typeof abs !== 'string') return { ok: false, error: '无效路径' }
  shell.showItemInFolder(abs)
  return { ok: true }
})

ipcMain.handle('session:list', () => bridge.listSessions())

ipcMain.handle('session:create', (_e, { title, permission }) =>
  bridge.createSession(title, permission)
)

ipcMain.handle('session:delete', (_e, sessionID) => bridge.deleteSession(sessionID))

ipcMain.handle('session:rename', (_e, sessionID, title) => bridge.renameSession(sessionID, title))

// 模型列表：引擎未就绪（如刚启动、健康检查前）时返回空列表，渲染层稍后经 server.connected 事件重试
ipcMain.handle('provider:list', async () => {
  try {
    return await bridge.getProviders()
  } catch {
    return { all: [] }
  }
})

// 读取设置（apiKey 已脱敏）
ipcMain.handle('settings:get', () => settings.public())

// 最常用模型（新对话默认模型）：无使用记录返回 null
ipcMain.handle('settings:frequent-model', () => settings.frequentModel())

// 测试模型组连接：GET {baseURL}/models 带 Bearer key 认证，200 即通过
// groupId：测试已保存配置（key 由主进程解密）；baseURL/apiKey：测试表单草稿（未保存的修改）；
// 草稿 key 留空且提供 groupId 时回退已保存 key（编辑表单「留空保留原值」语义）
ipcMain.handle('model:test', async (_e, { groupId, baseURL, apiKey } = {}) => {
  let url = typeof baseURL === 'string' ? baseURL.trim() : ''
  let key = typeof apiKey === 'string' ? apiKey : ''
  if (groupId) {
    const g = settings.groupById(groupId)
    if (!g && !url) return { ok: false, error: '模型组不存在' }
    if (!url) url = g.baseURL
    if (!key) key = g.apiKey
  }
  if (!url) return { ok: false, error: '缺少 Base URL' }
  let modelsUrl
  try {
    modelsUrl = new URL(url).href.replace(/\/+$/, '') + '/models'
  } catch {
    return { ok: false, error: 'Base URL 格式无效' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const headers = { 'content-type': 'application/json' }
    if (key) headers.authorization = 'Bearer ' + key
    const res = await fetch(modelsUrl, { method: 'GET', headers, signal: controller.signal })
    if (res.ok) return { ok: true }
    let detail = ''
    try {
      const body = await res.json()
      detail = (body && body.error && body.error.message) || ''
    } catch {
      /* 响应体非 JSON，忽略 */
    }
    return { ok: false, error: `HTTP ${res.status}${detail ? '：' + detail : ''}` }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '连接超时（10s）' : e.message }
  } finally {
    clearTimeout(timer)
  }
})

// 读取界面主题（供渲染进程启动时应用）
ipcMain.handle('settings:get-theme', () => settings.public().theme)

// 应用界面主题：仅持久化，不重启引擎（主题是渲染层偏好，与模型配置无关）
ipcMain.handle('settings:apply-theme', (_e, theme) => {
  if (theme !== 'dark' && theme !== 'light') return { ok: false }
  settings.save({ theme })
  return { ok: true }
})

// 保存设置：写入存储 + 应用 opencode.json；restart=true（「保存并重启引擎」）时无条件重启引擎，
// 不以配置是否变化为条件——按钮语义即「显式重启」，即使未改动配置也应真正重启
ipcMain.handle('settings:save', async (_e, raw, restart = true) => {
  // 记录本次提交的 key 状态（排查「保存后仍提示旧 key」问题）
  const keyStatus = {
    groups: Array.isArray(raw?.modelGroups)
      ? raw.modelGroups.map((g) => `${g.id}=${g.apiKey === MASK ? 'unchanged' : g.apiKey ? 'new-key' : 'empty'}`)
      : []
  }
  console.log('[settings] save: restart=', restart, 'keyStatus=', JSON.stringify(keyStatus))
  settings.save(raw)
  applyToOpencode(opencodeConfig, settings)
  if (restart) {
    await engine.stop()
    // 强制新进程：stop 已结束旧进程（含复用的端口占用者），必须换进程才能注入新环境变量（新 key）
    await engine.start({ force: true })
  }
  return { ok: true }
})

// 发送消息：模型必须由渲染层显式指定（会话级模型，来自模型组下拉）；无有效模型时拒绝
// 首次对话是工作区「正式成立」的节点：在此工作区发起对话即登记到注册表（幂等，重复发送只刷新最近时间）
ipcMain.handle('message:send', async (_e, sessionID, text, model, agent) => {
  if (!model || typeof model !== 'object' || !model.providerID || !model.modelID) {
    return { ok: false, error: '未配置模型，请先在设置中配置模型组并选择模型' }
  }
  wsRecord(engine.workspace())
  const result = await bridge.sendMessage(sessionID, text, model, agent)
  settings.recordModelUsage(model) // 仅成功发送的消息计入使用统计（新对话默认最常用模型）
  return result
})

ipcMain.handle('message:list', (_e, sessionID) => bridge.getMessages(sessionID))

ipcMain.handle('message:abort', (_e, sessionID) => bridge.abortMessage(sessionID))

ipcMain.handle('permission:respond', (_e, { sessionID, permissionID, response }) =>
  bridge.respondPermission(sessionID, permissionID, response)
)

// 回答 AI 的提问（ask 工具）：answers 为每题答案的字符串数组
ipcMain.handle('question:reply', async (_e, requestID, answers) => {
  try {
    if (!requestID || !Array.isArray(answers)) return { ok: false, error: '参数无效' }
    await bridge.answerQuestion(requestID, answers)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// 拒绝 AI 的提问（不回答，让 AI 继续）
ipcMain.handle('question:reject', async (_e, requestID) => {
  try {
    if (!requestID) return { ok: false, error: '参数无效' }
    await bridge.rejectQuestion(requestID)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// SKILL HUB：从本地技能服务拉取可用技能列表（JSON 数组），5s 超时防卡死
// 必须用 localhost：技能服务只监听 localhost（IPv6），127.0.0.1:4321 是另一程序占用（404）
const SKILL_API = 'http://localhost:4321/api/skill/list'
ipcMain.handle('skill:list', async () => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(SKILL_API, { signal: ctrl.signal })
    if (!res.ok) return { ok: false, error: `技能服务响应异常（HTTP ${res.status}）` }
    const list = await res.json()
    console.log(`[skill] fetch ok, items=${Array.isArray(list) ? list.length : 'non-array'}`)
    return { ok: true, skills: Array.isArray(list) ? list : [] }
  } catch (e) {
    console.warn('[skill] fetch failed:', e.name, e.message)
    return {
      ok: false,
      error: e.name === 'AbortError' ? '技能服务连接超时' : '无法连接技能服务（localhost:4321）'
    }
  } finally {
    clearTimeout(timer)
  }
})

// 净化 zip 条目路径：统一分隔符、去绝对前缀（盘符/根）、解析 .. 段，返回相对路径（空串 = 丢弃）
// 防止 zip-slip：恶意包用 ../ 或绝对路径把文件写到工作区之外
function safeZipRel(name) {
  let rel = String(name).replace(/\\/g, '/').replace(/^\/+/, '').replace(/^[a-zA-Z]:\//, '')
  const out = []
  for (const p of rel.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') {
      out.pop()
      continue
    }
    out.push(p)
  }
  return out.join('/')
}

// SKILL 安装：确保 .opencode/skills 存在（opencode 约定，无则创建）→ 下载 zip（自带 .opencode/skills 前缀结构）
// → 直接解压到工作区根目录，自动覆盖旧文件（10s 超时）
ipcMain.handle('skill:install', async (_e, id) => {
  if (!Number.isInteger(id)) return { ok: false, error: '无效的技能 ID' }
  const ws = settings.load().workspace || engine.workspace()
  if (!ws) return { ok: false, error: '未找到当前工作区，请先打开一个工作区' }
  const skillsDir = path.join(ws, '.opencode', 'skills')
  try {
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    let res
    try {
      res = await fetch(`http://localhost:4321/api/skill/${id}/download`, { signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return { ok: false, error: `技能下载失败（HTTP ${res.status}）` }
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()))
    for (const f of Object.values(zip.files)) {
      if (f.dir) continue
      const rel = safeZipRel(f.name)
      if (!rel) continue
      const dest = path.join(ws, rel)
      if (dest !== ws && !dest.startsWith(ws + path.sep)) {
        return { ok: false, error: `技能包包含非法路径：${f.name}` }
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, await f.async('nodebuffer'))
    }
    console.log(`[skill] installed id=${id} -> ${ws}`)
    return { ok: true, target: ws }
  } catch (e) {
    console.warn('[skill] install failed:', e.name, e.message)
    return {
      ok: false,
      error: e.name === 'AbortError' ? '技能下载超时' : `安装失败：${e.message}`
    }
  }
})

// SKILL 已安装检测：扫描工作区 .opencode/skills 下的子文件夹名（= slug），返回列表
ipcMain.handle('skill:installed', async () => {
  const ws = settings.load().workspace || engine.workspace()
  if (!ws) return { ok: true, slugs: [] }
  const dir = path.join(ws, '.opencode', 'skills')
  try {
    if (!fs.existsSync(dir)) return { ok: true, slugs: [] }
    const slugs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    return { ok: true, slugs }
  } catch (e) {
    console.warn('[skill] installed scan failed:', e.message)
    return { ok: true, slugs: [] }
  }
})

// SKILL 卸载：按 slug 删除工作区 .opencode/skills/<slug> 整个文件夹
// slug 校验：仅字母数字/._-（无路径分隔符，杜绝路径穿越）
ipcMain.handle('skill:uninstall', async (_e, slug) => {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
    return { ok: false, error: '无效的技能标识' }
  }
  const ws = settings.load().workspace || engine.workspace()
  if (!ws) return { ok: false, error: '未找到当前工作区，请先打开一个工作区' }
  const dir = path.join(ws, '.opencode', 'skills', slug)
  try {
    if (!fs.existsSync(dir)) return { ok: false, error: `技能「${slug}」不存在` }
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`[skill] uninstalled slug=${slug}`)
    return { ok: true }
  } catch (e) {
    console.warn('[skill] uninstall failed:', e.message)
    return { ok: false, error: `卸载失败：${e.message}` }
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sseActive = false
  engine?.stop()
})
