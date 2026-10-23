// 流式「浮现」DOM 层 —— 对应 功能设计文档/流式浮现功能设计-v3.md（v3.2）§4.1 步骤 5/6 与 §5.3
//
// 分工：emerge.mjs 是纯算术（可离线单测），本文件只碰 DOM。抽出来的原因只有一个：
// 真浏览器验收脚本（scripts/accept-emerge.mjs）能把这份**真实源码**送进页面求值，
// 不必再抄一份循环体（抄一份就会与 App.jsx 漂移）。
//
// 三件事：
//   ① collectTail：从容器末尾反向 DFS 采集末窗文本节点（早停，O(W)）
//   ② wrapEmerge：按出生时刻给「还在动」的单元套 <span class="em" style="animation-delay:-Nms">
//   ③ unwrapEmerge：降级时把包裹还原成纯文本
//
// 单位：所有偏移/长度均为 UTF-16 码元（C7）。
import { EMERGE_DEFAULTS, birthIndexOf, chunkSpans, emergeDurationMs, isFresh, pushSample } from './emerge.mjs'

// 不包裹的子树：代码 / 链接 / 公式 / 图表 / 已包裹（§3 D3）。
// code 与 a 一并跳过：否则容器（背景/边框）先全亮、内部文字后淡入（附录 B #10）。
// 跳过的子树仍要计入偏移，否则偏移空间会与 textContent.length 分叉。
export const EMERGE_SKIP = 'pre, code, a, .katex, .md-mermaid, .em'

// 从容器末尾反向 DFS 采集末窗文本节点（手工栈；跳过子树按 textContent 长度整块跳过、不下降）。
// 返回 tail-first 的 [{ node, absStart }]；累计码元达 collectChars 即停。
export function collectTail(rootEl, collectChars = EMERGE_DEFAULTS.collectChars) {
  const out = []
  let end = rootEl.textContent.length // 尚未消费的文本结束位置（绝对偏移，exclusive）
  let taken = 0
  const stack = [{ el: rootEl, i: rootEl.childNodes.length - 1 }]
  while (stack.length) {
    const frame = stack[stack.length - 1]
    if (frame.i < 0) {
      stack.pop()
      continue
    }
    const child = frame.el.childNodes[frame.i--]
    if (child.nodeType === 3) {
      const len = child.data.length
      end -= len
      out.push({ node: child, absStart: end })
      taken += len
      if (taken >= collectChars) break
      continue
    }
    if (child.nodeType !== 1) continue
    if (child.matches(EMERGE_SKIP)) {
      const len = child.textContent.length
      end -= len
      taken += len
      if (taken >= collectChars) break
      continue
    }
    if (child.firstChild) stack.push({ el: child, i: child.childNodes.length - 1 })
  }
  return out
}

// 水位环推进。返回本次渲染总长；**播种帧返回 null ⇒ 本帧不包裹**（P2）：
// 若不这样写，种子样本会让所有 offset < total 命中 t0 ⇒ 恢复会话/历史消息整段重播。
export function sampleTotal(rootEl, progress, now) {
  const total = rootEl.textContent.length // 码元；实测 0.011ms / 6370 字（§2.1）
  if (!progress.seeded) {
    progress.samples = [{ t: now, len: total }]
    progress.seededAt = now
    progress.seeded = true
    return null
  }
  progress.samples = pushSample(progress.samples, { t: now, total })
  return total
}

// 同帧错峰（§4.6 / EMERGE_STAGGER_MS）：追上速度时一帧到 8 字，若整帧共用同一 elapsed，
// 4 个 CJK 块会同时从 blur 7 淡入 —— 看起来是「一坨一坨」。这里把一帧内到达的字按其在
// 帧内的位置依次推迟 [0, spread]：delay 转正 ⇒ 动画保持在起始帧（排队等待），到点再淡入。
// 用「该字所属的采样帧」而非「最新帧」计算，保证同一偏移跨重建得到同一结果（不跳变）。
function staggerOf(samples, idx, offset) {
  if (idx <= 0) return 0 // 播种帧不错峰（那一帧是"已有文本"）
  const start = samples[idx - 1].len
  const tickLen = Math.max(1, samples[idx].len - start)
  const slots = Math.max(1, Math.ceil(tickLen / EMERGE_DEFAULTS.cjkGroup))
  const spread = Math.min(EMERGE_DEFAULTS.staggerMax, EMERGE_DEFAULTS.staggerMs * (slots - 1))
  if (spread <= 0) return 0
  const frac = Math.min(1, Math.max(0, (offset - start) / tickLen))
  return frac * spread
}

