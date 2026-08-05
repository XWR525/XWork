// 主进程入口：窗口管理 + IPC 桥 + 引擎生命周期
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { Engine } = require('./engine')
const { Bridge } = require('./bridge')
const { Settings, applyToOpencode } = require('./settings')
const logger = require('./logger')

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

// 从启动方式解析「以该文件夹为工作区」：
// 1) 显式参数：xwork "D:\folder"（多段路径以引号包裹）
// 2) cwd 检测：资源管理器地址栏/命令行启动时进程 cwd 即当前文件夹（跳过 dev、系统目录、安装目录）
function resolveLaunchDir() {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  for (const a of process.argv.slice(1)) {
    if (a === '--' || a.startsWith('-')) continue
    try {
      if (fs.statSync(a).isDirectory()) return a
    } catch {
      /* 非目录参数忽略 */
    }
  }
  if (isDev) return null
  try {
    const cwd = process.cwd()
    if (!fs.statSync(cwd).isDirectory()) return null
    const sysRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()
    const installDir = path.dirname(process.execPath).toLowerCase()
    const c = cwd.toLowerCase()
    if (c.startsWith(sysRoot) || c === installDir) return null
    return cwd
  } catch {
    return null
  }
}

app.whenReady().then(async () => {
  const launchDir = resolveLaunchDir()
  const cfg = settings.load()
  if (launchDir && launchDir !== cfg.workspace) settings.save({ workspace: launchDir })
  engine = new Engine({
    xdgHome,
    cwd: launchDir || cfg.workspace || null, // 工作区（地址栏启动目录 > 上次打开 > 默认启动目录）
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
  console.log('[ws] switch 开始, dir=', dir)
  settings.save({ workspace: dir })
  engine.setCwd(dir)
  await engine.stop()
  console.log('[ws] stop 完成, 准备强制重启')
  const st = await engine.start({ force: true }) // 强制新进程：cwd 是进程级属性，必须换进程才生效
  console.log('[ws] 重启完成, running=', st.running, 'workspace=', st.workspace)
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

ipcMain.handle('session:create', async (_e, { title, permission }) =>
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
  settings.save(raw)
  applyToOpencode(opencodeConfig, settings)
  if (restart) {
    await engine.stop()
    await engine.start()
  }
  return { ok: true }
})

// 发送消息：优先使用渲染层指定的模型（会话级模型），否则回退设置默认
ipcMain.handle('message:send', (_e, sessionID, text, model) =>
  bridge.sendMessage(sessionID, text, model && typeof model === 'object' ? model : settings.currentModel())
)

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sseActive = false
  engine?.stop()
})
