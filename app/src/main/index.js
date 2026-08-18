// 统一配置（app/app.config.json）：技能服务地址、窗口尺寸、引擎端口、各超时/时长等
// 用户可通过设置面板「配置」页覆盖部分字段（存于 xwork-settings.json 的 config 层）
const { cfg, mergeConfig } = require('./config')

// 有效配置 = app.config.json 默认值 + 用户覆盖层（设置面板保存）
function effectiveConfig() {
  return mergeConfig(cfg, settings.load().config || {})
}

// 主进程入口：窗口管理 + IPC 桥 + 引擎生命周期
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, Tray, nativeImage } = require('electron')
// Windows 通知（toast）的应用名取自 AppUserModelID：不设置时回退 Electron 默认值（electron.app.Electron），
// 通知显示名会变成 "Electron"；显式设为安装包 appId（package.json build.appId）后，安装包快捷方式携带该 AUMID，
// 系统通知即正确显示应用名（XWork）
if (process.platform === 'win32') {
  app.setAppUserModelId('com.xwork.desktop')
}
const path = require('node:path')
const fs = require('node:fs')
const { execSync } = require('node:child_process')
const { Engine, findGit } = require('./engine')
const { Bridge } = require('./bridge')
const { Settings, applyToOpencode, MASK } = require('./settings')
const { restoreMissingFiles, collectUndoImpact } = require('./undo')
const { TaskStore, Scheduler, isValidCron, nextRunAfter, normalizeTask, describeCron } = require('./tasks')
const { TaskRunner } = require('./task-runner')
const logger = require('./logger')
const JSZip = require('jszip')

// 尽早初始化文件日志：补丁 console 后，后续所有主进程输出同时落盘
logger.init()

let win = null
let engine = null
let bridge = null
let sseActive = false
// 系统托盘（关闭时最小化到托盘功能）：tray 常驻、退出标志、首次托盘提示防重复
let tray = null
let isQuitting = false
let trayNotified = false
// 手动停止的会话：跳过该会话下一次 session.idle 的「已完成」通知（停止 ≠ 完成，避免误导）
const skipIdleNotif = new Map()

// 托盘图标：内嵌 16x16 PNG（蓝色圆角方块 + 白色 X），不依赖外部文件，开发/打包均可靠
const TRAY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWElEQVR4nGNgoDawr3jwHx/Gq/n///94NYMwCODUDAP4NMMAVmfjMwSbHFZ/Y1OIy2CcAYcL4AxQQv7FFS60M4AiL1AUiPhswyZHvYRElaSML0aIzkzkAACTrxDPgW0/SAAAAABJRU5ErkJggg=='
)
// 显示主窗口：最小化则恢复，然后显示并聚焦
function showMainWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// Windows 通知：点击恢复主窗口；系统不支持通知时静默忽略
function notify(body) {
  try {
    const n = new Notification({ title: 'XWork', body })
    n.on('click', showMainWindow)
    n.show()
  } catch {
    /* 系统不支持通知时忽略 */
  }
}

// 任务通知：仅当窗口不在前台（失焦/隐藏/最小化）且设置开启时弹系统通知。
// 前台时回复文字与提问弹窗用户直接可见，系统通知是打扰；
// 手动停止的任务不弹「已完成」（skipIdleNotif 标志区分，避免误导）
function maybeNotify(evt) {
  if (!settings.load().notifyTask) return
  if (win && !win.isDestroyed() && win.isFocused()) return
  const sid = evt.properties?.sessionID
  if (evt.type === 'session.idle') {
    if (sid && skipIdleNotif.has(sid)) {
      skipIdleNotif.delete(sid)
      return
    }
    notify('AI 已完成回复')
  } else if (evt.type === 'question.asked') {
    const q = (evt.properties?.questions || [])[0]
    if (q?.question) notify('AI 向你提问：' + String(q.question).slice(0, 40))
  }
}
// 任务完成/失败/超时通知：与 maybeNotify 共用决策（任务通知开关 + 仅窗口不在前台时弹）。
// 由 TaskRunner 注入调用（定时任务结果通知），避免绕过设置与前台判断
function taskNotify(body) {
  if (!settings.load().notifyTask) return
  if (win && !win.isDestroyed() && win.isFocused()) return
  notify(body)
}
// 创建系统托盘：单击恢复窗口；右键菜单「显示主窗口 / 退出」
function createTray() {
  if (tray) return
  tray = new Tray(TRAY_ICON)
  tray.setToolTip('XWork')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showMainWindow)
}

