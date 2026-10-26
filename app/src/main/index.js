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
const crypto = require('node:crypto')
const { execSync } = require('node:child_process')
const { Engine, findGit } = require('./engine')
const { Bridge } = require('./bridge')
const { Settings, applyToOpencode, MASK, EFFORT_VARIANTS } = require('./settings')
const { restoreMissingFiles, restoreWorkspaceToSnapshot, collectUndoImpact } = require('./undo')
const { TaskStore, Scheduler, isValidCron, nextRunAfter, normalizeTask, describeCron } = require('./tasks')
const { TaskRunner } = require('./task-runner')
const { ensureAgentsBridge, removeAgentsBridge } = require('./agents-bridge')
const { statusWithGeneration } = require('./engine-status')
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

// ── 引擎世代号（设计 §5.7 / 评审 v3-B-1）──────────────────────────────────────
// 为什么需要：渲染层要判断"这张子智能体卡属于上一代引擎进程吗"才能把未终态卡片降级为「状态未知」，
// 而它拿不到进程身份 —— bridge.info() 是主进程方法（渲染层不可达）、engine.status() 不含 pid、
// server.connected 事件原本是空 properties。故世代号由主进程维护，并随事件与 engine:status 透出。
// 为什么不在每次 start 都自增：engine.start() 可能【复用】已存在的健康引擎（多实例场景），
// 那种情况下 pid 不变 ⇒ 不得自增，否则会把正在跑的卡片误判成"上一代"。
let engineGeneration = 0
let lastEnginePid = null

function bumpEngineGeneration(reason) {
  engineGeneration++
  console.log(`[engine] generation -> ${engineGeneration} (${reason})`)
  return engineGeneration
}

/** 启动/复用引擎后同步世代号：只在真的换了进程（pid 变化）时自增 */
async function syncEngineGeneration(reason) {
  try {
    const info = await bridge.info()
    const pid = info && info.pid != null ? String(info.pid) : null
    if (pid && pid !== lastEnginePid) {
      lastEnginePid = pid
      bumpEngineGeneration(reason)
    }
  } catch (e) {
    console.warn('[engine] 世代号同步失败（已忽略）:', e.message)
  }
}

// 托盘图标：内嵌 16x16 PNG（由用户应用图标生成，scripts/gen-icons.mjs），不依赖外部文件，开发/打包均可靠
const TRAY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAkklEQVR42mP4//+/0////5/8Jx2A9DgxkKkZbgjDfwrBcDEgODHv//WbN8ECLoFROBVv2r7pv2tQNBj7Tr2L6gKQISDN379//+/VexEsBqJB2LPnwn+P7otgjTAAY8MNAGlGth2mGYaRNcHYRw4fhRgA06xvZgc3BJcBICynqoHpAmIByAJklwyTdEBxZqIoOwMAsxy2LY9JrNoAAAAASUVORK5CYII='
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
// V2 引擎配置文件路径：config 目录名改为 opencode2（V1 为 config/opencode），由 applyToOpencode 写入
const opencodeConfig = path.join(xdgHome, 'config', 'opencode2', 'opencode.json')

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
  // 窗口图标：开发模式取 build/icon.ico（打包安装后 exe 自带图标，该路径不存在则不设）
  const winIconPath = path.join(app.getAppPath(), 'build', 'icon.ico')
  win = new BrowserWindow({
    width: w.width,
    height: w.height,
    minWidth: w.minWidth,
    minHeight: w.minHeight,
    title: 'XWork',
    ...(fs.existsSync(winIconPath) ? { icon: winIconPath } : {}),
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
  // 开发者工具：主进程没有注册任何加速键（autoHideMenuBar + 无自定义菜单），
  // 默认的 F12 / Ctrl+Shift+I 在打包版里不生效 → 这里显式接上，便于排查渲染问题。
  // 排查完可随时删掉（不影响功能）。
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const key = String(input.key || '').toLowerCase()
    const isF12 = key === 'f12'
    const isInspect = input.control && input.shift && key === 'i'
    if (isF12 || isInspect) {
      win.webContents.toggleDevTools()
      e.preventDefault()
    }
  })
  // 外部链接拦截：对话内容中点击 http(s) 链接改用系统默认浏览器打开，主窗口不导航。
  // file:// 与 dev server origin 属内部导航，放行（Vite 整页刷新依赖同源导航）
  const devOrigin = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : null
  const isExternalUrl = (u) => {
    try {
      const x = new URL(u)
      if (x.protocol === 'file:') return false
      if (devOrigin && x.origin === devOrigin) return false
      return x.protocol === 'http:' || x.protocol === 'https:'
    } catch {
      return false
    }
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (isExternalUrl(url)) {
      e.preventDefault()
      shell.openExternal(url)
    }
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

/** 桥接是否启用（默认启用；手工编辑 xwork-settings.json 或在设置里关掉都走这里） */
function agentsBridgeEnabled() {
  return settings.load().agentsBridge?.enabled !== false
}

/**
 * 开关 true→false 时：遍历【工作区注册表】逐个摘链（不止当前工作区）。
 * 设计依据 §5.5（评审 M-1）：只处理当前工作区会留下其它工作区的 `.opencode` 空壳；
 * 而 `workspace:delete` 只处理"路径已不存在的条目"，那里摘链是死代码。
 */
function removeAgentsBridgeEverywhere(reason) {
  let dirs = []
  try {
    dirs = (wsLoad() || []).map((w) => w.dir).filter(Boolean)
  } catch (e) {
    console.warn('[agents-bridge] 读取工作区注册表失败:', e.message)
  }
  // 当前工作区也必须包含（可能尚未登记到注册表）
  const cwdFallback = process.cwd()
  const fromEngine = (engine && engine.workspace && engine.workspace()) || null
  const cur =
    settings.load().workspace ||
    (fromEngine && path.resolve(fromEngine) !== path.resolve(cwdFallback) ? fromEngine : null)
  if (cur && !dirs.includes(cur)) dirs.push(cur)
  const done = []
  const failed = []
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue
      const r = removeAgentsBridge(dir)
      const touched = r.removed.length > 0 || r.shellRemoved
      if (touched) done.push(dir)
      for (const b of r.blocked || []) failed.push({ dir, reason: b.reason })
    } catch (e) {
      failed.push({ dir, reason: e.message })
    }
  }
  console.log(`[agents-bridge] 关闭桥接（${reason}）：已处理 ${done.length} 个工作区${failed.length ? `，${failed.length} 个失败` : ''}`)
  for (const f of failed) console.warn(`[agents-bridge] 摘链失败 ${f.dir}: ${f.reason}`)
  return { done, failed }
}

