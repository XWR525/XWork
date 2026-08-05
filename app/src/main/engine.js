// opencode 引擎进程管理：检测/启动/健康检查/退出监听
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PORT = 4096

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 探测 opencode 可执行文件位置：打包版随应用分发 → 环境变量 → npm 全局安装目录
function findOpencodeExe() {
  const cands = []
  // 打包版：opencode.exe 随安装包分发在应用 resources/engine 目录（extraResources）
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'engine', 'opencode.exe'))
  if (process.env.XWORK_OPENCODE_PATH) cands.push(process.env.XWORK_OPENCODE_PATH)
  const npmRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules')
  cands.push(
    path.join(npmRoot, 'opencode-ai', 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'),
    path.join(npmRoot, 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(npmRoot, 'opencode-ai', 'opencode.exe')
  )
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

// 重定向 XDG 目录到应用数据目录（规避安全软件对用户目录写入的拦截）
function xdgEnv(xdgHome) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: path.join(xdgHome, 'config'),
    XDG_STATE_HOME: path.join(xdgHome, 'state'),
    XDG_DATA_HOME: path.join(xdgHome, 'data')
  }
}

async function healthCheck(port, timeoutMs = 1500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
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
    this.cwd = opts.cwd || null // 工作区目录（null = 继承主进程启动目录）
    this.child = null
    this.owned = false
    this.onExit = opts.onExit || null
  }

  // 切换工作区目录（配合 stop + start 生效）
  setCwd(dir) {
    this.cwd = dir || null
  }

  // 当前工作区：显式目录或默认启动目录
  workspace() {
    return this.cwd || process.cwd()
  }

  async status() {
    const h = await healthCheck(this.port)
    if (h && h.healthy) {
      return { running: true, version: h.version, port: this.port, owned: this.owned, workspace: this.workspace() }
    }
    return { running: false, version: null, port: this.port, owned: false, workspace: this.workspace() }
  }

  // 若端口已有健康服务则复用；否则拉起新进程
  // force=true：跳过「端口已有健康服务则复用」，强制拉起新进程（切换工作区必须换进程，cwd 是进程级属性）
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
    if (!force) {
      const existing = await healthCheck(this.port, 2000)
      if (existing && existing.healthy) {
        console.log('[engine] start(): 复用已有健康引擎（未重启）')
        this.owned = false
        return await this.status()
      }
    }
    if (!this.exe) {
      throw new Error('未找到 opencode 可执行文件，请设置环境变量 XWORK_OPENCODE_PATH 指向 opencode.exe')
    }
    // 回收残留 child（并发启动冲突进程等），避免多个 opencode 争抢端口
    if (this.child) {
      console.log('[engine] start(): 清理残留 child pid=', this.child.pid)
      await this.stop()
    }
    for (const d of ['config', 'state', 'data']) {
      fs.mkdirSync(path.join(this.xdgHome, d), { recursive: true })
    }
    const child = spawn(
      this.exe,
      ['serve', '--port', String(this.port), '--hostname', '127.0.0.1'],
      {
        cwd: this.cwd || undefined, // 工作区 = 引擎启动目录（opencode 项目根）
        env: { ...xdgEnv(this.xdgHome), ...(this.extraEnv ? this.extraEnv() : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    this.child = child
    this.owned = true
    console.log('[engine] start(): 已 spawn 新进程 pid=', child.pid, 'cwd=', this.cwd)
    let outBuf = ''
    child.stdout?.on('data', (d) => (outBuf += d))
    child.stderr?.on('data', (d) => (outBuf += d))
    // exit 回调只在自己仍是当前 child 时才清引用（避免并发冲突进程退出时误清真正服务的进程）
    child.on('exit', (code, sig) => {
      console.log('[engine] 子进程退出 pid=', child.pid, 'code=', code, 'sig=', sig)
      if (this.child === child) this.child = null
      if (this.onExit) this.onExit(code)
    })
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      const h = await healthCheck(this.port, 1000)
      if (h && h.healthy) return await this.status()
    }
    throw new Error('opencode 启动超时\n' + outBuf.slice(-1500))
  }

  // 停止引擎并等待进程真正退出。Windows 上 kill() 是异步终止，必须等 'exit' 事件，
  // 否则紧随其后的 start() 会因旧进程仍占端口而命中健康检查直接复用（cwd 不会生效）
  async stop(timeoutMs = 5000) {
    const child = this.child
    console.log('[engine] stop() child=', child?.pid || null)
    if (!child) return
    this.child = null
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)))
    try {
      child.kill()
      console.log('[engine] stop(): 已发送 kill 给 pid=', child.pid)
    } catch (e) {
      console.log('[engine] stop(): kill 抛错', e.message)
    }
    const exitedOk = await Promise.race([exited, sleep(timeoutMs).then(() => false)])
    if (!exitedOk) {
      // 超时兜底：强制结束（Windows 下与 TerminateProcess 等效）
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      await Promise.race([exited, sleep(2000)])
    }
  }
}

module.exports = { Engine, findOpencodeExe, healthCheck, DEFAULT_PORT }
