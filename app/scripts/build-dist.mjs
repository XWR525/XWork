// 一键打包脚本：构建渲染层 → 准备引擎与图标 → electron-builder 产出 NSIS 安装包
// 用法：npm run build:dist
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 国内网络：electron / NSIS 等二进制一律走 npmmirror 镜像（不依赖 GitHub/代理）
// 已存在环境变量则不覆盖（允许显式指定其它镜像或代理场景）
if (!process.env.ELECTRON_MIRROR) process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR)
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'

const run = (cmd, args, label) => {
  console.log('\n==> ' + label)
  const r = spawnSync(cmd, args, { cwd: appDir, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error('!! ' + label + ' 失败，中止打包')
    process.exit(r.status ?? 1)
  }
}

// 同步等待（主线程可用 Atomics.wait 阻塞）
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// 删除目录；Windows 下文件被占用会抛 EBUSY/EPERM，这里等待锁释放并重试，
// 避免 electron-builder 清理旧产物时因文件被占用（如 IDE/资源管理器预览）直接失败
function rmRetry(dir, { attempts = 30, delayMs = 1000 } = {}) {
  if (!fs.existsSync(dir)) return
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      if (i === attempts) {
        console.error('!! 无法删除 ' + dir + '：' + e.code + ' ' + e.message)
        console.error('   该目录正被其它进程占用（常见：正在运行的 XWork/electron、资源管理器、编辑器预览）。请关闭相关程序后重试。')
        process.exit(1)
      }
      console.log('==> ' + dir + ' 正被占用，' + (delayMs / 1000) + 's 后重试 (' + i + '/' + attempts + ')：' + e.code)
      sleep(delayMs)
    }
  }
}

// 1. 构建渲染层/主进程/预加载（electron-vite build → out/）
run('npx', ['electron-vite', 'build'], '构建 out/（electron-vite build）')

// 2. 生成应用图标（存在则跳过）
const ico = path.join(appDir, 'build', 'icon.ico')
if (!fs.existsSync(ico)) {
  run('node', ['scripts/gen-icons.mjs'], '生成应用图标 build/icon.ico')
} else {
  console.log('==> 图标已存在，跳过生成:', ico)
}

// 3. 探测并复制 opencode V2 引擎（opencode2.exe）到 resources/engine/opencode.exe（随安装包分发）
// 说明：V2 分发渠道为 npm 包 opencode2（平台包 opencode2-windows-x64）；V1（opencode-ai）不兼容
// 迁移后的代码（V2 专属 API/认证），故这里只接受 V2，并在复制后校验版本号
//
// npm 全局根必须用 `npm root -g` 查询，不能硬编码 %APPDATA%\npm\node_modules：
// nvm4w / volta / 自定义 prefix 下全局包不在那里（实测本机 npm root -g = C:\nvm4w\nodejs\node_modules，
// 硬编码路径导致"装了 opencode2 也找不到"）。
function npmGlobalRoots() {
  const roots = []
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, timeout: 30000 })
    const p = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()
    if (p && fs.existsSync(p)) roots.push(p)
  } catch {
    /* npm 不可用时退到下面的兼容候选 */
  }
  roots.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules')) // 传统前缀，兼容保留
  return roots.filter(Boolean)
}

function findOpencodeExe() {
  const cands = []
  if (process.env.XWORK_OPENCODE_PATH) cands.push(process.env.XWORK_OPENCODE_PATH)
  for (const root of npmGlobalRoots()) {
    cands.push(
      path.join(root, 'opencode2', 'node_modules', 'opencode2-windows-x64', 'bin', 'opencode2.exe'),
      path.join(root, 'opencode2-windows-x64', 'bin', 'opencode2.exe'),
      path.join(root, 'opencode2', 'bin', 'opencode2.exe')
    )
  }
  // 复用上次打包留下的引擎（resources/engine/opencode.exe 已 gitignore、本机常驻）：
  // 与下方 MinGit 的"已存在即复用"一致，避免全局包被卸载/换机后完全无法打包（仍需通过 V2 版本校验）
  cands.push(path.join(appDir, 'resources', 'engine', 'opencode.exe'))
  for (const c of cands) if (c && fs.existsSync(c)) return c
  return null
}
const srcExe = findOpencodeExe()
if (!srcExe) {
  console.error('!! 未找到 opencode V2 引擎（opencode2.exe）')
  console.error('   已查找：XWORK_OPENCODE_PATH → npm 全局根（' + (npmGlobalRoots()[0] || '未取到') + '）→ %APPDATA%\\npm\\node_modules → resources/engine/opencode.exe')
  console.error('   安装：npm i -g opencode2 --registry=https://registry.npmmirror.com')
  console.error('   或设置环境变量 XWORK_OPENCODE_PATH 指向 opencode2.exe')
  process.exit(1)
}
// 版本校验：必须是 V2（V1 引擎缺少 /api/info、强制认证与异步 prompt 语义，随包分发会导致应用不可用）
function engineVersion(exe) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  return String(r.stdout || r.stderr || '').trim().split(/\s+/).pop() || ''
}
const ver = engineVersion(srcExe)
if (!/^v?2\./.test(ver)) {
  console.error(`!! 引擎版本非 V2（检测到 "${ver || '未知'}"）：${srcExe}`)
  console.error('   请安装 opencode2（V2）后重试：npm i -g opencode2 --registry=https://registry.npmmirror.com')
  process.exit(1)
}
const dstDir = path.join(appDir, 'resources', 'engine')
fs.mkdirSync(dstDir, { recursive: true })
const dstExe = path.join(dstDir, 'opencode.exe')
// 当来源就是 resources/engine/opencode.exe（复用分支）时必须跳过复制：
// copyFileSync 同路径自拷贝会把文件截断为 0 字节，之后 196MB 的引擎就废了
if (path.resolve(srcExe) === path.resolve(dstExe)) {
  console.log('==> 引擎来源即现有 resources/engine/opencode.exe，跳过复制（避免同路径自拷贝截断）')
} else {
  fs.copyFileSync(srcExe, dstExe)
}
const sizeMB = Math.round(fs.statSync(dstExe).size / 1024 / 1024)
console.log(`==> opencode V2 引擎已复制（${ver.startsWith('v') ? ver : 'v' + ver}，${sizeMB} MB）: ${srcExe} → ${dstExe}`)
console.log('    注意：V2 引擎体积明显大于 V1（196 MB vs 约 100 MB），安装包会相应增大，发版说明需告知')
if (ver !== engineVersion(dstExe)) {
  console.error('!! 复制后引擎版本校验不一致，打包中止')
  process.exit(1)
}