// ── 引擎启动的唯一封装：建链 → 启动 → 异步自检 ────────────────────────────────
// 设计依据：功能设计文档/agents目录junction桥接设计.md v2.1 §5.1/§5.5
// 为什么必须收敛到一处：engine.start() 有 6 个入口（本文件 5 处 + task-runner），
// 逐个插桩必然漏掉某条路径（例如引擎崩溃后由 settings:save 回退重启），
// 表现为"某些情况下 .agents 不生效"这类难以复现的问题。
//
// 顺序是硬约束：ensureAgentsBridge 必须在 engine.start() 【之前】，
// 因为引擎只在 Location 激活时扫描 .opencode —— 先起引擎再建链会白跑一轮。
async function startEngineWithBridge(opts) {
  // 工作区以设置为准：engine.workspace() 在 cwd 未设置时会回退 process.cwd()（Electron 下是应用目录），
  // 那样会在应用目录里建 .opencode —— 必须显式排除
  const cwdFallback = process.cwd()
  const fromEngine = engine && engine.workspace ? engine.workspace() : null
  const ws =
    settings.load().workspace ||
    (fromEngine && path.resolve(fromEngine) !== path.resolve(cwdFallback) ? fromEngine : null)
  if (ws && agentsBridgeEnabled()) {
    try {
      const r = ensureAgentsBridge(ws)
      if (r.linked.length) console.log('[agents-bridge] 已建立联接:', r.linked.join(', '))
      if (r.repaired.length) console.log('[agents-bridge] 已修复联接:', r.repaired.join(', '))
      for (const b of r.blocked) {
        console.warn(`[agents-bridge] 阻断(${b.blockedBy}) rel=${b.rel}`, b.tracked || b.error || '')
        // 用户可见提示（§5.6 M-11）：不能只写日志，否则用户以为 .agents 生效了
        sendEngineEvent('engine.bridge.warning', {
          code: b.blockedBy,
          rel: b.rel,
          tracked: b.tracked || [],
          repair: b.repair || null,
          text: describeBridgeBlock(b)
        })
      }
    } catch (e) {
      // 桥接失败绝不阻塞引擎启动
      console.warn('[agents-bridge] ensure 失败（已忽略）:', e.message)
    }
  }
  const st = await engine.start(opts)
  await syncEngineGeneration('engine.start') // 世代号：仅当进程真的换了才自增（复用不增）
  scheduleAgentsSelfCheck(ws) // 阶段 5 接入：异步、可取消、不阻塞 start 返回
  return st
}

function sendEngineEvent(type, properties) {
  if (win && !win.isDestroyed()) win.webContents.send('engine:event', { type, properties })
}

/** 把结构化阻断原因翻译成给用户看的一句话（§5.6） */
function describeBridgeBlock(b) {
  switch (b.blockedBy) {
    case 'git-tracked':
      return '.agents 未生效：.opencode/ 下已有被 git 跟踪的内容，请按提示处置后再重新打开工作区'
    case 'real-dir-nonempty':
      return `.agents 未生效：${b.rel} 是真实目录（可能来自 git clone），请确认后删除它并重新打开工作区`
    case 'gitignore-user-owned':
      return '.agents 未生效：.opencode/.gitignore 是你自己写的，且未忽略联接；本功能不会改动它'
    case 'git-ignore-ineffective':
      return '.agents 未生效：写入 .opencode/.gitignore 后仍未生效，请检查仓库的忽略规则'
    case 'cross-volume':
      return `.agents 未生效：无法在 ${b.rel} 创建目录联接（跨卷或文件系统不支持）`
    default:
      return `.agents 未生效（${b.blockedBy}）`
  }
}

// ── agents 桥接自检的调度（判据本身在 agents-selfcheck.js，便于单测）────────────
const SELF_CHECK_DEADLINE_MS = 15_000
const selfCheckState = { timer: null, signal: null }

