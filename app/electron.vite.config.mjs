import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // ⚠ 这是一份【显式】入口清单：主进程模块只有列在这里才会被产出到 out/main/。
        // 新增 src/main/*.js 模块时必须同步加一行，否则运行时会报
        // "Cannot find module './xxx'" —— 0.6.4 打包曾因 agents-bridge/agents-selfcheck 漏登记而踩坑。
        input: {
          index: resolve(dir, 'src/main/index.js'),
          engine: resolve(dir, 'src/main/engine.js'),
          bridge: resolve(dir, 'src/main/bridge.js'),
          settings: resolve(dir, 'src/main/settings.js'),
          logger: resolve(dir, 'src/main/logger.js'),
          config: resolve(dir, 'src/main/config.js'),
          undo: resolve(dir, 'src/main/undo.js'),
          tasks: resolve(dir, 'src/main/tasks.js'),
          'task-runner': resolve(dir, 'src/main/task-runner.js'),
          'agents-bridge': resolve(dir, 'src/main/agents-bridge.js'),
          'agents-selfcheck': resolve(dir, 'src/main/agents-selfcheck.js'),
          'agents-list': resolve(dir, 'src/main/agents-list.js'),
          'engine-status': resolve(dir, 'src/main/engine-status.js'),
          'stats-core': resolve(dir, 'src/main/stats-core.js'),
          'stats-counters': resolve(dir, 'src/main/stats-counters.js')
        }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
