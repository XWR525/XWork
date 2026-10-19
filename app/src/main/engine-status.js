// IPC `engine:status` 的返回体组装（主进程；独立成模块以便离线单测）
//
// 为什么单独抽出来（2026-10-19 回归事故）：
//   `Engine.status()` 是 **async**。曾经的写法是
//       ipcMain.handle('engine:status', () => ({ ...engine.status(), generation }))
//   `{...Promise}` 展开的是 Promise 对象（无自有可枚举属性）⇒ 返回体只剩 `{ generation }`，
//   `running/version/port/owned/workspace` 全部丢失。表现极具迷惑性：
//   **顶栏永远显示"未连接"，但发消息、收回复一切正常**（消息通路不走这个 IPC），
//   而且渲染层的"引擎未就绪轮询"因为 `running` 恒为 undefined 而**永不停止**（每 4s 一次空转 + 重渲染）。
// 因此这里显式 await，并把该形状固化成单测（scripts/test-subagent-list.mjs）。

/**
 * @param {{status: () => Promise<object>}} engine 引擎实例（status 必须是 async）
 * @param {number} generation 引擎世代号（见 index.js 的 engineGeneration）
 * @returns {Promise<object>} 形如 {running, version, port, owned, workspace, generation}
 */
async function statusWithGeneration(engine, generation) {
  const st = await engine.status() // ← 必须 await；漏掉会丢掉除 generation 外的所有字段
  return { ...(st || {}), generation }
}

module.exports = { statusWithGeneration }
