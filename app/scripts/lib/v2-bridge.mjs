// V2 引擎测试客户端（ESM 包装）：复用主进程 Bridge（自动 Basic Auth + /api 路径 + V1 形状归一化输出）
// 用法：
//   import { makeBridge, defaultXdgHome } from './lib/v2-bridge.mjs'
//   const { bridge, close } = makeBridge()            // 默认 4096 + 开发数据目录
//   const msgs = await bridge.getMessages(sid)
// 说明：直接吃主进程同一份实现，避免测试脚本里重复维护接口细节（V1 直调脚本的 V2 迁移路径）
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.join(here, '..', '..', 'src', 'main')

const { Bridge } = require(path.join(MAIN, 'bridge.js'))
const { serverPasswordFor, healthCheck, DEFAULT_PORT } = require(path.join(MAIN, 'engine.js'))

// 开发环境默认数据目录（dev.mjs 注入的 XWORK_OPCODE_HOME）
export function defaultXdgHome() {
  return process.env.XWORK_OPCODE_HOME || path.resolve(here, '..', '..', '..', '.opencode-home')
}

export function makeBridge({ port = Number(process.env.XWORK_ENGINE_PORT) || DEFAULT_PORT, xdgHome = defaultXdgHome(), password } = {}) {
  const pwd = password || serverPasswordFor(xdgHome)
  const bridge = new Bridge(port, { password: pwd })
  return {
    bridge,
    port,
    password: pwd,
    xdgHome,
    // 引擎是否在线（含 V2 info 载荷校验）
    async alive() {
      const h = await healthCheck(port, 1500, pwd)
      return h ? h.version : null
    },
    async close() {
      /* Bridge 无常驻资源；事件流由调用方自行 abort */
    }
  }
}

// 订阅全局事件流（归一化后的 V1 形状），返回 { stop }
export async function watchEvents(bridge, onEvent) {
  const ctrl = new AbortController()
  const p = bridge.watchGlobal((evt) => onEvent(evt, ctrl)).catch(() => {})
  return {
    stop() {
      ctrl.abort()
    },
    done: p
  }
}
