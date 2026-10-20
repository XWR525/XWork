// 打字机「按需追赶」纯函数层。
//
// 抽成独立 .mjs 的原因：App.jsx 是 JSX，Node 无法直接 import（app/package.json 无 "type" 字段，
// .js 会被当作 CJS 解析），把速率决策放这里才能做离线单测（scripts/test-typewriter-catchup.mjs）。
// 本模块不含 React / DOM / marked，可被 Node 与 Vite 双向加载。
//
// 单位说明：本文件所有「字符」均指 UTF-16 码元（String.prototype.length 口径，emoji 计 2）。
// 设计文档：功能设计文档/打字机功能设计文档.md

// 帧间隔（ms）。保持不变——帧率即 Markdown 解析频率，变速只改步长不改帧率。
export const TW_TICK_MS = 25

// 速率下限 = 现状速率（积压 ≤ 40 字时生效），保证「跟得上时观感不变」。
export const TW_BASE_CPS = 80

// 速率上限（平均口径；积压 ≥ 150 字时生效）。
export const TW_MAX_CPS = 300

// 追赶时间尺度（秒）：目标速率 = lag / TAU。折点由它与上下限共同导出（40 字起加速 / 150 字到顶）。
export const TW_CATCHUP_TAU = 0.5

// 单帧步长上限 = ceil(300 × 25 / 1000) = 8 字符/帧 → 瞬时速率上限 320 字/秒。
// 由 TW_MAX_CPS 导出，改上限时自动跟随，不是独立魔数。
// 它直接保证「单帧步长 ≤ 8」这一不变量，与 carry 的取值无关。
export const TW_MAX_STEP = Math.ceil((TW_MAX_CPS * TW_TICK_MS) / 1000)

// 结转余量上限：余量只做两件事——补不足 1 字的小数配额（<1）+ 补对齐回退（≤1 码元），故取 2。
// 它是「余量不得攒成未来突发」的保证（防「直落」），不兼任瞬时上限（那由 TW_MAX_STEP 直接给）。
export const TW_CARRY_MAX = 2

// 高速追赶：到达速率远超 300 字/秒时，积压会无限增长 ⇒ 关流那一刻要么长时间补打、
// 要么被整段刷出（用户可见的"先按规矩打，然后一下子全出"）。这里在一帧内连续推进多次，
// 等效提高上限：lag<500 → 1 次（基线 300 字/秒不变）；≥500 → 2 次；≥1000 → 3 次（≈900 字/秒）。
// 只在追不上时生效，正常流式的观感与速率曲线完全不变。
export const TW_BURST_MAX = 3
export const TW_BURST_STEP = 500

// 积压 → 目标速率（字/秒）。返回值 ∈ [TW_BASE_CPS, TW_MAX_CPS]，随 lag 单调不减、折点处连续。
export function typewriterCps(lag) {
  return Math.min(TW_MAX_CPS, Math.max(TW_BASE_CPS, lag / TW_CATCHUP_TAU))
}

// 切点若落在 UTF-16 代理对中间，回退 1 个码元，避免切出孤立代理项（经 innerHTML 渲染为 U+FFFD）。
// 注意：只处理代理对，不处理字素簇（组合字符 / ZWJ 序列 / 肤色修饰符）——它们被切断只会残缺字形，
// 不会产生 U+FFFD。若将来要覆盖，需改用 Intl.Segmenter({granularity:'grapheme'}) 并缓存分段结果。
export function alignToCodePoint(s, i) {
  if (i <= 0 || i >= s.length) return i
  const c = s.charCodeAt(i)
  return c >= 0xdc00 && c <= 0xdfff ? i - 1 : i
}

// 单帧推进（纯函数，便于逐帧断言）：返回本帧实际步长与新的余量。
// 两条保证是分层的、互不依赖：
//   ① 单帧步长 ≤ TW_MAX_STEP —— 由 Math.min 直接给出，与 carry 无关；
//   ② 余量有界（carry < TW_CARRY_MAX）—— 防止慢流期攒成突发。
export function advanceTypewriter({ text, shown, carry }) {
  const lag = text.length - shown
  if (lag <= 0) return { shown, carry: 0, step: 0 } // 追平即归零
  const quota = (typewriterCps(lag) * TW_TICK_MS) / 1000 // 本帧配额，≤ 7.5
  carry += quota
  const want = Math.min(Math.floor(carry), TW_MAX_STEP, lag) // ② 单帧硬上限
  let target = shown
  if (want > 0) target = Math.max(shown, alignToCodePoint(text, shown + want))
  carry -= target - shown // 按真实推进量扣账，而非 want
  if (carry >= TW_CARRY_MAX) carry -= Math.floor(carry) // ① 余量不进银行，保留 [0, TW_CARRY_MAX)
  return { shown: target, carry, step: target - shown }
}

// 带高速追赶的单帧推进：积压越大，同一帧内推进的次数越多（等效速率上限 3×）。
// 逐次调用 advanceTypewriter —— 每次都会用**当时的** lag 重算配额，所以越追越快，
// 且不改变单次调用的语义（§5.2 的单帧步长断言仍成立）。
export function advanceTypewriterBurst({ text, shown, carry, burstMax = TW_BURST_MAX }) {
  const lag0 = text.length - shown
  if (lag0 <= 0) return { shown, carry: 0, step: 0 }
  const times = Math.max(1, Math.min(burstMax, 1 + Math.floor(lag0 / TW_BURST_STEP)))
  let cur = { shown, carry, step: 0 }
  for (let i = 0; i < times; i++) {
    const r = advanceTypewriter({ text, shown: cur.shown, carry: cur.carry })
    cur = { shown: r.shown, carry: r.carry, step: cur.step + r.step }
    if (r.step <= 0) break
  }
  return cur
}