/** 调度一次自检：异步、可取消、不阻塞 engine.start 返回（评审 S-13） */
function scheduleAgentsSelfCheck(ws) {
  if (!ws) return
  // 同一时刻只跑一个：新调度取消旧的（切换工作区/反复重启时避免堆积）
  if (selfCheckState.signal) selfCheckState.signal.cancelled = true
  if (selfCheckState.timer) clearTimeout(selfCheckState.timer)
  const signal = { cancelled: false }
  selfCheckState.signal = signal
  selfCheckState.timer = setTimeout(async () => {
    try {
      const agentBridge = require('./agents-bridge')
      const { runSelfCheck, describeSelfCheck } = require('./agents-selfcheck')
      const result = await runSelfCheck({
        bridge,
        agentsBridge: agentBridge,
        workspace: ws,
        signal,
        opts: { deadlineMs: SELF_CHECK_DEADLINE_MS }
      })
      if (signal.cancelled) return
      if (result.status === 'links-bad') {
        console.log(`[agents-bridge] 自检跳过（联接状态 ${result.linkState}）：${result.rel}`)
        return
      }
      const text = describeSelfCheck(result)
      if (!text) return
      if (result.status === 'ok') {
        console.log('[agents-bridge] ' + text)
        sendEngineEvent('engine.bridge.loaded', {
          agents: result.agents,
          commands: result.commands,
          workspace: ws,
          elapsedMs: result.elapsedMs
        })
      } else {
        console.warn('[agents-bridge] ' + text)
        sendEngineEvent('engine.bridge.warning', {
          code: 'self-check-not-converged',
          workspace: ws,
          text
        })
      }
    } catch (e) {
      console.warn('[agents-bridge] 自检异常（已忽略）:', e.message)
    }
  }, 1000)
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
          // 世代号透出（设计 §5.7 / v3-B-1）：server.connected 是渲染层判断"是否换了进程"的
          // 唯一实时入口（同进程断流重连时世代号不变 ⇒ 不得把卡片误标为状态未知）
          const payload =
            evt && evt.type === 'server.connected'
              ? { ...evt, properties: { ...(evt.properties || {}), generation: engineGeneration } }
              : evt
          if (win && !win.isDestroyed()) win.webContents.send('engine:event', payload)
          maybeNotify(payload)
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
  registerEngineInstance() // 多实例共享引擎协调：登记本实例 PID（退出时据此判断是否还有其它实例）
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
    port: effectiveConfig().enginePort, // 引擎端口（固定 4096，设置页已隐藏该项）
    extraEnv: () => settings.env(), // 注入模型 API Key 环境变量
    onExit: (code) => {
      // 引擎退出 ⇒ 立刻推进世代号：渲染层据此把该世代未终态的子智能体卡降级为「状态未知」
      // （设计 §5.7 ①：不能靠"改写消息"实现 —— 随后的 loadSession 快照会把 part 写回 running）
      lastEnginePid = null
      bumpEngineGeneration('engine.exited')
      if (win && !win.isDestroyed()) {
        win.webContents.send('engine:event', {
          type: 'engine.exited',
          properties: { code, generation: engineGeneration }
        })
      }
    }
  })
  bridge = new Bridge(effectiveConfig().enginePort, { password: engine.password }) // 与引擎共用派生密码（Basic Auth）
  createWindow()
  createTray()
  try {
    applyToOpencode(opencodeConfig, settings) // 保证 provider 段与设置一致
    // 工作区建立时静默 git init：引擎快照每轮对话前写入，事后 init 无法追溯此前轮次（见 ensureWorkdirGit）
    // 注意顺序：git init 必须在 startEngineWithBridge 之前 —— 桥接的 git 防污染需要仓库已存在
    ensureWorkdirGit(ws, { init: true })
    await startEngineWithBridge()
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
  const st = await startEngineWithBridge()
  startGlobalWatch()
  return st
})

// 引擎状态 + 世代号（渲染层首帧即可对齐世代，见设计 §10.2 O2=A）
// ⚠ engine.status() 是 async：必须 await 后再合并（曾经漏掉 await ⇒ 返回体只剩 {generation}，
//   顶栏永远"未连接"但发消息正常；详见 engine-status.js 的注释与离线单测）
ipcMain.handle('engine:status', () => statusWithGeneration(engine, engineGeneration))

