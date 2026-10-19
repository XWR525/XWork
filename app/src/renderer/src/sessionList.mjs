// 会话列表的纯函数层：子会话过滤、置顶排序、工作区计数派生（无 React 依赖，可离线单测）
//
// 设计依据：功能文档/subagent前端表现设计.md v2.4
//   §5.4(a) 侧栏列表 / 置顶残留（v1-B-3）/ 工作区计数（v2-B-2 + v2-B-6）/ 父会话徽标
//   §8.2 T1 / T20 / T21 / T22 / T23
//
// 为什么单独成模块：
//   B-3 的坑是"渲染集合被过滤、但拖拽索引运算仍作用于原始数组" ⇒ 视觉顺序与数组顺序不再一一对应。
//   修法是把"显示用置顶序"提升为唯一索引源，而拖拽的全部索引运算都基于它。
//   这些推导是纯数据变换，抽出来才能离线把 T22 的语义固化（App.jsx 无法 require）。

/** 父会话行徽标计数：childIndex.get(rootId)?.length（没有子会话返回 0） */
export function childBadgeCount(childIndex, sessionId) {
  if (!childIndex || !sessionId) return 0
  const arr = childIndex.get(sessionId)
  return Array.isArray(arr) ? arr.length : 0
}

/**
 * 子会话索引：Map<parentID, SessionInfo[]>。
 * 列表 state 必须保持全量（loadSession / 模型回读 / 重命名都依赖它），只在这里派生。
 */
export function buildChildIndex(sessions) {
  const map = new Map()
  for (const s of sessions || []) {
    if (!s || !s.parentID) continue
    const arr = map.get(s.parentID)
    if (arr) arr.push(s)
    else map.set(s.parentID, [s])
  }
  return map
}

/** 全部子会话 id 集合（用于把子会话从列表与置顶区里排除） */
export function childSessionIds(sessions) {
  const set = new Set()
  for (const s of sessions || []) {
    if (s && s.parentID) set.add(s.id)
  }
  return set
}

/** 判定函数：id 是否属于子会话 */
export function makeIsChild(childIds) {
  const set = childIds instanceof Set ? childIds : new Set(childIds || [])
  return (id) => set.has(id)
}

/**
 * ★ 唯一索引源（v1-B-3）：显示用的置顶序 —— 从原始 pinnedOrder 里剔除子会话 id。
 * 渲染、dragIdx、finalCount、items、dropPos 比较、onDrop 的插入全部必须基于它。
 */
export function visiblePinnedOrder(pinnedOrder, childIds) {
  const isChild = typeof childIds === 'function' ? childIds : makeIsChild(childIds)
  return (pinnedOrder || []).filter((id) => !isChild(id))
}

/** 在可见置顶序内插入（与既有 onDrop 语义一致：先剔除拖拽项，再按 dropPos 插入并夹取边界） */
export function moveWithinVisible(visible, draggingId, dropPos) {
  const list = visible || []
  if (!list.includes(draggingId)) return list
  const next = list.filter((id) => id !== draggingId)
  const at = Math.max(0, Math.min(typeof dropPos === 'number' ? dropPos : next.length, next.length))
  next.splice(at, 0, draggingId)
  return next
}

/**
 * 把"可见项的新顺序"映回原始 pinnedOrder：
 *   · 可见项按 visibleNew 的顺序重新填入
 *   · 子会话 id **保持它们在原数组中的下标位置**（不改写 localStorage、不破坏用户数据）
 * 这样数组顺序与渲染顺序重新一一对应，指示线与落位不会再错位。
 */
export function mergePinnedOrder(original, visibleNew, childIds) {
  const isChild = typeof childIds === 'function' ? childIds : makeIsChild(childIds)
  const src = original || []
  const vis = visibleNew || []
  const out = []
  let vi = 0
  for (const id of src) {
    if (isChild(id)) {
      out.push(id) // 子会话 id 留在原位
      continue
    }
    out.push(vi < vis.length ? vis[vi] : id)
    vi++
  }
  for (; vi < vis.length; vi++) out.push(vis[vi]) // 理论上不会触发，防御性兜底
  return out
}

/**
 * 工作区计数规则**不在此模块**：它在主进程 `index.js` 的 `workspace:list` 内联（一行条件），
 * 因为 `truncated` 由 `bridge.listSessionsWithMeta()` 直接给出（主进程侧）。
 * 规则原文（设计 §5.4(a) ③）：`!truncated && 根会话数 > 0` 时才「重算覆盖」计数；
 * 触达分页上限 / 引擎不可用 / 空列表时必须保留旧值。这里的单测覆盖 `truncated` 的产生端。
 */

// ── 子会话标题（2026-10-19 会话标题行 / 下拉框用）──────────────────────────

/** 短 id：兜底标题里显示的会话标识（与卡片里的展示口径一致：前 8 位） */
export function shortSid(sid) {
  const s = String(sid || '')
  return s ? s.slice(0, 8) : ''
}

/**
 * 子会话的显示标题（用户拍板的兜底链）：
 *   引擎 title → `agent · description` → `子会话 xxxxxxxx`
 * 为什么要兜底：引擎在子会话刚创建时还没有生成 title；直接显示空串会让标题行的徽标
 * 与下拉框出现空白项。`title` 只有空白也算缺失（引擎偶尔写入空白）。
 * @param {{title?:string, agent?:string, desc?:string, sid?:string}} item
 */
export function childSessionLabel(item) {
  const t = String((item && item.title) || '').trim()
  if (t) return t
  const a = String((item && item.agent) || '').trim()
  const d = String((item && item.desc) || '').trim()
  if (a || d) return [a, d].filter(Boolean).join(' · ')
  return '子会话 ' + shortSid((item && item.sid) || '')
}
