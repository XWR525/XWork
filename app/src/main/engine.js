// opencode V2 引擎进程管理：检测/启动/健康检查/退出监听
const { spawn, execSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { cfg } = require('./config')

const DEFAULT_PORT = cfg.enginePort

// V2 引擎强制 HTTP Basic Auth：用户名固定 opencode，密码用环境变量 OPENCODE_SERVER_PASSWORD 固定。
// 密码由 XDG 数据目录路径确定性派生（非随机）：同机多实例 / 应用重启后重连同一数据目录的引擎都能算出同一密码，
// 「端口已有健康服务则复用」逻辑得以保留；外部无关进程因密码不同而健康检查失败，仍走 killPortOwner 清理
function serverPasswordFor(xdgHome) {
  // 路径规范化后再派生：分隔符统一为 /、折叠重复分隔符、去尾斜杠、小写。
  // 同一数据目录的不同书写形式（D:\a\b / d:/a/b / D:\\a\\b / 带尾斜杠）必须得到同一密码，
  // 否则多实例复用与外部工具连接会 401（实测踩过）
  const norm = String(xdgHome || '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  const h = crypto.createHash('sha256').update('xwork-opencode-v2:' + norm).digest('base64url')
  return 'xw-' + h.slice(0, 32)
}

// Basic Auth 请求头值
function basicAuthHeader(password) {
  return 'Basic ' + Buffer.from('opencode:' + (password || '')).toString('base64')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 结束占用指定端口的进程（Windows：netstat 找 PID → taskkill）
// 用于「复用外部引擎」场景：应用启动时发现端口已有健康服务则复用（this.child 为 null，owned=false），
// 此时 stop() 无法直接结束进程；但端口占用者是明确的 —— 只有结束它，重启/退出后新进程才能以新环境变量真正启动
function killPortOwner(port) {
  let killed = 0
  try {
    const out = execSync(`netstat -ano -p tcp | findstr "127.0.0.1:${port} "`, {
      encoding: 'utf8',
      windowsHide: true
    })
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/LISTENING\s+(\d+)\s*$/)
      if (!m) continue
      try {
        execSync(`taskkill /F /PID ${m[1]}`, { stdio: 'ignore', windowsHide: true })
        killed++
      } catch {
        /* 进程可能已退出，忽略 */
      }
    }
  } catch {
    /* netstat 无匹配输出 */
  }
  return killed > 0
}

// 等待端口不再有健康服务（taskkill 后进程释放端口需要一点时间，避免紧随其后的 spawn 端口冲突）
function waitPortFree(port, timeoutMs = cfg.timings.portFreeTimeoutMs, password = '') {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = async () => {
      const h = await healthCheck(port, 400, password).catch(() => null)
      if (!h || !h.healthy) return resolve(true)
      if (Date.now() - start >= timeoutMs) return resolve(false)
      setTimeout(poll, 150)
    }
    poll()
  })
}

// 探测 opencode V2 可执行文件位置：打包版随应用分发 → 环境变量 → npm 全局安装目录
// V2 分发渠道为 npm 包 opencode2（平台二进制包 opencode2-windows-x64，bin/opencode2.exe）
// 候选列表单独成函数：探测失败时由构造函数打印到日志（界面报错只保留品牌文案，技术细节落日志）
function opencodeExeCandidates() {
  const cands = []
  // 打包版：引擎 exe 随安装包分发在应用 resources/engine 目录（extraResources，M8 换 V2 exe 后保持同名）
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'engine', 'opencode.exe'))
  if (process.env.XWORK_OPENCODE_PATH) cands.push(process.env.XWORK_OPENCODE_PATH)
  const npmRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules')
  cands.push(
    path.join(npmRoot, 'opencode2', 'node_modules', 'opencode2-windows-x64', 'bin', 'opencode2.exe'),
    path.join(npmRoot, 'opencode2-windows-x64', 'bin', 'opencode2.exe'),
    path.join(npmRoot, 'opencode2', 'bin', 'opencode2.exe')
  )
  return cands.filter(Boolean)
}

function findOpencodeExe() {
  for (const c of opencodeExeCandidates()) {
    if (fs.existsSync(c)) return c
  }
  return null
}

