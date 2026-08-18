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

// 1. 构建渲染层/主进程/预加载（electron-vite build → out/）
run('npx', ['electron-vite', 'build'], '构建 out/（electron-vite build）')

// 2. 生成应用图标（存在则跳过）
const ico = path.join(appDir, 'build', 'icon.ico')
if (!fs.existsSync(ico)) {
  run('node', ['scripts/gen-icon.mjs'], '生成应用图标 build/icon.ico')
} else {
  console.log('==> 图标已存在，跳过生成:', ico)
}

// 3. 探测并复制 opencode.exe 到 resources/engine（随安装包分发）
function findOpencodeExe() {
  const cands = []
  if (process.env.XWORK_OPENCODE_PATH) cands.push(process.env.XWORK_OPENCODE_PATH)
  const npmRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules')
  cands.push(
    path.join(npmRoot, 'opencode-ai', 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'),
    path.join(npmRoot, 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(npmRoot, 'opencode-ai', 'opencode.exe')
  )
  for (const c of cands) if (c && fs.existsSync(c)) return c
  return null
}
const srcExe = findOpencodeExe()
if (!srcExe) {
  console.error('!! 未找到 opencode.exe，请设置环境变量 XWORK_OPENCODE_PATH 指向 opencode.exe')
  process.exit(1)
}
const dstDir = path.join(appDir, 'resources', 'engine')
fs.mkdirSync(dstDir, { recursive: true })
const dstExe = path.join(dstDir, 'opencode.exe')
fs.copyFileSync(srcExe, dstExe)
console.log('==> opencode.exe 已复制: ' + srcExe + ' → ' + dstExe + ' (' + Math.round(fs.statSync(dstExe).size / 1024 / 1024) + ' MB)')

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

// 4. electron-builder 产出 NSIS 安装包（产物在 release/）
// 默认 --publish never：本地构建不上传 GitHub Release（避免 CI 检测触发隐式发布而要求 GH_TOKEN）；
// latest.yml 更新元数据仍会生成。发布到 GitHub 时设置环境变量 XWORK_PUBLISH=always（并配置 GH_TOKEN）
const publishFlag = process.env.XWORK_PUBLISH === 'always' ? 'always' : 'never'
run('npx', ['electron-builder', '--win', 'nsis', '--publish', publishFlag], 'electron-builder 打包（首次会下载 Electron/NSIS，需联网）')

console.log('\n==> 打包完成，安装包位于 app/release/')