const xdgHome =
  process.env.XWORK_OPCODE_HOME || path.join(app.getPath('userData'), 'opencode')

// 设置存储与 opencode 配置文件
const settings = new Settings(path.join(xdgHome, 'xwork-settings.json'))
const opencodeConfig = path.join(xdgHome, 'config', 'opencode', 'opencode.json')

// 定时任务：任务存储 / 执行器 / 调度器
// 调度器启动/停止随应用生命周期（仅应用运行时任务执行）；任务引擎惰性拉起，空闲 5 分钟回收
const taskStore = new TaskStore(path.join(xdgHome, 'xwork-tasks.json'))
const taskRunner = new TaskRunner({
  store: taskStore,
  notify: taskNotify, // 任务通知：任务通知开关 + 仅窗口不在前台时弹（与 maybeNotify 同决策）
  settings,
  effectiveConfig,
  ensureGit: (dir, opts) => ensureWorkdirGit(dir, opts),
  mainXdgHome: xdgHome
})
const taskScheduler = new Scheduler(taskStore, {
  // 命中回调：任务执行（定时与立即执行共用 taskRunner）；finally 释放调度器运行锁（防重入）
  onFire: async (task) => {
    try {
      return await taskRunner.runTask(task)
    } finally {
      taskScheduler.markDone(task.id)
    }
  }
})

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
  const w = effectiveConfig().window
  win = new BrowserWindow({
    width: w.width,
    height: w.height,
    minWidth: w.minWidth,
    minHeight: w.minHeight,
    title: 'XWork',
    // 无边框自绘标题栏（与暗色 UI 统一），窗口控制由渲染层按钮 + IPC 完成
    frame: false,
    backgroundColor: w.backgroundColor,
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
  // 关闭时动作：设置开启「最小化到托盘」时拦截关闭 → 隐藏窗口（引擎继续后台运行）；
  // 从托盘「退出」或真正退出时 isQuitting=true，放行关闭
  win.on('close', (e) => {
    if (isQuitting || settings.load().closeAction !== 'tray') return
    e.preventDefault()
    win.hide()
    if (!trayNotified) {
      trayNotified = true
      try {
        new Notification({ title: 'XWork', body: '已最小化到系统托盘，点击托盘图标可恢复窗口' }).show()
      } catch {
        /* 系统不支持通知时忽略 */
      }
    }
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
          maybeNotify(evt)
        })
        console.log('[sse] stream closed')
      } catch (e) {
        console.error('[sse] disconnected:', e.message)
      }
      if (!sseActive) break
      await new Promise((r) => setTimeout(r, cfg.timings.sseReconnectMs))
    }
  }
  loop()
}

