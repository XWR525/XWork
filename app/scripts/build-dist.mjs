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

// 4. electron-builder 产出 NSIS 安装包（产物在 release/）
run('npx', ['electron-builder', '--win', 'nsis'], 'electron-builder 打包（首次会下载 Electron/NSIS，需联网）')

console.log('\n==> 打包完成，安装包位于 app/release/')
