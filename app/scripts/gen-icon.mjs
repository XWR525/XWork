// 生成应用图标 build/icon.ico（256x256 蓝色渐变圆角底 + 白色 X 字标）
// 纯 Node 实现：手动编码 PNG（IHDR/IDAT/IEND）+ 打包 ICO（含 256x256 PNG 块），无第三方依赖
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const S = 256 // 画布尺寸
const R = 40 // 圆角半径
const ARM = 21 // X 字标线条半宽（对角线方向）

// CRC32 表
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// 生成 PNG（RGBA，无过滤）
function encodePNG(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// 画布：圆角矩形判定 + 渐变底 + X 字标
const rgba = Buffer.alloc(S * S * 4)
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    // 圆角矩形：角落距圆心超过半径则透明
    const cx = Math.min(Math.max(x, R), S - R)
    const cy = Math.min(Math.max(y, R), S - R)
    const dx = x - cx
    const dy = y - cy
    if (dx * dx + dy * dy > R * R) {
      rgba[i + 3] = 0
      continue
    }
    // 垂直渐变：#2f6fed(顶) → #1a3f8f(底)
    const t = y / (S - 1)
    const r = Math.round(0x2f + (0x1a - 0x2f) * t)
    const g = Math.round(0x6f + (0x3f - 0x6f) * t)
    const b = Math.round(0xed + (0x8f - 0xed) * t)
    rgba[i] = r
    rgba[i + 1] = g
    rgba[i + 2] = b
    rgba[i + 3] = 255
    // 白色 X：到两条对角线的垂直距离 < ARM
    const d1 = Math.abs(x - y) / Math.SQRT2
    const d2 = Math.abs(x + y - (S - 1)) / Math.SQRT2
    if (d1 < ARM || d2 < ARM) {
      rgba[i] = 255
      rgba[i + 1] = 255
      rgba[i + 2] = 255
    }
  }
}

const png = encodePNG(S, S, rgba)

// 打包 ICO（Vista+ 格式：直接内嵌 PNG）
const ico = Buffer.alloc(6 + 16)
ico.writeUInt16LE(0, 0) // reserved
ico.writeUInt16LE(1, 2) // type: icon
ico.writeUInt16LE(1, 4) // count
ico[6] = 0 // 256px → 0
ico[7] = 0
ico[8] = 0 // palette
ico[9] = 0
ico.writeUInt16LE(1, 10) // planes
ico.writeUInt16LE(32, 12) // bpp
ico.writeUInt32LE(png.length, 14) // data size
ico.writeUInt32LE(22, 18) // data offset
const out = Buffer.concat([ico, png])

const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.ico')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, out)
console.log('icon.ico 已生成:', outPath, Math.round(out.length / 1024) + ' KB')
