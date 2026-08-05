// 开发启动入口：固化引擎数据目录（.opencode-home）与调试端口
// 用法：npm run dev
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = path.resolve(appDir, '..', '.opencode-home')

const child = spawn('npx', ['electron-vite', 'dev'], {
  cwd: appDir,
  env: {
    ...process.env,
    XWORK_OPCODE_HOME: home,
    REMOTE_DEBUGGING_PORT: '9222' // 供 e2e 验收脚本连接
  },
  stdio: 'inherit',
  shell: true
})

child.on('exit', (code) => process.exit(code ?? 0))
