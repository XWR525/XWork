// 流式「浮现」纯函数层 —— 对应 功能设计文档/流式浮现功能设计-v3.md（v3.2）§5.1 / §5.2
//
// 抽成独立 .mjs 的理由同 typewriter.mjs：App.jsx 是 JSX，Node 无法直接 import（app/package.json
// 没有 "type" 字段），把速率/窗口/水位这些决策放这里才能做离线单测（scripts/test-emerge.mjs）。
// 本模块不含 React / DOM / marked，可被 Node 与 Vite 双向加载。
//
// 单位说明（C7，写死）：本文件所有「偏移 / 长度」一律是 **UTF-16 码元**（String.prototype.length
// 口径，emoji 计 2）。内部按码点迭代只为「不切断代理对」，累加一律用各码点自身的 length；
// 禁止用 [...str].length / for..of / Array.from 计数——它们按码点口径，与 Text.length 不一致。
//
// 职责边界：本模块只算「该不该包、包多大块、出生时刻是多少」，不做 DOM 遍历与包裹。
// 末窗切片的起点若按码元硬切（COLLECT=160），调用方须用 typewriter.mjs 的 alignToCodePoint
// 对齐；本模块对越界起点（首码元是孤立低代理）另有兜底。

export const EMERGE_DEFAULTS = Object.freeze({
  windowChars: 112, // W：时长公式的输入（目标在飞字符数），不是采集上限
  collectChars: 160, // 末窗反向采集硬上限；须 ≥ R_max × DUR_MAX ≈ 122
  durationMin: 120, // 可见性下限；只在高速追赶档（R>320）才生效，用来维持容量包络（≈933）
  durationMax: 380, // 慢速时的时长（与演示页一致的 380ms）
  staggerMs: 22, // 同帧错峰：一帧内到达的相邻块依次推迟 22ms（演示页默认值）
  staggerMax: 66, // 错峰总量上限（≈3 个块），避免高速档把可见性拖到 90ms 以外
  maxUnits: 80, // 单帧并发单元上限（§7 churn 决策）：一帧内文本暴涨时只包最新的 80 块，其余直接定格
  ease: 'cubic-bezier(.25,.46,.45,.94)',
  blur0: 7,
  cjkGroup: 2, // CJK 每块汉字数
  samplesKeep: 60 // 水位环保留条数（≈1.5s @40Hz）
})

// 包络上界：R ≤ emergeRateCeiling 时不变式 W ≥ R × DURATION_eff 成立（默认 384）。
// 实际 R ≤ 320（TW_MAX_CPS × 25ms 的 8 字/帧 ⇒ 320 字/秒），余量 64。
export function emergeRateCeiling({ windowChars = EMERGE_DEFAULTS.windowChars, durationMin = EMERGE_DEFAULTS.durationMin } = {}) {
  return (windowChars * 1000) / durationMin
}

// 本帧应使用的动画时长（ms）与「是否已超出容量包络」。
//   duration = clamp((W / R) × 1000, MIN, MAX)      —— 容量约束
//   degraded = R × MIN / 1000 > W                   —— 等价于 R > W/MIN（默认 384）
// 超出包络时不假装仍满足不变式：调用方据此触发并发单元上限降级（D5）。
export function emergeDurationMs({
  windowChars = EMERGE_DEFAULTS.windowChars,
  rateCps,
  durationMin = EMERGE_DEFAULTS.durationMin,
  durationMax = EMERGE_DEFAULTS.durationMax
} = {}) {
  const W = Math.max(1, windowChars)
  const min = Math.max(1, durationMin)
  const max = Math.max(min, durationMax)
  const rate = Number(rateCps)
  if (!(rate > 0)) return { duration: max, degraded: false } // 本帧无推进：按最慢档
  const duration = Math.min(max, Math.max(min, (W / rate) * 1000))
  const degraded = (rate * min) / 1000 > W
  return { duration, degraded }
}

// ---------------------------------------------------------------- 分块（§4.6）

const RE_WS = /^\s$/u
const RE_CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u
const RE_PICTO = /^\p{Extended_Pictographic}$/u
const RE_WORD = /^[\p{L}\p{N}]$/u

function kindOf(ch) {
  if (RE_WS.test(ch)) return 'ws'
  if (RE_CJK.test(ch)) return 'cjk'
  if (RE_PICTO.test(ch)) return 'picto' // 单个 emoji 自成一块（码元 2，绝不切开）
  if (RE_WORD.test(ch)) return 'word'
  return 'punct'
}

// 按码点迭代、按码元累加（C7）
function codePoints(s) {
  const out = []
  for (let i = 0; i < s.length; ) {
    const ch = String.fromCodePoint(s.codePointAt(i))
    out.push(ch)
    i += ch.length
  }
  return out
}

function tokenize(text) {
  const out = []
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i))
    const kind = kindOf(ch)
    const last = out[out.length - 1]
    // picto 不合并（每个 emoji 一块）；其余同类连续字符合并成一个 token
    if (last && last.kind === kind && kind !== 'picto') last.text += ch
    else out.push({ kind, text: ch })
    i += ch.length
  }
  return out
}

