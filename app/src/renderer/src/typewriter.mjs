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
