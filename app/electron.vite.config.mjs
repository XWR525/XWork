import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(dir, 'src/main/index.js'),
          engine: resolve(dir, 'src/main/engine.js'),
          bridge: resolve(dir, 'src/main/bridge.js'),
          settings: resolve(dir, 'src/main/settings.js'),
          logger: resolve(dir, 'src/main/logger.js'),
          config: resolve(dir, 'src/main/config.js')
        }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
