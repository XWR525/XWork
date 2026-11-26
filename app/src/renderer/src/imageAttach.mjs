// 对话框图片附件：纯函数层（无 DOM / 无 React / 无 Electron）
//
// 抽成独立 .mjs 的原因与 typewriter.mjs 相同：App.jsx 是 JSX，Node 无法直接 import
// （app/package.json 无 "type" 字段），只有把「尺寸换算 / 上限判定 / 命名 / 载荷组装」
// 这些决策放这里，才能在离线单测里回归（scripts/test-image-attach.mjs）。
//
// 单位约定：本文件的「大小」一律指 **data URL 字符长度**（即 base64 膨胀后的字符数），
// 不是原始图片字节数。原因见设计文档 §6.3：引擎的边界是 base64/请求体大小，
// 而渲染层只拿得到 data URL，用同一把尺子最不容易算错。
//
// 约束来源（功能设计文档/对话框图片粘贴功能设计.md v1.1 §6.3）：
//   · 引擎硬约束：单图 base64 ≤ 5 MiB（media.image.max_base64_bytes 默认）、请求体约 8 MB
//   · XWork 产品默认：单张 ≤ 4 MB、合计 ≤ 7 MB、单条 ≤ 10 张
// 下面的常量是**产品默认值**，不是引擎原始数值；调整时请同步 §6.3 与主进程 index.js 的校验。

export const MAX_IMAGES = 10
export const MAX_ONE_BYTES = 4 * 1024 * 1024 // 单张 data URL 字符数上限
export const MAX_TOTAL_BYTES = 7 * 1024 * 1024 // 本条消息所有图片合计
export const MAX_EDGE = 2000 // 与引擎 media.image.max_width / max_height 默认值对齐

/** 允许的格式：引擎侧识别 data URL 图片的白名单即 jpeg/png/webp */
export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp']

/** JPEG 逐级降质档位（PNG 超限后依次尝试） */
export const JPEG_QUALITIES = [0.92, 0.85, 0.78]

/** JPEG 仍超限时按比例缩尺寸的轮数与系数 */
export const DOWNSCALE_STEPS = 3
export const DOWNSCALE_FACTOR = 0.8

const MIME_ALIAS = { 'image/jpg': 'image/jpeg' }

/** 归一化 MIME：小写、去参数、修正 image/jpg 别名 */
export function normalizeMime(mime) {
  const base = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return MIME_ALIAS[base] || base
}

/** 是否为允许粘贴的图片格式 */
export function isAllowedMime(mime) {
  return ALLOWED_MIME.includes(normalizeMime(mime))
}

/** 由 MIME 推导展示用文件名；同一条消息里第 2 张起加序号避免重名 */
export function suggestName(mime, index = 0) {
  const m = normalizeMime(mime)
  const ext = m === 'image/jpeg' ? 'jpg' : m === 'image/webp' ? 'webp' : 'png'
  return index > 0 ? `image-${index + 1}.${ext}` : `image.${ext}`
}

/**
 * 等比缩放到最长边 ≤ maxEdge。不放大（小图保持原尺寸）。
 * @returns {{width:number,height:number,scale:number}} 整数像素，最小 1
 */
export function fitSize(width, height, maxEdge = MAX_EDGE) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const longest = Math.max(w, h)
  if (!Number.isFinite(longest) || longest <= maxEdge) return { width: w, height: h, scale: 1 }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale
  }
}

/** 人类可读体积：412 B / 812 KB / 3.41 MB */
export function formatBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  if (v < 1024) return `${Math.round(v)} B`
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`
  return `${(v / 1048576).toFixed(2)} MB`
}

/** 只统计「可用」的图片：压缩中 / 失败的不计入预算（避免计数虚高） */
export function readyImages(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && x.status === 'ready' && x.dataUrl)
}

/** 当前可发送图片的合计大小（data URL 字符数） */
export function totalBytes(list) {
  return readyImages(list).reduce((sum, x) => sum + String(x.dataUrl || '').length, 0)
}

/**
 * 追加一张图片前的准入判断（不含压缩后的体积，那一步在压缩完成后再判）。
 * @returns {{ok:boolean, reason?:'over-count'|'bad-type'}}
 */
/**
 * 发送前的整体校验：单张 / 合计上限。
 * @returns {{ok:boolean, reason?:'over-one'|'over-total'}}
 */
export function checkLimits(list, limits = {}) {
  const maxOne = Number.isFinite(limits.maxOneBytes) ? limits.maxOneBytes : MAX_ONE_BYTES
  const maxTotal = Number.isFinite(limits.maxTotalBytes) ? limits.maxTotalBytes : MAX_TOTAL_BYTES
  const ready = readyImages(list)
  for (const it of ready) {
    if (String(it.dataUrl || '').length > maxOne) return { ok: false, reason: 'over-one' }
  }
  if (totalBytes(ready) > maxTotal) return { ok: false, reason: 'over-total' }
  return { ok: true }
}

/** 组给主进程/引擎的载荷：{uri: dataURL, name} */
export function buildPayload(list) {
  return readyImages(list).map((it) => ({
    uri: String(it.dataUrl || ''),
    name: String(it.name || 'image.png').slice(0, 80)
  }))
}

/** 是否存在仍在压缩的图片（期间禁止发送，否则会漏图） */
export function hasPending(list) {
  return (Array.isArray(list) ? list : []).some((x) => x && x.status === 'compressing')
}

/** 是否存在失败的图片（仅用于提示，不阻塞发送） */
export function countFailed(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && x.status === 'error').length
}

/**
 * 校验通过则返回错误文案（供 toast 直接使用），通过返回空串。
 * 渲染层与主进程共用同一套措辞，避免两边提示不一致。
 */
export function describeLimitError(reason) {
  switch (reason) {
    case 'over-count':
      return `单条最多 ${MAX_IMAGES} 张图片`
    case 'bad-type':
      return '仅支持 PNG / JPEG / WebP 图片'
    case 'over-one':
      return '单张图片超过 4 MB，请先裁剪'
    case 'over-total':
      return '本条消息图片合计超过 7 MB，请删减后重试'
    default:
      return ''
  }
}