// 重定向 XDG 目录到应用数据目录（规避安全软件对用户目录写入的拦截）
// 注意 V2 目录布局：config/data/state 随 XDG 重定向（引擎在其下建 opencode2 子目录）；
// cache 不随 DATA/STATE 重定向，需显式设 XDG_CACHE_HOME，否则落在用户全局 ~/.cache
function xdgEnv(xdgHome) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(xdgHome, 'config'),
    XDG_STATE_HOME: path.join(xdgHome, 'state'),
    XDG_DATA_HOME: path.join(xdgHome, 'data'),
    XDG_CACHE_HOME: path.join(xdgHome, 'cache')
  }
  // 内置 git（MinGit，随包分发在 resources/git）：存在则注入 PATH 最前。
  // 引擎的快照/撤销依赖 git 命令（实测：PATH 无 git 时 revert 静默失败），
  // 内置后回退功能开箱即用，不依赖用户机器安装 git
  const builtin = builtinGitDir()
  if (builtin) {
    // Windows 上 {...process.env} 是普通对象，键名大小写敏感：实际键可能是 Path/PATH/path，
    // 必须按实际键名读取与回写，否则 env.PATH 读取恒为 undefined（原系统 PATH 被整段丢弃），
    // 且赋值会产生与原键重复的环境变量，子进程解析到仅含内置 Git 的坏 PATH
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path'
    env[key] = [path.join(builtin, 'cmd'), path.join(builtin, 'mingw64', 'bin'), ...(env[key] || '').split(';').filter(Boolean)].join(';')
  }
  return env
}

// 内置 git 根目录（resources/git，需含 cmd/git.exe）；开发环境未打包时不存在则返回 null
function builtinGitDir() {
  if (!process.resourcesPath) return null
  const dir = path.join(process.resourcesPath, 'git')
  return fs.existsSync(path.join(dir, 'cmd', 'git.exe')) ? dir : null
}

// 当前可用的 git 可执行文件：优先内置 MinGit，其次系统 git（PATH）；均不可用返回 null
function findGit() {
  const builtin = builtinGitDir()
  if (builtin) return path.join(builtin, 'cmd', 'git.exe')
  try {
    const out = execSync('git --version', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.startsWith('git version') ? 'git' : null
  } catch {
    return null
  }
}

// 健康检查：V2 为 GET /api/info（需 Basic Auth），须校验响应体确为 V2 info JSON。
// 关键：老引擎（如 1.18.x）虽无 /api/info 路由，但未匹配路由会回退成 Web UI 的 HTML 且 HTTP 200，
// 若不校验载荷会把「别的引擎」误判为健康而直接复用（实测踩坑：dev 复用了安装版 V1 引擎）
async function healthCheck(port, timeoutMs = cfg.timings.engineHealthTimeoutMs, password = '') {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers = {}
    if (password) headers.Authorization = basicAuthHeader(password)
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: ctrl.signal, headers })
    if (!res.ok) return null
    const ct = String(res.headers.get('content-type') || '')
    if (!ct.includes('json')) return null // HTML 回退页 = 该服务不是 V2 引擎
    const body = await res.json()
    if (!body || typeof body !== 'object' || typeof body.version !== 'string') return null
    return { healthy: true, version: body.version }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

class Engine {
  constructor(opts = {}) {
    this.port = opts.port || DEFAULT_PORT
    this.xdgHome = opts.xdgHome
    this.exe = opts.exePath || findOpencodeExe()
    this.extraEnv = opts.extraEnv || null // 额外环境变量（模型 API Key 等）
    this.cwd = opts.cwd || null // 工作区目录（null = 尚未选择工作区，禁止启动引擎）
    this.password = opts.serverPassword || serverPasswordFor(opts.xdgHome || '') // Basic Auth 密码（确定性派生，见 serverPasswordFor）
    this.child = null
    this.owned = false
    this.onExit = opts.onExit || null
  }

  // 记录「当前工作区」：V2 下引擎进程的启动目录（cwd）只是默认 location，
  // 会话创建时会显式带上 location.directory（见 bridge.createSession），因此切换工作区不再需要换进程。
  // 仅在引擎未运行时（崩溃/首次启动）由 doStart 使用该 cwd 作为新进程的启动目录。
  setCwd(dir) {
    this.cwd = dir || null
  }