// 3.5 内置 MinGit（resources/git）：引擎的快照/撤销依赖 git 命令（实测 PATH 无 git 时 revert 静默失败），
// 随包内置后 undo 功能开箱即用、不依赖用户机器安装 git。固定版本避免漂移。
const MINGIT_VERSION = '2.55.0'
const gitDir = path.join(appDir, 'resources', 'git')
const gitExe = path.join(gitDir, 'cmd', 'git.exe')
if (fs.existsSync(gitExe)) {
  console.log('==> 内置 MinGit 已存在，跳过下载:', gitExe)
} else {
  // 镜像优先（国内网络），GitHub 回退；带超时与进度输出，避免长时间无反馈地挂起
  const urls = [
    `https://registry.npmmirror.com/-/binary/git-for-windows/v${MINGIT_VERSION}.windows.1/MinGit-${MINGIT_VERSION}-64-bit.zip`,
    `https://github.com/git-for-windows/git/releases/download/v${MINGIT_VERSION}.windows.1/MinGit-${MINGIT_VERSION}-64-bit.zip`
  ]
  const tmpZip = path.join(appDir, 'build', `MinGit-${MINGIT_VERSION}.zip`)
  console.log(`==> 下载 MinGit ${MINGIT_VERSION} → resources/git（引擎撤销功能依赖）`)
  let buf = null
  for (const url of urls) {
    try {
      console.log('    源: ' + url.replace(/^https:\/\//, ''))
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const total = Number(res.headers.get('content-length') || 0)
      const reader = res.body.getReader()
      const chunks = []
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        got += value.length
        if (total) process.stdout.write(`\r    已下载 ${(got / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB`)
      }
      process.stdout.write('\n')
      buf = Buffer.concat(chunks)
      break
    } catch (e) {
      console.log('    ' + url.replace(/^https:\/\//, '') + ' 下载失败，切换下一源: ' + e.message)
    }
  }
  if (!buf) throw new Error('全部下载源失败')
  fs.mkdirSync(path.dirname(tmpZip), { recursive: true })
  fs.writeFileSync(tmpZip, buf)
  console.log('==> MinGit zip 已下载: ' + Math.round(buf.length / 1024 / 1024) + ' MB')
  // Windows 自带 bsdtar 可解压 zip，比纯 JS 解压快得多；先清空目录避免残留不完整内容
  fs.rmSync(gitDir, { recursive: true, force: true })
  fs.mkdirSync(gitDir, { recursive: true })
  const r = spawnSync('tar', ['-xf', tmpZip, '-C', gitDir], { stdio: 'inherit' })
  fs.unlinkSync(tmpZip)
  if (r.status !== 0 || !fs.existsSync(gitExe)) throw new Error('解压后未找到 cmd/git.exe')
  console.log('==> MinGit 已解压到 resources/git (' + Math.round(fs.statSync(gitExe).size / 1024 / 1024) + ' MB 解压目录)')
}

// 3.75 清理上次构建产物（旧文件被占用时等待锁释放，避免 electron-builder EBUSY 失败）
// 输出目录可用 XWORK_OUT_DIR 覆盖（相对 app/ 或绝对路径）：便于在不破坏 release/ 现有产物的前提下
// 验证打包流程（如本次修引擎探测时的一次性端到端校验）。默认仍是 release/。
const outDir = process.env.XWORK_OUT_DIR ? path.resolve(appDir, process.env.XWORK_OUT_DIR) : path.join(appDir, 'release')
rmRetry(outDir)

// 4. electron-builder 产出 NSIS 安装包（产物在 outDir）
// 默认 --publish never：本地构建不上传 GitHub Release（避免 CI 检测触发隐式发布而要求 GH_TOKEN）；
// latest.yml 更新元数据仍会生成。发布到 GitHub 时设置环境变量 XWORK_PUBLISH=always（并配置 GH_TOKEN）
const publishFlag = process.env.XWORK_PUBLISH === 'always' ? 'always' : 'never'
run(
  'npx',
  [
    'electron-builder',
    '--win',
    'nsis',
    '--publish',
    publishFlag,
    ...(process.env.XWORK_OUT_DIR ? ['--config.directories.output=' + outDir] : [])
  ],
  'electron-builder 打包（首次会下载 Electron/NSIS，需联网）'
)

console.log('\n==> 打包完成，安装包位于 ' + outDir)
