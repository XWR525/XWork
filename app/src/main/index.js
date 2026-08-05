// 主进程入口：窗口管理 + IPC 桥 + 引擎生命周期
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { Engine } = require('./engine')
const { Bridge } = require('./bridge')
const { Settings, applyToOpencode } = require('./settings')

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

app.whenReady().then(async () => {
  engine = new Engine({
    xdgHome,
    cwd: settings.load().workspace || null, // 工作区（上次打开/默认启动目录）
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sseActive = false
  engine?.stop()
})
