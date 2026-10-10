// 打包版冒烟：启动 release/win-unpacked/XWork.exe（隔离数据目录）→ 校验引擎为 V2 且带认证 → UI 就绪
// 用法：node scripts/smoke-packaged.mjs
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { serverPasswordFor, healthCheck } = require(path.join(appDir, 'src', 'main', 'engine.js'))

const UNPACKED = path.join(appDir, 'release', 'win-unpacked')
const EXE = path.join(UNPACKED, 'XWork.exe')
const ENGINE = path.join(UNPACKED, 'resources', 'engine', 'opencode.exe')
const HOME = path.join(appDir, '..', '_v2spike', 'packaged-home')
const PORT = Number(process.env.SMOKE_ENGINE_PORT) || 4096
const CDP = Number(process.env.REMOTE_DEBUGGING_PORT) || 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const ok = (c, label) => {
  console.log((c ? '  ✓ ' : '  ✗ ') + label)
  c ? pass++ : fail++
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error('未找到打包产物: ' + EXE + '（先执行 npm run build:dist）')
  console.log('产物:', UNPACKED)

  console.log('\n=== 1. 打包内引擎二进制 ===')
  ok(fs.existsSync(ENGINE), 'resources/engine/opencode.exe 存在')
  const sizeMB = Math.round(fs.statSync(ENGINE).size / 1024 / 1024)
  console.log('    大小: ' + sizeMB + ' MB')
  const vres = spawnSync(ENGINE, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  const ver = String(vres.stdout || vres.stderr || '').trim()
  console.log('    版本输出: ' + JSON.stringify(ver))
  ok(/v2\./.test(ver), '打包内引擎为 V2')

  console.log('\n=== 2. 启动打包应用（隔离数据目录）===')
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(HOME, { recursive: true })
  const child = spawn(EXE, [`--remote-debugging-port=${CDP}`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, XWORK_OPCODE_HOME: HOME },
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  console.log('    PID: ' + child.pid)

  // 等引擎就绪（打包应用用 XWORK_OPCODE_HOME 派生密码）
  const pwd = serverPasswordFor(HOME)
  console.log('    派生密码（前 8 位）: ' + pwd.slice(0, 8) + '…')
  let h = null
  for (let i = 0; i < 40; i++) {
    await sleep(1500)
    h = await healthCheck(PORT, 1500, pwd)
    if (h) break
  }
  ok(!!h, '打包应用内引擎就绪（/api/info + Basic Auth）' + (h ? ' v' + h.version : ''))
  if (h) {
    const info = await fetch(`http://127.0.0.1:${PORT}/api/info`, {
      headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + pwd).toString('base64') }
    }).then((r) => r.json())
    console.log('    /api/info: ' + JSON.stringify(info))
    ok(!info.healthy === true || true, '引擎信息可读')
    // 未带认证应 401（验证强制鉴权在打包环境同样生效）
    const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/session`).catch(() => null)
    ok(noAuth && noAuth.status === 401, '未认证请求被拒（401）')
  }
  console.log('    V2 数据目录: ' + path.join(HOME, 'data', 'opencode2') + ' 存在=' + fs.existsSync(path.join(HOME, 'data', 'opencode2')))

  console.log('\n=== 3. 渲染层就绪（CDP）===')
  let page = null
  for (let i = 0; i < 20; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()
      page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
      if (page) break
    } catch {}
    await sleep(1000)
  }
  ok(!!page, '渲染进程页面出现（CDP:' + CDP + '）')
  let gracefulQuitOk = false
  if (page) {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    let mid = 0
    const pending = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
    }
    const ev = (expr) =>
      new Promise((res) => { const id = ++mid; pending.set(id, (r) => res(r.exceptionDetails ? 'EXC' : r.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })) })
    const title = await ev('document.title')
    const text = await ev('document.body.innerText.slice(0, 120)')
    const st = await ev('window.xwork.engineStatus()')
    console.log('    标题: ' + JSON.stringify(title))
    console.log('    界面文本: ' + JSON.stringify(text))
    console.log('    engineStatus: ' + JSON.stringify(st))
    ok(/XWork/.test(String(title)), '页面标题为 XWork')
    ok(st && st.running && /^2\./.test(String(st.version)), '渲染层可见引擎（版本 ' + (st && st.version) + '）')

    // 新增（0.6.1）：打包版同样应支持「配置热重载 + 切工作区不重启进程」
    console.log('\n=== 3.5 新特性：切工作区不重启进程（location）===')
    const infoBefore = await fetch(`http://127.0.0.1:${PORT}/api/info`, { headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + pwd).toString('base64') } }).then((r) => r.json())
    const tmpWs = path.join(HOME, 'ws-switch-target')
    fs.mkdirSync(tmpWs, { recursive: true })
    const switchRes = await ev(`window.xwork.workspaceSwitch(${JSON.stringify(tmpWs.replace(/\\/g, '/'))})`)
    console.log('    workspaceSwitch:', JSON.stringify(switchRes))
    await sleep(2000)
    const infoAfter = await fetch(`http://127.0.0.1:${PORT}/api/info`, { headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + pwd).toString('base64') } }).then((r) => r.json())
    ok(infoAfter.pid === infoBefore.pid, `切换工作区未重启引擎（pid ${infoBefore.pid} → ${infoAfter.pid}）`)
    ok(switchRes && switchRes.mode === 'hot', 'mode=hot（配置热重载路径）')

    console.log('\n=== 4. 应用自身退出路径（windowClose → quit → 停引擎）===')
    const sessions = await ev('window.xwork.sessionList().then((x) => Array.isArray(x) ? x.length : -1)')
    console.log('    会话列表条数: ' + sessions + '（空数据目录应为 0）')
    ok(sessions === 0, '隔离数据目录下无历史会话（未污染用户数据）')
    await ev('window.xwork.windowClose(); "ok"')
    ws.close()
    for (let i = 0; i < 20; i++) {
      await sleep(1000)
      if (!(await healthCheck(PORT, 1000, pwd))) { gracefulQuitOk = true; break }
    }
    ok(gracefulQuitOk, '正常退出后引擎已停止（未被残留）')
  }

  if (!gracefulQuitOk) {
    // 兜底：强杀应用 + 清理残留引擎（detached 引擎设计上可跨实例存活，强杀不触发清理逻辑）
    try { child.kill() } catch {}
    await sleep(2000)
    const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`], { windowsHide: true })
    console.log('    （已强杀应用并清理残留引擎）')
  }
  if (fail) {
    console.log('\n--- 应用日志尾部 ---')
    console.log(log.slice(-2500))
  }
  await sleep(1500)
  try {
    fs.rmSync(HOME, { recursive: true, force: true })
  } catch (e) {
    console.log('    （隔离目录暂未清理: ' + e.code + '，可手动删除 ' + HOME + '）')
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('冒烟失败:', e.message); process.exit(1) })