// 重启引擎：安装技能后需重启才能识别新技能（stop → 强制新进程，保留当前工作区）
ipcMain.handle('engine:restart', async () => {
  try {
    await engine.stop()
    const st = await startEngineWithBridge({ force: true })
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
  // 引擎端口固定 4096（设置页已隐藏该项），不再接受用户覆盖：旧设置里若残留该项也会被忽略
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

// 保存配置覆盖层：写入 settings（窗口尺寸需重启应用后生效）
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

// 更新源：内网 Gitea 发布仓库。Gitea 不是 electron-updater 的内置 provider，
// 且内置 github provider 在自定义 host 下走 /api/v3（Gitea 只有 /api/v1，实测 404），
// 故先经 Gitea API v1 解析最新 release 的 tag，再把 generic feed 指向该 tag 的资产目录
// （latest.yml + 安装包 + 差分块）。useMultipleRangeRequest:false —— Gitea 不保证支持多段 Range，
// 强制单段差分下载；差分不可用时 electron-updater 会自动退化为整包下载。
async function pointUpdaterAtInternalLatest() {
  const src = effectiveConfig().updateSource || {}
  const api = String(src.latestApi || '').trim()
  const base = String(src.downloadBase || '').trim().replace(/\/+$/, '')
  if (!api || !base) throw new Error('未配置内网更新源（updateSource.latestApi / updateSource.downloadBase）')
  const res = await fetch(api, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`内网更新源不可达（HTTP ${res.status}）：${api}`)
  const rel = await res.json()
  const tag = String(rel?.tag_name || '').trim()
  if (!tag) throw new Error(`内网更新源未返回 tag_name：${api}`)
  updater.setFeedURL({ provider: 'generic', url: `${base}/${tag}/`, useMultipleRangeRequest: false })
  return tag
}

ipcMain.handle('update:check', async () => {
  if (!updater) return { ok: false, disabled: true }
  try {
    const tag = await pointUpdaterAtInternalLatest()
    console.log(`[update] 内网更新源已指向 ${tag}`)
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

// 切换工作区：持久化路径 + 静默 git init + 触发配置热重载（**不重启引擎进程**）
// V2 的 location 机制允许单个引擎进程服务多个目录：会话自带 location.directory，
// 因此切换工作区只需（a）记录当前工作区（新会话按它带 location）（b）让引擎加载新目录的配置。
// 兜底：引擎未运行（如崩溃后）时按常规启动一次，新进程的启动目录即新工作区。
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
  // 必须在 ensureAgentsBridge 之前：桥接的 git 防污染需要仓库已存在
  ensureWorkdirGit(dir, { init: true })
  engine.setCwd(dir) // 记录当前工作区：新会话以此为 location（引擎进程的启动目录不变）
  // 新工作区建链：必须在 locationReload 之前 —— 引擎只在扫描 .opencode 时才发现 .agents
  // 注意：这里【不】摘除旧工作区的联接（见设计 §5.5）——旧目录可能仍被进行中的任务/会话使用，
  // 且用户切回去时不必重建；联接是幂等的，留着无害
  if (agentsBridgeEnabled()) {
    try {
      const ab = ensureAgentsBridge(dir)
      if (ab.linked.length) console.log('[agents-bridge] 新工作区已建立联接:', ab.linked.join(', '))
      for (const b of ab.blocked) {
        console.warn(`[agents-bridge] 阻断(${b.blockedBy}) rel=${b.rel}`)
        sendEngineEvent('engine.bridge.warning', {
          code: b.blockedBy,
          rel: b.rel,
          tracked: b.tracked || [],
          repair: b.repair || null,
          text: describeBridgeBlock(b)
        })
      }
    } catch (e) {
      console.warn('[agents-bridge] 切换工作区建链失败（已忽略）:', e.message)
    }
  }
  const st0 = await engine.status().catch(() => ({ running: false }))
  let mode = 'none'
  if (!st0.running) {
    // 引擎不在运行：常规启动（新进程启动目录 = 新工作区，天然一致）
    const st = await startEngineWithBridge()
    console.log('[ws] engine was down, started with new workspace; running=', st.running)
    return { ok: true, status: st, mode: 'started' }
  }
  try {
    await bridge.locationReload() // 让引擎重新读取（新目录的）配置；实测不打断进行中的任务
    mode = 'hot'
  } catch (e) {
    console.warn('[ws] location reload failed, keep current process:', e.message)
    mode = 'noop'
  }
  const st = await engine.status()
  console.log('[ws] switch done (no restart), mode=', mode, 'workspace=', dir)
  return { ok: true, status: { ...st, workspace: dir }, mode }
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
    const { rows: sessions, truncated } = await bridge.listSessionsWithMeta()
    const byKey = new Map(list.map((x) => [wsKey(x.dir), x]))
    const fresh = new Map() // key -> { n, last }
    for (const s of sessions) {
      if (s.parentID) continue // 子会话不计入工作区计数与「最近使用」（设计 §5.4(a)）
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
      // 计数策略（v2-B-2 + v2-B-6 + v3-M-3）：改为「按根会话重算覆盖」——
      // 不能再用 Math.max，否则旧版本把子会话计入的膨胀值永远不会下降。
      // 但**仅当本次列表未触达分页上限、且根会话数 > 0** 时才覆盖：
      // 触达上限时 f.n 只是下界，覆盖会让计数"缩水"失真（引擎不可用/空列表同理）。
      if (!truncated && f.n > 0) {
        if (it.count !== f.n) console.log(`[ws] count recomputed ${it.dir}: ${it.count} -> ${f.n}`)
        it.count = f.n
      }
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
  // 显式带上当前工作区作为 location：V2 单进程可服务多目录，会话按 location 归属（切换工作区不再换进程）
  bridge.createSession(title, permission, engine.workspace())
)

ipcMain.handle('session:delete', (_e, sessionID) => bridge.deleteSession(sessionID))

ipcMain.handle('session:rename', (_e, sessionID, title) => bridge.renameSession(sessionID, title))

// 把正在前台运行的工具移到后台（T0-③ 实测机制；前置：工具已开始执行）
ipcMain.handle('session:background', (_e, sessionID) => bridge.sessionBackground(sessionID))

// 目标轮次前快照 T_before（V2 版）：V2 把快照挂在 assistant 条目上（snapshot{start,end,files}，
// start = 本轮编辑前 tree，end = 本轮编辑后 tree —— 实测确认，见迁移文档 §14）。
// 回退到目标 user 消息之前 → 取目标轮次首个 assistant 的 snapshot.start；
// 若目标轮无 assistant（异常）→ 退化为目标之前最后一条 assistant 的 snapshot.end
// 返回 { tBefore, touched: [本轮及之后被触碰的文件] }
async function undoSnapshotInfo(bridge, sessionID, messageID) {
  try {
    const msgs = await bridge.getMessages(sessionID)
    const ti = (msgs || []).findIndex((m) => m.info && m.info.id === messageID)
    if (ti < 0) return { tBefore: null, touched: [] }
    let tBefore = null
    for (let i = ti + 1; i < msgs.length && !tBefore; i++) {
      const sn = msgs[i].info?.snapshot
      if (msgs[i].info?.role === 'assistant' && sn?.start) tBefore = sn.start
    }
    if (!tBefore) {
      for (let i = ti - 1; i >= 0 && !tBefore; i--) {
        const sn = msgs[i].info?.snapshot
        if (msgs[i].info?.role === 'assistant' && sn?.end) tBefore = sn.end
      }
    }
    // 被回退轮次（目标轮及之后）触碰过的文件：用于精确还原/删除
    const touched = new Set()
    for (let i = ti; i < msgs.length; i++) {
      const sn = msgs[i].info?.snapshot
      if (sn && Array.isArray(sn.files)) for (const f of sn.files) if (f) touched.add(f)
    }
    return { tBefore, touched: [...touched] }
  } catch {
    return { tBefore: null, touched: [] }
  }
}

// 撤销到指定 user 消息之前（「回退至此」）：回退该消息及之后的会话状态与文件变更。
// V2 实现要点（实测，见迁移文档 §14）：
//   - 引擎 revert 为三段式：stage（暂存）→ commit（生效）/ clear（取消）
//   - 引擎只裁剪会话，完全不恢复文件 → 文件补偿由 XWork 完成（restoreWorkspaceToSnapshot）
//   - stage 返回的 snapshot = 「回退前工作区状态」，作为影响清单的对比基准（与 V1 语义一致）
ipcMain.handle('session:undo-to', async (_e, sessionID, messageID) => {
  if (!sessionID || typeof sessionID !== 'string') return { ok: false, reason: 'bad_args' }
  if (!messageID || typeof messageID !== 'string') return { ok: false, reason: 'bad_args' }
  try {
    const { tBefore, touched } = await undoSnapshotInfo(bridge, sessionID, messageID)
    console.log('[session:undo-to] tBefore=', tBefore || '(none)', 'touched=', touched.join('|') || '(none)')
    if (!tBefore) {
      // 无快照（工作区非 git / git 不可用）：无法回滚文件，明确失败而不误报成功
      return { ok: false, reason: 'no_git_snapshot' }
    }
    const st = await bridge.revertStage(sessionID, messageID)
    console.log('[session:undo-to] staged:', st?.messageID, String(st?.snapshot).slice(0, 10))
    const ws = (await engine.status()).workspace || settings.load().workspace
    const git = findGit()
    const snapshotDir = path.join(xdgHome, 'data', 'opencode2', 'snapshot')
    // 1) 文件补偿：把工作区还原到 T_before（V2 引擎不做这件事）
    const fb = restoreWorkspaceToSnapshot({ git, snapshotDir, workspace: ws, snapshot: tBefore, touchedFiles: touched })
    console.log(
      '[session:undo-to] restore:',
      fb.ok ? `restored=${fb.restored.length} removed=${fb.removed.length} skipped=${fb.skipped.length}` : `skip (${fb.reason})`
    )
    if (!fb.ok && fb.reason === 'bad_snapshot') {
      await bridge.revertClear(sessionID).catch(() => {})
      return { ok: false, reason: 'no_git_snapshot' }
    }
    // 2) 提交回退（裁剪会话）
    await bridge.revertCommit(sessionID)
    // 3) 影响清单：stage.snapshot（回退前）vs 当前工作区（回退后）
    const imp = st?.snapshot
      ? collectUndoImpact({ git, snapshotDir, workspace: ws, snapshot: st.snapshot })
      : { ok: false, reason: 'no_snapshot' }
    console.log(
      '[session:undo-to] impact:',
      imp.ok ? imp.impact.map((i) => `${i.type}:${i.path}`).join(' | ') || '(none)' : `skip (${imp.reason})`
    )
    return {
      ok: true,
      restored: fb.ok ? [...fb.restored, ...fb.removed.map((p) => p + ' (删除)')] : [],
      impact: imp.ok ? imp.impact : []
    }
  } catch (e) {
    console.error('[session:undo-to] failed:', e.message)
    return { ok: false, reason: 'engine_error', message: e.message }
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

// 推理强度设置：读 / 写（只写 effort 子对象，不触发 applyToOpencode、热重载或重启）
ipcMain.handle('settings:effort', (_e, patch) => {
  if (patch === undefined) return settings.load().effort
  return settings.saveEffort(patch)
})

// 智能体列表（供输入区选择器）：引擎注册表 + 标注哪些来自工作区 .agents
// 为什么需要：`.agents/agents/*.md` 经桥接被引擎加载后，界面上原本没有任何入口能选到它们
// （AgentPicker 曾写死 build/plan 两项）。本通道把注册表暴露给渲染层。
// 必须带 location：不带参数的 /api/agent 永远返回「引擎进程启动目录」的注册表（实测），
// 而 workspace:switch 是不换进程的热切换 → 会列错工作区的智能体。
//
// ⚠ 必须【等注册表收敛】：引擎启动后配置加载是异步的（实测：进程起来 ~1 s 时注册表为空，
// 约 3 s 才全量）。0.6.4 首版在 server.connected 时立刻查一次 → 拿到空列表 → 选择器只剩
// 内置两项，且不再刷新（用户可见现象："还是只能看见 build 和 plan"）。
// 切换工作区同理：目标 location 需要被查询激活后才开始构建注册表。
// ⚠ 两条实战教训（装了新版后再次只显示 build/plan，根因在此）：
//   ① 不能"后到的请求作废先到的结果"：渲染层会并发发起多次查询（日志实测 3 次），
//      旧实现用生成号把已完成的结果丢弃并返回空列表 → 选择器被刷成回退项。
//      改为【同工作区的并发请求合并为一个】（in-flight 去重），且只在工作区真的变化时才丢弃。
//   ② 收敛判据不能只看"连续两次样本相等"：实测 t≈2 s 时注册表已稳定但只有 4 项
//      （.agents 还没注册完，约 3 s 才到全量）→ 过早判定"收敛"，拿到不完整的列表。
//      改为【必须包含期望条目（工作区 .agents 推导出的 id）】才算收敛。
const AGENTS_LIST_DEADLINE_MS = 12_000
const AGENTS_LIST_INTERVAL_MS = 400

// 轮询与整形逻辑在 agents-list.js（可单测；本文件依赖 electron 无法在 node 下测试）
const { waitForAgentRegistry, shapeAgentList, createCoalescer } = require('./agents-list')

/* 进行中的查询：同一工作区只跑一个，多个调用共享同一 Promise（并发不再互相作废） */
const agentsListCoalescer = createCoalescer()

/**
 * 通过 DevTools 协议在【渲染进程真实 DOM】上取智能体下拉框的最终计算样式，写进主日志。
 * 用途：真机出现"文字看不清/看不见"时，肉眼与截图都难以判定成因，
 * 这里直接取浏览器实际生效的值（字体、颜色、不透明度、几何、文本内容），可一次性定位。
 *
 * 注意两件事（第一版踩过）：
 *  ① 必须【延时】执行：agents:list 返回后 React 才重渲染，立即取样会拿到上一帧的 DOM
 *     （第一版就误取了 ModelPicker：pop 仅 243x115、btn 是那个 91x22 的按钮）。
 *  ② 必须精确选择器：用 .mp-opt-group 的存在与否确认这就是智能体下拉框，并报告元素数量。
 * 任何失败都只记一行日志，绝不影响 agents:list 本身。
 */
async function diagnoseAgentPickerStyles(tag) {
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  } catch {
    return
  }
  const expr = `(() => {
    const q = (s) => document.querySelector(s)
    const pop = q('.model-pop')
    const opts = [...document.querySelectorAll('.model-opt')]
    const info = (el) => {
      if (!el) return null
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { cls: el.className, text: (el.innerText || '').replace(/\\n/g, ' | ').slice(0, 60),
               ff: s.fontFamily, fs: s.fontSize, color: s.color, opacity: s.opacity,
               visibility: s.visibility, display: s.display, overflow: s.overflow,
               render: s.textRendering, clip: s.clipPath, transform: s.transform,
               rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
    }
    return {
      pop: info(pop),
      optCount: opts.length,
      groupCount: document.querySelectorAll('.mp-opt-group').length,
      titleCount: document.querySelectorAll('.mp-opt-title').length,
      descCount: document.querySelectorAll('.mp-opt-desc').length,
      pickerBtn: info(q('.model-pick-btn')),
      opt0: info(opts[0]),
      title0: info(opts[0] && opts[0].querySelector('.mp-opt-title')),
      desc0: info(opts[0] && opts[0].querySelector('.mp-opt-desc')),
      grp0: info(q('.mp-opt-group')),
      // 该点上最顶层的元素是谁（判断是否被遮挡）
      hitAtOpt0: (() => { const o = opts[0]; if (!o) return null; const r = o.getBoundingClientRect()
        const el = document.elementFromPoint(r.x + 5, r.y + r.height / 2); return el ? el.className + '|' + el.tagName : null })()
    }
  })()`
  try {
    const r = await wc.debugger.sendCommand('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false })
    const v = r && r.result && r.result.value
    if (!v) {
      console.log(`[ui-diag${tag}] 未取到（下拉框可能未打开）`)
      return
    }
    const line = (k, x) =>
      x
        ? `[ui-diag${tag}] ${k.padEnd(9)} rect=${JSON.stringify(x.rect)} font="${String(x.ff).slice(0, 34)}" size=${x.fs} color=${x.color} opacity=${x.opacity} vis=${x.visibility} disp=${x.display} render=${x.render} text=${JSON.stringify(x.text)}`
        : `[ui-diag${tag}] ${k.padEnd(9)} (无)`
    console.log(`[ui-diag${tag}] 元素计数 .model-pop=${v.pop ? 1 : 0} .model-opt=${v.optCount} .mp-opt-group=${v.groupCount} .mp-opt-title=${v.titleCount} .mp-opt-desc=${v.descCount}`)
    console.log(`[ui-diag${tag}] opt0 命中元素=${v.hitAtOpt0}`)
    line('pop', v.pop)
    line('pickerBtn', v.pickerBtn)
    line('grp0', v.grp0)
    line('opt0', v.opt0)
    line('title0', v.title0)
    line('desc0', v.desc0)
  } catch (e) {
    console.log(`[ui-diag${tag}] 取样式失败:`, e.message)
  }
}

async function queryAgentList(ws) {
  const expectedSet = require('./agents-bridge').expectedEntries(ws).agents
  const { list, converged, waited } = await waitForAgentRegistry({
    bridge,
    workspace: ws,
    expectedIds: expectedSet,
    opts: { deadlineMs: AGENTS_LIST_DEADLINE_MS, intervalMs: AGENTS_LIST_INTERVAL_MS }
  })
  // 仅当【本工作区已不是当前工作区】时才丢弃（工作区切换期间的旧结果）；
  // 不再用"生成号"——那会让并发的正确结果互相作废（本次故障的直接原因）。
  if ((settings.load().workspace || null) !== ws) {
    console.log(`[agents] 丢弃非当前工作区的结果（发起=${ws}）`)
    return { agents: [], source: 'superseded', workspace: ws }
  }
  const agents = shapeAgentList(list, expectedSet)
  console.log(
    `[agents] 列表 ${agents.length} 个（自定义 ${agents.filter((a) => a.source === 'custom').length}）` +
      ` 收敛=${converged} 等待=${waited}ms${converged ? '' : '（超时，可能仍在加载）'}`
  )
  // 顺带把下拉框文字的真实计算样式写进日志（不阻塞、不影响结果）。
  // 两次采样：+800ms（React 应已渲染）与 +3000ms（下拉框若已打开，能看到真实布局）
  setTimeout(() => diagnoseAgentPickerStyles('-t800').catch(() => {}), 800)
  setTimeout(() => diagnoseAgentPickerStyles('-t3000').catch(() => {}), 3000)
  return { agents, source: 'ok', workspace: ws, converged, waitedMs: waited }
}

ipcMain.handle('agents:list', async () => {
  const ws = settings.load().workspace || null
  if (!ws) return { agents: [], source: 'no-workspace', workspace: null }
  const st = await engine.status().catch(() => ({ running: false }))
  if (!st.running) return { agents: [], source: 'engine-down', workspace: ws }
  try {
    // 并发合并：同一工作区的多个调用共享同一次轮询（渲染层日志实测会并发 3 次）
    return await agentsListCoalescer.run(ws, () =>
      queryAgentList(ws).catch((e) => {
        console.warn('[agents] 列表读取失败:', e.message)
        return { agents: [], source: 'error', workspace: ws, error: e.message }
      })
    )
  } catch (e) {
    console.warn('[agents] 列表读取失败:', e.message)
    return { agents: [], source: 'error', workspace: ws, error: e.message }
  }
})

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

// 读取流式正文揭示档位（供渲染进程启动时应用）
ipcMain.handle('settings:get-stream-reveal', () => settings.public().streamReveal)

// 应用流式正文揭示档位：emerge = 浮现 | typewriter = 打字机。仅持久化，不重启引擎（纯渲染层偏好）
ipcMain.handle('settings:apply-stream-reveal', (_e, mode) => {
  if (mode !== 'emerge' && mode !== 'typewriter') return { ok: false }
  settings.save({ streamReveal: mode })
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

// 热重载校验：调用引擎 reload 后，比对「引擎实际读到的配置」与「我们刚写入的文件」是否一致。
// 校验通过才认为热重载成功；任一步不符则调用方回退为重启引擎（保底，行为与迁移前一致）
async function tryHotReload() {
  const st = await engine.status().catch(() => ({ running: false }))
  if (!st.running) return { ok: false, reason: 'engine_not_running' }
  try {
    await bridge.locationReload()
  } catch (e) {
    return { ok: false, reason: 'reload_failed: ' + (e.message || e) }
  }
  try {
    const expect = JSON.parse(fs.readFileSync(opencodeConfig, 'utf8'))
    const entries = await bridge.configEntries()
    const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()
    const hit = (entries || []).find((e) => norm(e.path) === norm(opencodeConfig))
    if (!hit || !hit.info) return { ok: false, reason: 'config_not_loaded' }
    const got = hit.info
    // provider 集合：期望的 xgroup-* 必须全部在，且不得残留已删除的 xgroup-*
    const expGroups = Object.keys(expect.providers || {}).filter((k) => k.startsWith('xgroup-')).sort()
    const gotGroups = Object.keys(got.providers || {}).filter((k) => k.startsWith('xgroup-')).sort()
    if (expGroups.join(',') !== gotGroups.join(',')) return { ok: false, reason: `providers_mismatch(expect=${expGroups.join('|')} got=${gotGroups.join('|')})` }
    // 权限规则：期望的每条规则都必须出现在引擎读到的数组里（引擎可能补充默认项，故用包含判断）
    const gotPerms = JSON.stringify(got.permissions || [])
    const missing = (expect.permissions || []).filter((r) => !gotPerms.includes(JSON.stringify(r)))
    if (missing.length) return { ok: false, reason: `permissions_missing(${missing.length})` }
    // 环境变量（模型 API Key）：{env:VAR} 引用必须在引擎进程里存在且值与当前设置一致，
    // 否则热重载只能改「配置文本」，实际 Key 仍是旧进程里的旧值 → 必须重启进程才能生效
    const refs = []
    for (const p of Object.values(expect.providers || {})) {
      const m = /\{env:([A-Za-z0-9_]+)\}/.exec((p && p.settings && p.settings.apiKey) || '')
      if (m) refs.push(m[1])
    }
    const current = settings.env() || {}
    const fp = engine.envFingerprint || {}
    for (const k of refs) {
      if (!(k in fp)) return { ok: false, reason: `env_missing(${k})` }
      const now = crypto.createHash('sha1').update(String(current[k] ?? '')).digest('hex').slice(0, 16)
      if (now !== fp[k]) return { ok: false, reason: `env_changed(${k})` }
    }
    return { ok: true, detail: `providers=${gotGroups.length} permissions=${(expect.permissions || []).length} envRefs=${refs.length}` }
  } catch (e) {
    return { ok: false, reason: 'verify_failed: ' + (e.message || e) }
  }
}

// 保存设置：写入存储 + 应用 opencode.json。
// restart=true 时**优先热重载**（V2 的 POST /api/location/reload：实测可热生效 provider/模型目录与权限规则，
// 且不打断正在运行的任务），并用「引擎读回的配置 == 刚写入的文件」做校验；校验不过再回退为重启引擎。
// 注：模型组的新 API Key 通过环境变量注入引擎进程，热重载能刷新「读配置」的部分；
//     若某个改动依赖进程环境（如新增模型组后 key 尚未注入），校验失败会自动落到重启分支，语义仍然正确。
ipcMain.handle('settings:save', async (_e, raw, restart = true) => {
  // 记录本次提交的 key 状态（排查「保存后仍提示旧 key」问题）
  const keyStatus = {
    groups: Array.isArray(raw?.modelGroups)
      ? raw.modelGroups.map((g) => `${g.id}=${g.apiKey === MASK ? 'unchanged' : g.apiKey ? 'new-key' : 'empty'}`)
      : []
  }
  console.log('[settings] save: restart=', restart, 'keyStatus=', JSON.stringify(keyStatus))
  // .agents 桥接开关的 true→false 跃迁：必须在 settings.save() 之前取"旧值"
  // （save 之后 load() 读到的已是新值，无法判断方向）
  const bridgeWasEnabled = settings.load().agentsBridge?.enabled !== false
  const portBefore = effectiveConfig().enginePort
  settings.save(raw)
  const bridgeNowEnabled = settings.load().agentsBridge?.enabled !== false
  if (bridgeWasEnabled && !bridgeNowEnabled) {
    // 遍历注册表摘链（设计 §5.5，评审 M-1）：只处理当前工作区会留下其它工作区的空壳
    try {
      removeAgentsBridgeEverywhere('settings:save 关闭开关')
    } catch (e) {
      console.warn('[agents-bridge] 关闭开关摘链失败（已忽略）:', e.message)
    }
  }
  applyToOpencode(opencodeConfig, settings)
  if (!restart) return { ok: true, applied: 'none' }
  // 进程级配置（引擎端口）无法热重载，必须重启进程：命中则直接走重启分支
  const portAfter = effectiveConfig().enginePort
  if (portAfter !== portBefore) {
    console.log(`[settings] 引擎端口变更 ${portBefore} → ${portAfter}，需重启进程`)
    try {
      engine.port = portAfter
      bridge.port = portAfter
      bridge.base = `http://127.0.0.1:${portAfter}`
      await engine.stop()
      await startEngineWithBridge({ force: true })
    } catch (e) {
      console.error('[settings] 端口变更重启失败:', e.message)
      return { ok: false, error: '配置已保存，但引擎重启失败：' + (e.message || e) }
    }
    return { ok: true, applied: 'restart', reason: 'engine_port_changed' }
  }
  const hot = await tryHotReload()
  if (hot.ok) {
    console.log('[settings] 热重载生效:', hot.detail)
    return { ok: true, applied: 'hot', detail: hot.detail }
  }
  console.log('[settings] 热重载未通过（' + hot.reason + '）→ 回退重启引擎')
  try {
    await engine.stop()
    // 强制新进程：stop 已结束旧进程（含复用的端口占用者），新进程会以最新环境变量（新 key）启动
    await startEngineWithBridge({ force: true })
  } catch (e) {
    console.error('[settings] 回退重启失败:', e.message)
    return { ok: false, error: '配置已保存，但引擎重启失败：' + (e.message || e) }
  }
  return { ok: true, applied: 'restart', reason: hot.reason }
})

// 发送消息：模型必须由渲染层显式指定（会话级模型，来自模型组下拉）；无有效模型时拒绝
// 首次对话是工作区「正式成立」的节点：在此工作区发起对话即登记到注册表（幂等，重复发送只刷新最近时间）
ipcMain.handle('message:send', async (_e, sessionID, text, model, agent) => {
  if (!model || typeof model !== 'object' || !model.providerID || !model.modelID) {
    return { ok: false, error: '未配置模型，请先在设置中配置模型组并选择模型' }
  }
  // 推理强度白名单：只允许引擎内置变体 low/medium/high；非法值丢弃（否则引擎会 no-route 硬失败）
  let safeModel = model
  if (model.variant !== undefined && !EFFORT_VARIANTS.includes(model.variant)) {
    console.warn('[message:send] 非法 effort variant，已丢弃:', JSON.stringify(model.variant))
    safeModel = { ...model, variant: undefined }
  }
  wsRecord(engine.workspace())
  const result = await bridge.sendMessage(sessionID, text, safeModel, agent)
  settings.recordModelUsage(safeModel) // 仅成功发送的消息计入使用统计（新对话默认最常用模型）
  return result
})

ipcMain.handle('message:list', (_e, sessionID) => bridge.getMessages(sessionID))

// ---- 中止任务配套：终止引擎派生出的命令子进程树 ----
// opencode 的 abort 只中断引擎内部的任务循环，不会终止其已 spawn 的指令子进程（如 python 脚本）；
// Windows 也没有类 Unix 的信号/进程树级联终止。因此中止任务时枚举引擎进程的直接子进程，
// 对每个递归 taskkill /T（连同其全部分支），使「点击停止」能连带结束正在运行的外部程序。
// 引擎本体保留（会话需继续服务 / 多会话可复用）。
// 副作用：同一引擎进程下其他会话正在运行的命令也会一并结束（一次通常只有一个 busy 会话）。
function childPidsOf(ppid) {
  try {
    const out = execSync(
      `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${ppid}' | Select-Object -ExpandProperty ProcessId"`,
      { encoding: 'utf8', windowsHide: true }
    )
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
  } catch {
    return []
  }
}

function killEngineChildren() {
  if (!engine || !engine.child) return // 复用外部引擎场景：无自有 child，交由业务方自行管理
  for (const pid of childPidsOf(engine.child.pid)) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 进程可能已自行退出 */
    }
  }
}

ipcMain.handle('message:abort', async (_e, sessionID) => {
  if (sessionID) skipIdleNotif.set(sessionID, true) // 手动停止 ≠ 完成：跳过该会话的「已完成」通知
  try {
    const r = await bridge.abortMessage(sessionID)
    killEngineChildren() // 连带终止引擎为指令派生的子进程（python 等外部程序）
    return r
  } catch (e) {
    // abort 失败也尽力清掉外部子进程，避免残留继续运行
    killEngineChildren()
    throw e
  }
})

// 压缩会话：委托引擎原生 compact（等效 TUI /compact；V2 无需指定总结模型，异步执行，进度经全局事件流推送）
ipcMain.handle('session:compact', async (_e, sessionID, model) => {
  if (!sessionID || typeof sessionID !== 'string') return { ok: false, error: '无效的会话 ID' }
  if (!model || typeof model.providerID !== 'string' || typeof model.modelID !== 'string') {
    return { ok: false, error: '缺少总结所用模型' }
  }
  try {
    await bridge.compactSession(sessionID) // V2 compact 无需指定总结模型（引擎配置决定）
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

// ---------- 多实例共享引擎协调 ----------
// 多开 XWork 时所有实例共享同一个引擎进程（首个实例 spawn，后续实例复用同一端口）。
// 若任一实例退出都停止引擎（before-quit → engine.stop），会连带其它实例一起失去服务。
// 方案：在 xdgHome 维护活跃实例 PID 注册文件，仅当「最后一个存活实例」退出时才停止引擎。
const engineInstancesFile = () => path.join(xdgHome, 'engine-instances.json')
function loadEngineInstancePids() {
  try {
    const raw = JSON.parse(fs.readFileSync(engineInstancesFile(), 'utf8'))
    return Array.isArray(raw?.pids) ? raw.pids.filter((p) => typeof p === 'number') : []
  } catch {
    return []
  }
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function registerEngineInstance() {
  const pids = loadEngineInstancePids().filter((p) => p !== process.pid && isPidAlive(p))
  pids.push(process.pid)
  try {
    fs.writeFileSync(engineInstancesFile(), JSON.stringify({ pids }, null, 2))
  } catch {
    /* 注册失败不影响运行（最坏情况：退出时可能误停共享引擎） */
  }
}
// 注销本实例，返回仍存活的其它实例数（>0 表示共享引擎仍被其它实例使用，不应停止）
function unregisterEngineInstance() {
  const pids = loadEngineInstancePids().filter((p) => p !== process.pid && isPidAlive(p))
  try {
    fs.writeFileSync(engineInstancesFile(), JSON.stringify({ pids }, null, 2))
  } catch {
    /* 同上 */
  }
  return pids.length
}

app.on('before-quit', () => {
  isQuitting = true
  sseActive = false
  // 多实例共享引擎：仅当自己是最后一个存活实例时才停止引擎，否则其它 XWork 仍在使用共享服务
  if (unregisterEngineInstance() === 0) {
    engine?.stop()
  }
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