// 末窗包裹：把「出生未满 duration」的单元包成负延迟 span。
// 已定格的不包、跳过清单内不包（但都计入偏移）。
export function wrapEmerge(rootEl, progress, now) {
  if (sampleTotal(rootEl, progress, now) === null) return 0 // 首帧只播种
  const { duration } = emergeDurationMs({ rateCps: progress.rateCps })
  const samples = progress.samples
  const tails = collectTail(rootEl, EMERGE_DEFAULTS.collectChars)
  if (!tails.length) return 0

  // 先决定「包谁」，再统一落 DOM：本帧没有要包的单元就不改 --em-dur，
  // 否则存活下来的 .em 会因时长变化而跳进度
  const plan = []
  const maxUnits = EMERGE_DEFAULTS.maxUnits
  outer: for (const { node, absStart } of tails) {
    const chunks = chunkSpans(node.data, absStart, EMERGE_DEFAULTS.cjkGroup, EMERGE_DEFAULTS.latinGroup)
    for (let i = chunks.length - 1; i >= 0; i--) {
      const c = chunks[i]
      if (c.isSpace) continue
      const idx = birthIndexOf(samples, c.absStart)
      if (idx < 0) continue
      const birth = samples[idx].t
      if (!isFresh(birth, progress.seededAt)) continue // 播种前 / 查不到 ⇒ 已定格
      const elapsed = now - birth - staggerOf(samples, idx, c.absStart) // 同帧错峰后可能为负
      if (elapsed >= duration) continue // 纳入判据是【年龄】，不是【偏移】
      plan.push({ node, at: c.absStart - absStart, len: c.text.length, delay: Math.round(elapsed) })
      // 单帧并发上限（尾部优先）：文本一帧暴涨（全量替换/异常快照）时只包最新的一批，
      // 其余直接定格 —— 否则会一次造出上千个带 filter 的 span（实测 4000 个 / 11ms 一帧）
      if (plan.length >= maxUnits) break outer
    }
  }
  if (!plan.length) return 0

  // 变量写在容器上（span 继承），每个 span 只内联负延迟
  rootEl.style.setProperty('--em-dur', `${duration}ms`)
  rootEl.style.setProperty('--em-ease', EMERGE_DEFAULTS.ease)
  rootEl.style.setProperty('--em-blur', `${EMERGE_DEFAULTS.blur0}px`)

  // 同节点内按 at 倒序切（先右后左，左侧偏移不受影响）
  for (const p of plan) {
    const left = p.node.splitText(p.at)
    const mid = p.len >= left.data.length ? left : left.splitText(p.len)
    const span = document.createElement('span')
    span.className = 'em'
    // delay = elapsed：正数取负（定位到动画中段）、负数取正（错峰排队，保持起始帧）
    span.style.animationDelay = `${-p.delay}ms`
    mid.parentNode.insertBefore(span, mid)
    span.appendChild(mid)
  }
  return plan.length
}

// 降级：把已包裹的 .em 还原成纯文本（不残留半程动画）
export function unwrapEmerge(rootEl) {
  const spans = rootEl.querySelectorAll('.em')
  if (!spans.length) return
  for (const span of spans) {
    const parent = span.parentNode
    if (!parent) continue
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    parent.removeChild(span)
  }
  rootEl.style.removeProperty('--em-dur')
  rootEl.style.removeProperty('--em-ease')
  rootEl.style.removeProperty('--em-blur')
}