// 把一段渲染文本切成「可包裹单元」。
//   absStart：本段首码元在整个容器 textContent 中的绝对偏移
//   isSpace：语义是「不包裹」，覆盖 ① 空白 ② 无法并入前后块的孤立标点
// 返回值无损：各块 text 顺序拼接恒等于入参 text，absStart 依次递增。
export function chunkSpans(text, absStart = 0, cjkGroup = EMERGE_DEFAULTS.cjkGroup) {
  const out = []
  if (typeof text !== 'string' || text.length === 0) return out
  const group = Math.max(1, Math.floor(cjkGroup) || 1)
  const raw = [] // { text, isSpace }
  let lead = '' // 暂存的标点，等并入后块
  let openIdx = -1 // 可承接尾随标点的块下标（-1 = 前面是空白/开头）

  const push = (t, isSpace) => {
    raw.push({ text: t, isSpace })
    return raw.length - 1
  }

  let head = 0
  // 兜底：调用方若把切片切在代理对中间，首码元是孤立低代理，不能进任何可包裹块
  const c0 = text.charCodeAt(0)
  if (c0 >= 0xdc00 && c0 <= 0xdfff) {
    push(text.slice(0, 1), true)
    head = 1
  }

  for (const tk of tokenize(text.slice(head))) {
    if (tk.kind === 'ws') {
      if (lead) {
        push(lead, true) // 孤立标点：自成一块但不包裹
        lead = ''
      }
      const last = raw[raw.length - 1]
      if (last && last.isSpace) last.text += tk.text
      else push(tk.text, true)
      openIdx = -1
      continue
    }
    if (tk.kind === 'punct') {
      // 紧随正文的标点并入前块（「你好，」是一块）；否则留给后块作前缀
      if (openIdx >= 0) raw[openIdx].text += tk.text
      else lead += tk.text
      continue
    }
    if (tk.kind === 'cjk') {
      const cps = codePoints(tk.text)
      for (let k = 0; k < cps.length; k += group) {
        const piece = cps.slice(k, k + group).join('')
        const t = lead + piece
        lead = ''
        openIdx = push(t, false)
      }
      continue
    }
    // word / picto
    const t = lead + tk.text
    lead = ''
    openIdx = push(t, false)
  }
  if (lead) push(lead, true)

  let cursor = absStart
  for (const r of raw) {
    out.push({ absStart: cursor, text: r.text, isSpace: r.isSpace })
    cursor += r.text.length // 码元
  }
  return out
}

// ---------------------------------------------------------------- 水位环（§4.4）

// 追加一条采样；文本缩短 d 时把环内**所有**存量 len 减 d（窗口锚在末尾，等价于坐标随尾平移）。
// 不取 max —— 取 max 会在缩短后留下死区，死区内新字完全不浮现（v3 评审第 4 条）。
// 末条 len 即上一次的 total，因此不需要额外传 prevTotal。
export function pushSample(samples, { t, total, keep = EMERGE_DEFAULTS.samplesKeep } = {}) {
  const list = Array.isArray(samples) ? samples : []
  let out = list.slice()
  const last = out.length ? out[out.length - 1].len : null
  if (last !== null && total < last) {
    const d = last - total
    out = out.map((s) => ({ t: s.t, len: Math.max(0, s.len - d) }))
  }
  out.push({ t, len: total })
  const cap = Math.max(1, keep)
  if (out.length > cap) out = out.slice(out.length - cap)
  return out
}

// 出生时刻：最早的满足 s.len > offset 的采样时间；查不到（发生在环窗口之前）⇒ null。
// 严格 '>' 是 0-based 偏移下正确性的关键：len 表示「已渲染的码元数」，偏移 x 属于 [0, len)。
// 要求 samples 按 len 非递减（pushSample 保证：缩水时整体平移后仍有序）。
export function birthOf(samples, offset) {
  const i = birthIndexOf(samples, offset)
  return i < 0 ? null : samples[i].t
}

// 出生样本的下标（出生时刻在环里的位置）。DOM 层要用它取「该字属于哪一帧」，
// 从而算出同帧错峰（§4.6 / EMERGE_STAGGER_MS）：越靠这一帧末尾的字等得越久。
export function birthIndexOf(samples, offset) {
  if (!Array.isArray(samples) || samples.length === 0) return -1
  let lo = 0
  let hi = samples.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].len > offset) {
      ans = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

// 该偏移是否「新出生」（可包裹）。
// 播种（组件挂载首帧）之前的文本一律视为已定格 —— 否则恢复会话/打开历史会话时整段重播（P2）。
export function isFresh(birth, seededAt) {
  return typeof birth === 'number' && birth > seededAt
}

// 降级判定（D8）：系统偏好 reduce 或用户选「打字机」⇒ 不包裹、不写动画变量。
export function shouldDegrade({ reduced = false, mode = 'emerge' } = {}) {
  return reduced === true || mode === 'typewriter'
}