  // 当前工作区（会话归属目录；可能不等于引擎进程的启动目录）
  // 未选择时必须返回 null：绝不能回退 process.cwd()（打包后即安装目录），
  // 否则会话会以安装目录为 location，AI 可直接改写程序文件。
  workspace() {
    return this.cwd || null
  }

  async status() {
    const h = await healthCheck(this.port, cfg.timings.engineHealthTimeoutMs, this.password)
    if (h && h.healthy) {
      return { running: true, version: h.version, port: this.port, owned: this.owned, workspace: this.workspace() }
    }
    return { running: false, version: null, port: this.port, owned: false, workspace: this.workspace() }
  }

  // 若端口已有健康服务则复用；否则拉起新进程
  // force=true：跳过「端口已有健康服务则复用」，强制拉起新进程。
  // 现主要用于「保存设置需要新环境变量（模型 Key）」「引擎端口变更」「显式重启」等场景；
  // 切换工作区已不再依赖换进程（V2 location + 配置热重载，见 index.js workspace:switch）
  // 启动互斥：app 初始化与渲染进程 engine:start 可能并发调用，避免重复 spawn 两个进程争抢同一端口
  start({ force = false } = {}) {
    if (this._starting) return this._starting
    const p = this.doStart(force)
    this._starting = p
    p.then(
      () => { if (this._starting === p) this._starting = null },
      () => { if (this._starting === p) this._starting = null }
    )
    return p
  }

  async doStart(force) {
    console.log('[engine] start() force=', force, 'cwd=', this.cwd, 'child=', this.child?.pid || null)
    // 无工作区不拉起引擎：spawn 的 cwd 会继承主进程目录（安装目录），
    // 引擎默认 location 随之指向安装目录，后续所有无 location 的操作都可能写坏程序文件。
    if (!this.cwd) throw new Error('请先选择工作区')
    if (!force) {
      const existing = await healthCheck(this.port, 2000, this.password)
      if (existing && existing.healthy) {
        console.log('[engine] start(): reusing healthy engine (no restart)')
        this.owned = false
        return await this.status()
      }
    }
    if (!this.exe) {
      // 界面只给品牌文案（「XWork 执行引擎」），不含第三方引擎名称；
      // 排障所需的技术细节（逐个查找过的路径、环境变量名）落到 main.log
      console.error('[engine] 执行引擎可执行文件未找到，已查找以下路径：')
      for (const c of opencodeExeCandidates()) console.error('[engine]   - ' + c)
      console.error('[engine] 提示：可安装 opencode2（npm i -g opencode2），或用环境变量 XWORK_OPENCODE_PATH 指定可执行文件')
      throw new Error('XWork 执行引擎未找到\n请检查安装是否完整，或查看日志目录获取详细信息')
    }
    // 回收残留 child（并发启动冲突进程等），避免多个 opencode 争抢端口
    if (this.child) {
      console.log('[engine] start(): cleaning stale child pid=', this.child.pid)
      await this.stop()
    }
    for (const d of ['config', 'state', 'data', 'cache']) {
      fs.mkdirSync(path.join(this.xdgHome, d), { recursive: true })
    }
    // cwd 不存在时 Windows 上 spawn 抛 ENOENT（错误对象指向 exe 路径，极易误导为引擎缺失）：
    // 前置校验并给出明确错误，方便定位
    if (this.cwd && !fs.existsSync(this.cwd)) {
      throw new Error('工作区目录不存在: ' + this.cwd)
    }
    // 端口预清理：走到这里说明端口健康检查（含密码）未通过，占用者必非本应用可用引擎
    // （残留 V1 引擎 / 异密码 V2 引擎 / 无关进程）。V2 强制认证后无法像 V1 那样直接复用外部引擎，
    // 不清理则新进程 EADDRINUSE 退出 → 白白等满启动超时
    if (killPortOwner(this.port)) {
      console.log('[engine] start(): killed foreign/stale port owner before spawn')
      await waitPortFree(this.port, cfg.timings.portFreeTimeoutMs, this.password)
    }
    // 额外环境变量（模型 API Key 等）只在 spawn 时生效：记录「本次注入的变量名 + 值指纹」，
    // 供配置热重载判定「该改动能否热生效」——新增/更换 Key 必须重启进程才能生效（见 index.js tryHotReload）
    const extraEnvVars = this.extraEnv ? this.extraEnv() : {}
    this.envFingerprint = {}
    for (const [k, v] of Object.entries(extraEnvVars)) {
      this.envFingerprint[k] = crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 16)
    }
    const child = spawn(
      this.exe,
      ['serve', '--port', String(this.port), '--hostname', '127.0.0.1'],
      {
        cwd: this.cwd, // 工作区 = 引擎启动目录（opencode 项目根）；doStart 已保证非空
        env: {
          ...xdgEnv(this.xdgHome),
          // V2 强制 Basic Auth：固定密码（与 bridge 共用，见 serverPasswordFor）
          OPENCODE_SERVER_PASSWORD: this.password,
          ...extraEnvVars
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // detached：引擎脱离本实例进程树/job（Windows 上 libuv 同时带 CREATE_BREAKAWAY_FROM_JOB）。
        // 多实例共享引擎时，任一实例退出都不会连带终止引擎；引擎生命周期只由「最后一个实例退出」显式 stop 控制
        detached: true
      }
    )
    child.unref() // 父进程退出不等待引擎（引擎存亡由端口健康检查与显式 stop 管理）
    this.child = child
    this.owned = true
    console.log('[engine] start(): spawned new process pid=', child.pid, 'cwd=', this.cwd)
    // spawn 失败（如 exe 权限/路径问题）不会触发 'exit'，需监听 'error' 及时感知，避免 pid=undefined 后空等超时
    child.on('error', (err) => {
      console.error('[engine] spawn error:', err.message)
    })
    let outBuf = ''
    child.stdout?.on('data', (d) => (outBuf += d))
    child.stderr?.on('data', (d) => (outBuf += d))
    // exit 回调只在自己仍是当前 child 时才清引用（避免并发冲突进程退出时误清真正服务的进程）
    child.on('exit', (code, sig) => {
      console.log('[engine] child exited pid=', child.pid, 'code=', code, 'sig=', sig)
      if (this.child === child) this.child = null
      if (this.onExit) this.onExit(code)
    })
    const startDeadline = Date.now() + cfg.timings.engineStartTimeoutMs
    while (Date.now() < startDeadline) {
      await sleep(500)
      const h = await healthCheck(this.port, 1000, this.password)
      if (h && h.healthy) return await this.status()
    }
    // 界面只给品牌文案；启动期 stdout/stderr 全文（含第三方引擎名称与错误）落日志，便于排障
    console.error('[engine] 执行引擎启动超时，进程输出如下：\n' + outBuf.slice(-4000))
    throw new Error('XWork 执行引擎启动超时\n请检查引擎是否被安全软件拦截，或查看日志目录获取详细信息')
  }