app.whenReady().then(async () => {
  const cfg = settings.load()
  // 工作区存在性校验：上次打开的工作区可能已被删除/移动，若以其为引擎 cwd 启动，
  // Windows 上 spawn 直接 ENOENT 崩溃（错误对象指向 exe 路径，极易误导为引擎缺失）。
  // 不存在则回退空工作区并清空持久化，保证应用始终可启动
  let ws = cfg.workspace
  if (ws && !fs.existsSync(ws)) {
    console.warn('[ws] 上次工作区不存在，已回退空工作区:', ws)
    ws = null
    settings.save({ workspace: '' })
  }
  engine = new Engine({
    xdgHome,
    cwd: ws, // 工作区（上次打开的目录；已校验存在）
    port: effectiveConfig().enginePort, // 引擎端口（用户可在设置面板「配置」页覆盖，重启应用后生效）
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
  bridge = new Bridge(effectiveConfig().enginePort)
  createWindow()
  createTray()
  try {
    applyToOpencode(opencodeConfig, settings) // 保证 provider 段与设置一致
    // 工作区建立时静默 git init：引擎快照每轮对话前写入，事后 init 无法追溯此前轮次（见 ensureWorkdirGit）
    ensureWorkdirGit(ws, { init: true })
    await engine.start()
    startGlobalWatch()
  } catch (e) {
    console.error('engine start failed:', e.message)
    win.webContents.send('engine:event', {
      type: 'engine.error',
      properties: { message: e.message }
    })
  }
  // 定时任务：启动调度器（整分 tick）。“启动时运行”（@startup）功能已移除：
  // 不再触发（fireNow），并自动删除历史 @startup 任务（任务引擎独立于主引擎，主引擎失败不影响调度）
  taskScheduler.start()
  for (const t of taskStore.list()) {
    if (t.schedule === '@startup') taskStore.remove(t.id)
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

// 有效配置（默认值 + 用户覆盖层）：渲染层取隐藏列表/时长；设置面板「配置」页取全部可编辑字段
ipcMain.handle('config:get', () => effectiveConfig())

// 配置表单 → 用户覆盖层：仅接受已知字段并做类型/范围校验，非法键丢弃
function sanitizeConfigOverrides(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.skillApiBase === 'string' && raw.skillApiBase.trim()) {
    out.skillApiBase = raw.skillApiBase.trim()
  }
  const port = Number(raw.enginePort)
  if (Number.isInteger(port) && port >= 1 && port <= 65535) out.enginePort = port
  if (raw.window && typeof raw.window === 'object') {
    const w = {}
    for (const k of ['width', 'height', 'minWidth', 'minHeight']) {
      const v = Number(raw.window[k])
      if (Number.isInteger(v) && v > 0) w[k] = v
    }
    if (Object.keys(w).length) out.window = w
  }
  for (const k of ['hideDirs', 'hideFiles']) {
    // 数组整体替换：空数组也保存（清空 = 不再隐藏任何目录/文件，覆盖默认列表）
    if (Array.isArray(raw[k])) {
      out[k] = raw[k].map((x) => String(x).trim()).filter(Boolean)
    }
  }
  return out
}

// 保存配置覆盖层：写入 settings（引擎端口/窗口尺寸需重启应用后生效）
ipcMain.handle('config:save', (_e, raw) => {
  const overrides = sanitizeConfigOverrides(raw)
  settings.save({ config: overrides })
  console.log('[config] saved overrides:', JSON.stringify(overrides))
  return { ok: true }
})

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

// 登记工作区到注册表（任务工作区「选择新的工作区」使用）：幂等，仅登记不计数
ipcMain.handle('workspace:register', async (_e, dir) => {
  if (!dir || typeof dir !== 'string') return { ok: false, error: '无效的目录路径' }
  if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在' }
  wsRecord(dir)
  return { ok: true }
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
  // 工作区建立时静默 git init（引擎快照依赖：每轮对话前写入，事后 init 无法追溯此前轮次）
  ensureWorkdirGit(dir, { init: true })
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

// 目标轮次前快照 T_before：消息 part 的 step-start/step-finish 携带引擎 track() 的 write-tree 结果（实测确认），
// 即每轮「操作完成后」的快照。回退到目标 user 消息之前 → 工作区应回到「目标轮次开始前」的状态：
//   取目标消息之前最后一条带 snapshot 的 part；
//   若目标消息之前无任何快照（目标消息是会话首条），取目标轮首个 step-start 的快照（同为轮次开始前状态）
async function snapshotBeforeMessage(bridge, sessionID, messageID) {
  try {
    const msgs = await bridge.getMessages(sessionID)
    let lastBefore = null
    for (const m of msgs || []) {
      if (m.info && m.info.id === messageID) break
      for (const p of m.parts || []) {
        if (typeof p.snapshot === 'string' && p.snapshot) lastBefore = p.snapshot
      }
    }
    if (lastBefore) return lastBefore
    let sawTarget = false
    for (const m of msgs || []) {
      if (m.info && m.info.id === messageID) {
        sawTarget = true
        continue
      }
      if (!sawTarget) continue
      for (const p of m.parts || []) {
        if (typeof p.snapshot === 'string' && p.snapshot) return p.snapshot
      }
    }
    return null
  } catch {
    return null
  }
}

// 撤销到指定 user 消息之前（「回退至此」）：回退该消息及之后的全部文件变更与会话状态
// bridge.revertMessage 已兜底「引擎返回 200 但无快照」的静默失败（非 git 工作区等），不会误报成功
// 引擎 revert 存在缺陷：被改名/删除的旧文件不恢复（旧名不在任何 patch 的 files 列表，见 undo功能设计.md §7.4），
// 兜底参照采用「目标轮次前快照 T_before」而非 revert 返回的「操作后快照」：
// 回退后工作区应等于 T_before 状态，T_before 有、工作区缺的文件即漏恢复的旧文件，按路径恢复
ipcMain.handle('session:undo-to', async (_e, sessionID, messageID) => {
  if (!sessionID || typeof sessionID !== 'string') return { ok: false, reason: 'bad_args' }
  if (!messageID || typeof messageID !== 'string') return { ok: false, reason: 'bad_args' }
  try {
    const tBefore = await snapshotBeforeMessage(bridge, sessionID, messageID)
    console.log('[session:undo-to] tBefore=', tBefore || '(none)')
    const r = await bridge.revertMessage(sessionID, messageID)
    console.log('[session:undo-to] ok=', r.ok, r.reason || '')
    if (r.ok && r.revert && r.revert.snapshot) {
      const ws = engine.status().workspace || settings.load().workspace
      const git = findGit()
      const fb = tBefore
        ? restoreMissingFiles({
            git,
            snapshotDir: path.join(xdgHome, 'data', 'opencode', 'snapshot'),
            workspace: ws,
            snapshot: tBefore
          })
        : { ok: true, restored: [], skipped: [] }
      console.log(
        '[session:undo-to] snapshot-compensate:',
        fb.ok ? `restored=${fb.restored.length} skipped=${fb.skipped.length}` : `skip (${fb.reason})`
      )
      // 兜底恢复完成后（工作区为最终状态）再收集实际影响
      const imp = collectUndoImpact({
        git,
        snapshotDir: path.join(xdgHome, 'data', 'opencode', 'snapshot'),
        workspace: ws,
        snapshot: r.revert.snapshot
      })
      console.log(
        '[session:undo-to] impact:',
        imp.ok ? imp.impact.map((i) => `${i.type}:${i.path}`).join(' | ') || '(none)' : `skip (${imp.reason})`
      )
      return { ...r, restored: fb.ok ? fb.restored : [], impact: imp.ok ? imp.impact : [] }
    }
    return r
  } catch (e) {
    console.error('[session:undo-to] failed:', e.message)
    return { ok: false, reason: 'error', message: e.message }
  }
})

// git 可用性 + 工作区 git 状态检测 + 按需 git init
// - 内置 MinGit 优先，其次系统 git（findGit，与引擎快照实际使用的 git 一致）
// - 工作区 git 检测：沿目录向上查找 .git（与引擎探测逻辑一致）
// - opts.init=true 且工作区非 git 时执行 git init（静默：工作区建立/切换时调用，保证引擎每轮对话前能写快照）
// 注意：引擎的快照是「每轮对话前」写入的，若等用户要回退时才 init，此前轮次没有快照、无法回退，
// 因此必须在工作区建立时就保证 .git 存在（启动恢复 + 切换工作区两处调用）
function ensureWorkdirGit(dir, opts = {}) {
  const git = findGit()
  if (!git) return { ok: false, reason: 'no_git', available: false, isGit: false }
  let cur = dir
  let isGit = false
  while (cur && fs.existsSync(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) { isGit = true; break }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  if (isGit) return { ok: true, available: true, isGit: true }
  if (opts.init) {
    // 无工作区（null/空）：无目录可 init，直接返回（避免误在应用目录执行 git init）
    if (!dir) return { ok: true, available: true, isGit: false }
    try {
      execSync(`"${git}" init`, { cwd: dir, stdio: 'ignore', windowsHide: true })
      console.log('[git:ensure] git init done at', dir)
      return { ok: true, available: true, isGit: true, inited: true }
    } catch (e) {
      console.error('[git:ensure] init failed:', e.message)
      return { ok: false, reason: 'init_failed', available: true, isGit: false, message: e.message }
    }
  }
  return { ok: true, available: true, isGit: false }
}

ipcMain.handle('git:ensure', (_e, dir, opts = {}) => ensureWorkdirGit(dir, opts))

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

// 关闭时动作：quit = 关闭程序 | tray = 最小化到托盘（仅持久化，主进程读取后即时生效）
ipcMain.handle('settings:apply-close-action', (_e, action) => {
  if (action !== 'tray' && action !== 'quit') return { ok: false }
  settings.save({ closeAction: action })
  console.log('[settings] closeAction =', action)
  return { ok: true }
})

// 任务通知开关：仅持久化，主进程读取后即时生效
ipcMain.handle('settings:apply-notify-task', (_e, on) => {
  if (typeof on !== 'boolean') return { ok: false }
  settings.save({ notifyTask: on })
  console.log('[settings] notifyTask =', on)
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

ipcMain.handle('message:abort', (_e, sessionID) => {
  if (sessionID) skipIdleNotif.set(sessionID, true) // 手动停止 ≠ 完成：跳过该会话的「已完成」通知
  return bridge.abortMessage(sessionID)
})

// 压缩会话：委托引擎原生 summarize（等效 TUI /compact，需指定总结所用模型，异步执行，进度经全局事件流推送）
ipcMain.handle('session:compact', async (_e, sessionID, model) => {
  if (!sessionID || typeof sessionID !== 'string') return { ok: false, error: '无效的会话 ID' }
  if (!model || typeof model.providerID !== 'string' || typeof model.modelID !== 'string') {
    return { ok: false, error: '缺少总结所用模型' }
  }
  try {
    await bridge.compactSession(sessionID, model)
    return { ok: true }
  } catch (e) {
    console.error('[session:compact] failed:', e.message)
    return { ok: false, error: e.message || '压缩会话失败' }
  }
})

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
// 注意：技能服务只监听 localhost（IPv6），127.0.0.1:4321 是另一程序占用（404）
ipcMain.handle('skill:list', async () => {
  const base = effectiveConfig().skillApiBase
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(`${base}/api/skill/list`, { signal: ctrl.signal })
    if (!res.ok) return { ok: false, error: `技能服务响应异常（HTTP ${res.status}）` }
    const list = await res.json()
    console.log(`[skill] fetch ok, items=${Array.isArray(list) ? list.length : 'non-array'}`)
    return { ok: true, skills: Array.isArray(list) ? list : [] }
  } catch (e) {
    console.warn('[skill] fetch failed:', e.name, e.message)
    return {
      ok: false,
      error: e.name === 'AbortError' ? '技能服务连接超时' : `无法连接技能服务（${base}）`
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

// SKILL 安装：确保 .agents/skills 存在（无则创建）→ 下载 zip（自带 .agents/skills 前缀结构）
// → 直接解压到工作区根目录，自动覆盖旧文件（10s 超时）
ipcMain.handle('skill:install', async (_e, id) => {
  if (!Number.isInteger(id)) return { ok: false, error: '无效的技能 ID' }
  const ws = settings.load().workspace || engine.workspace()
  if (!ws) return { ok: false, error: '未找到当前工作区，请先打开一个工作区' }
  const skillsDir = path.join(ws, '.agents', 'skills')
  try {
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    let res
    try {
      res = await fetch(`${effectiveConfig().skillApiBase}/api/skill/${id}/download`, { signal: ctrl.signal })
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

// SKILL 已安装检测：扫描工作区 .agents/skills 下的子文件夹名（= slug），返回列表
ipcMain.handle('skill:installed', async () => {
  const ws = settings.load().workspace || engine.workspace()
  if (!ws) return { ok: true, slugs: [] }
  const dir = path.join(ws, '.agents', 'skills')
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

// SKILL 卸载：按 slug 删除工作区 .agents/skills/<slug> 整个文件夹
// slug 校验：仅字母数字/._-（无路径分隔符，杜绝路径穿越）
ipcMain.handle('skill:uninstall', async (_e, slug) => {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
    return { ok: false, error: '无效的技能标识' }
  }
  const ws = settings.load().workspace || engine.workspace()
  if (!ws) return { ok: false, error: '未找到当前工作区，请先打开一个工作区' }
  const dir = path.join(ws, '.agents', 'skills', slug)
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
  isQuitting = true
  sseActive = false
  engine?.stop()
  taskScheduler.stop()
  taskRunner.dispose()
})

// ---------- 定时任务 IPC ----------
// 校验并归一化任务定义：名称/工作区/执行内容/模型/频率合法性校验，计算下次执行时间
function validateTask(raw) {
  const norm = normalizeTask(raw)
  if (!norm.name) throw new Error('请填写任务名称')
  if (!norm.workspace) throw new Error('请选择任务工作区')
  if (!norm.prompt) throw new Error('请填写执行内容（prompt）')
  if (!norm.model || !norm.model.modelID) throw new Error('请选择模型')
  if (!isValidCron(norm.schedule)) throw new Error('执行频率表达式不合法')
  if (norm.schedule === '@startup') throw new Error('「启动时运行」已不再支持，请设置具体执行频率')
  return norm
}

// 任务列表（附带展示字段：cron 人话描述、运行中标记、历史条数）
// 注意：剥离 history 全量数组（列表 5 秒轮询不传全量历史，展开时按需 tasks:history 拉取）
ipcMain.handle('tasks:list', () =>
  taskStore.list().map((t) => {
    const { history, ...rest } = t
    return {
      ...rest,
      _historyCount: Array.isArray(history) ? history.length : 0,
      _nextText: t.schedule === '@startup' ? '应用启动时' : describeCron(t.schedule),
      // 运行中 = 调度器运行锁（定时触发）或执行器当前任务（立即执行），两者任一命中即锁卡片
      _running: taskScheduler.isRunning(t.id) || taskRunner.isCurrent(t.id)
    }
  })
)

// 任务执行历史（倒序：最新在前；任务不存在返回空数组）
ipcMain.handle('tasks:history', (_e, id) => {
  const t = taskStore.get(id)
  return t ? [...(t.history || [])].reverse() : []
})

// 计算 cron 接下来 N 次运行时间点（构造器预览用；无效表达式返回空数组）
ipcMain.handle('tasks:next-runs', (_e, expr, count) => {
  const n = Number.isInteger(count) && count > 0 ? count : 5
  try {
    const out = []
    let from = new Date()
    for (let i = 0; i < n; i++) {
      const t = nextRunAfter(expr, from)
      if (t === null) break
      out.push(t)
      from = new Date(t)
    }
    return out
  } catch {
    return []
  }
})

// 创建任务
ipcMain.handle('tasks:create', async (_e, raw) => {
  const task = validateTask(raw)
  task.nextRunAt = task.schedule === '@startup' ? -1 : nextRunAfter(task.schedule)
  taskStore.upsert(task)
  return task
})

// 更新任务（运行中禁止修改）
ipcMain.handle('tasks:update', async (_e, id, patch) => {
  const cur = taskStore.get(id)
  if (!cur) throw new Error('任务不存在')
  if (taskRunner.current && taskRunner.current.task.id === id) throw new Error('任务正在进行，无法修改')
  const merged = validateTask({ ...cur, ...patch })
  merged.createdAt = cur.createdAt
  merged.nextRunAt = merged.schedule === '@startup' ? -1 : nextRunAfter(merged.schedule)
  taskStore.upsert(merged)
  return merged
})

// 删除任务（运行中禁止删除；同步清理固定会话）
ipcMain.handle('tasks:remove', async (_e, id) => {
  const cur = taskStore.get(id)
  if (!cur) throw new Error('任务不存在')
  if (taskRunner.current && taskRunner.current.task.id === id) throw new Error('任务正在进行，无法删除')
  taskStore.remove(id)
  await taskRunner.deleteTaskSession(cur)
  return { ok: true }
})

// 立即执行：绕过调度器等待，强制入队（任务引擎串行，忙碌时返回 busy）
// 执行前向调度器登记运行锁（防执行期间 tick 命中同一任务重复触发），finally 释放
ipcMain.handle('tasks:run-now', async (_e, id) => {
  const cur = taskStore.get(id)
  if (!cur) throw new Error('任务不存在')
  if (taskScheduler.isRunning(id)) throw new Error('任务正在进行，无法执行')
  taskScheduler.markRunning(id)
  try {
    return await taskRunner.runNow(cur)
  } finally {
    taskScheduler.markDone(id)
  }
})
