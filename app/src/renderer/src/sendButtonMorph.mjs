// 发送 / 中止按钮图标的形状插值（纯函数，无 DOM 依赖，便于单测）
//
// 0 = 发送：上指圆角箭头（底部有 V 形凹口）
// 1 = 中止：圆角方块
// 中间态是「4 个控制点 + 圆角半径」的线性插值后再生成圆角轮廓 —— 真形状变形，
// 不是两张图交叉淡入；配合视图层的 rotate(0→90deg) 得到「边转边变」的观感。
//
// 实测约定（2026-10-21，30px 按钮）：发送图标 17px、中止图标 19px，切换时随变形连续过渡。

const ARROW = [
  [50, 13], // 顶点
  [88, 84], // 右下
  [50, 63], // 凹口中点
  [12, 84] // 左下
]
const SQUARE = [
  [26, 26],
  [74, 26],
  [74, 74],
  [26, 74]
]
// 顶点对应关系：把箭头顶点顺时针错开一位映射到方块四角，
// 让四个顶点位移量接近（直接用下标对应会出现「箭头先歪向一侧」的中间态）
const MAP = [1, 2, 3, 0]

const R_ARROW = 9
const R_SQUARE = 15

export const MORPH_MS = 420
export const SIZE_SEND = 17
export const SIZE_STOP = 19
export const ROTATE_DEG = 90

const lerp = (a, b, t) => a + (b - a) * t
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** 缓动：与 CSS cubic-bezier(.65,0,.35,1) 接近的三次缓入缓出 */
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** 该形态下的图标像素尺寸：发送 17px → 中止 19px 连续过渡 */
export function iconSize(t) {
  return lerp(SIZE_SEND, SIZE_STOP, t)
}

/** 该形态下的旋转角度（度）：0 → 90 */
export function rotateDeg(t) {
  return ROTATE_DEG * t
}

/**
 * 生成该形态的圆角多边形点列。
 * @param {number} t 0 = 发送箭头，1 = 中止方块（中间值自动插值）
 * @param {number} [perCorner] 每个圆角采样点数（越大越平滑，8 在 30px 下已足够）
 * @returns {string} SVG polygon 的 points 属性值
 */
export function shapePoints(t, perCorner = 8) {
  const k = Math.min(1, Math.max(0, Number(t) || 0))
  const pts = ARROW.map((p, i) => {
    const q = SQUARE[MAP[i]]
    return [lerp(p[0], q[0], k), lerp(p[1], q[1], k)]
  })
  const radius = lerp(R_ARROW, R_SQUARE, k)
  const out = []
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const d1 = dist(p0, p1) || 1
    const d2 = dist(p2, p1) || 1
    const v1 = [(p0[0] - p1[0]) / d1, (p0[1] - p1[1]) / d1]
    const v2 = [(p2[0] - p1[0]) / d2, (p2[1] - p1[1]) / d2]
    const r = Math.min(radius, d1 / 2, d2 / 2)
    const a = [p1[0] + v1[0] * r, p1[1] + v1[1] * r]
    const b = [p1[0] + v2[0] * r, p1[1] + v2[1] * r]
    // 顶点用二次贝塞尔倒圆角（凹口同样适用），按 perCorner 采样
    for (let s = 0; s <= perCorner; s++) {
      const u = s / perCorner
      const mu = 1 - u
      out.push([
        mu * mu * a[0] + 2 * mu * u * p1[0] + u * u * b[0],
        mu * mu * a[1] + 2 * mu * u * p1[1] + u * u * b[1]
      ])
    }
  }
  return out.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
}