  // 停止引擎并等待进程真正退出。Windows 上 kill() 是异步终止，必须等 'exit' 事件，
  // 否则紧随其后的 start() 会因旧进程仍占端口而命中健康检查直接复用（cwd 不会生效）
  async stop(timeoutMs = cfg.timings.engineStopTimeoutMs) {
    const child = this.child
    console.log('[engine] stop() child=', child?.pid || null)
    if (!child) {
      // 复用引擎（非自启）场景：无自有 child 可结束，但端口占用者是明确的 —— 结束它，
      // 否则后续 force 重启 / 退出后旧进程仍以旧环境变量（旧 key）占着端口，新配置无法生效
      const killed = killPortOwner(this.port)
      console.log('[engine] stop(): no own child, killed port owner=', killed)
      if (killed) await waitPortFree(this.port, cfg.timings.portFreeTimeoutMs, this.password)
      return
    }
    this.child = null
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)))
    try {
      child.kill()
      console.log('[engine] stop(): sent kill to pid=', child.pid)
    } catch (e) {
      console.log('[engine] stop(): kill threw', e.message)
    }
    const exitedOk = await Promise.race([exited, sleep(timeoutMs).then(() => false)])
    if (!exitedOk) {
      // 超时兜底：强制结束（Windows 下与 TerminateProcess 等效）
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      await Promise.race([exited, sleep(cfg.timings.engineKillWaitMs)])
    }
  }
}

module.exports = { Engine, findOpencodeExe, healthCheck, serverPasswordFor, basicAuthHeader, DEFAULT_PORT, findGit }
