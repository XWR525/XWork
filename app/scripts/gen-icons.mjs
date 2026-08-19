// 从用户提供的源图（build/logo.jpg，JPEG 源图）生成：
//   1. 标准多尺寸 ICO（256/64/48/32/16，覆盖 build/icon.ico）—— electron-builder 打包 exe 图标用
//   2. 16x16 托盘 PNG base64 + 64x64 关于页图标 PNG base64（打印，供主进程/渲染层内嵌使用）
// 纯 Node 内置实现（zlib + 手写 PNG 解码/编码），无第三方依赖。
// JPEG 源图经 Windows WIC（PresentationCore BitmapDecoder，-EncodedCommand 内嵌 PowerShell 脚本）转 PNG。
// 白底处理：保留 logo.jpg 的白色底色（不透明），仅裁掉四周大片多余白边并等比居中方化；
// 输出前对所有尺寸应用圆角（四角圆弧裁切，抗锯齿），托盘/窗口/关于页/打包 ICO 各处一致。
// 圆角半径取边长的 28%（大圆角风格）；16px 时约 4px，各尺寸视觉一致。
// 兼容输入：JPEG、8bit RGB（colorType 2）或 RGBA（colorType 6）PNG。
// 用法：node scripts/gen-icons.mjs [--force]  —— --force 时若源文件已是标准 ICO，
//       自动提取其 256px 条目作为源图重新生成（用于重跑输出各尺寸 base64）。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'logo.jpg')
const ICON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.ico')

// JPEG → PNG：Node 无内置 JPEG 解码，调用 Windows WIC（PresentationCore 的 BitmapDecoder，
// 与 Chromium 同一解码器栈）。不能用 System.Drawing(GDI+)：该 JPEG 在 GDI+ 下右下角
// 会解码出大片蓝色伪影（色度残留），导致图标内容被撑偏/贴边。
// （用 -EncodedCommand 传 UTF-16LE base64，规避所有引号转义问题）
function jpegToPNG(srcPath) {
  const tmp = path.join(path.dirname(srcPath), '.tmp-logo.png')
  const ps = [
    'Add-Type -AssemblyName PresentationCore',
    'Add-Type -AssemblyName WindowsBase',
    `$src = '${srcPath.replace(/'/g, "''")}'`,
    `$dst = '${tmp.replace(/'/g, "''")}'`,
    '$stream = [System.IO.File]::OpenRead($src)',
    'try {',
    '  $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($stream, [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)',
    '  $frame = $dec.Frames[0]',
    '  $enc = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()',
    '  $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($frame))',
    '  $out = [System.IO.File]::Create($dst)',
    '  $enc.Save($out)',
    '  $out.Dispose()',
    '} finally { $stream.Dispose() }'
  ].join('; ')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8' })
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    throw new Error('JPEG→PNG 转换失败（需 Windows PresentationCore/WIC）: ' + (r.stderr || r.stdout || 'exit ' + r.status))
  }
  const buf = fs.readFileSync(tmp)
  fs.unlinkSync(tmp)
  return buf
}

// ---------- PNG 解码 ----------
function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })())
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.slice(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const px = Buffer.alloc(width * height * 4) // RGBA 输出
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      switch (filter) {
        case 0: break
        case 1: v = (v + a) & 0xff; break
        case 2: v = (v + b) & 0xff; break
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break
        case 4: v = (v + paeth(a, b, c)) & 0xff; break
        default: throw new Error('bad filter ' + filter)
      }
      out[x] = v
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels
      const di = (y * width + x) * 4
      px[di] = out[si]
      px[di + 1] = out[si + 1]
      px[di + 2] = out[si + 2]
      px[di + 3] = channels === 4 ? out[si + 3] : 255
    }
    prev = out
  }
  return { width, height, px }
}

// ---------- 裁剪近白边距（JPEG 白底 logo → 去掉四周大片多余白边，保留白色底色） ----------
// 以内容 bbox 中心为对称裁出正方形窗口（内容外留 padRatio 呼吸白边）；窗口越界时钳制到画布内，
// 保证内容完整且居中（内容贴边时也能得到对称边距，不会出现"内容被挤到角落/贴边"）。
// 白底像素保留为纯白不透明（alpha=255），图标各处维持源图的白色底色。
function trimWhiteMargins(px, w, h, threshold = 245, padRatio = 0.12) {
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (px[i] < threshold || px[i + 1] < threshold || px[i + 2] < threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { px, width: w, height: h } // 全白：不裁
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  const pad = Math.round(Math.max(cw, ch) * padRatio)
  // 目标窗口边长：内容 + 两侧呼吸白边；但不得超过画布短边（否则 sx/sy 只能取负，
  // 会把内容整体推向右/下并裁掉，见下方注释）。内容本身就是上限。
  let side = Math.max(cw, ch) + pad * 2
  const maxSide = Math.min(w, h)
  if (side > maxSide) side = maxSide
  if (side < Math.max(cw, ch)) side = Math.max(cw, ch)
  const cx = Math.round((minX + maxX) / 2)
  const cy = Math.round((minY + maxY) / 2)
  // 以内容中心为目标摆放窗口，但钳制到画布内：ox/oy 必须 >=0 且 ox+side<=w、
  // oy+side<=h，保证不越界、不偏移、不裁掉内容（窗口受 side 限制必然可容纳）。
  let ox = Math.round(cx - side / 2)
  let oy = Math.round(cy - side / 2)
  ox = Math.max(0, Math.min(ox, w - side))
  oy = Math.max(0, Math.min(oy, h - side))
  const out = Buffer.alloc(side * side * 4)
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = 255 // 白色底色
  }
  for (let y = 0; y < side; y++) {
    const sy = oy + y
    if (sy < 0 || sy >= h) continue
    for (let x = 0; x < side; x++) {
      const sx = ox + x
      if (sx < 0 || sx >= w) continue
      const si = (sy * w + sx) * 4
      if (px[si] >= threshold && px[si + 1] >= threshold && px[si + 2] >= threshold) continue // 白底保持纯白
      const di = (y * side + x) * 4
      out[di] = px[si]
      out[di + 1] = px[si + 1]
      out[di + 2] = px[si + 2]
      out[di + 3] = 255
    }
  }
  return { px: out, width: side, height: side }
}

// ---------- 等比居中放入正方形画布（多余区域白色），避免非正方形源图被拉伸变形 ----------
function padToSquare(px, w, h) {
  const side = Math.max(w, h)
  const out = Buffer.alloc(side * side * 4)
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = 255 // 白色底
  }
  const ox = (side - w) >> 1
  const oy = (side - h) >> 1
  for (let y = 0; y < h; y++) {
    px.copy(out, ((oy + y) * side + ox) * 4, y * w * 4, (y + 1) * w * 4)
  }
  return { px: out, width: side, height: side }
}

// ---------- 双线性缩放（RGBA） ----------
function resizeRGBA(src, sw, sh, tw, th) {
  const out = Buffer.alloc(tw * th * 4)
  for (let y = 0; y < th; y++) {
    const sy = ((y + 0.5) * sh) / th - 0.5
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(sh - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < tw; x++) {
      const sx = ((x + 0.5) * sw) / tw - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = sx - x0
      const di = (y * tw + x) * 4
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * sw + x0) * 4 + c]
        const p10 = src[(y0 * sw + x1) * 4 + c]
        const p01 = src[(y1 * sw + x0) * 4 + c]
        const p11 = src[(y1 * sw + x1) * 4 + c]
        const top = p00 + (p10 - p00) * fx
        const bot = p01 + (p11 - p01) * fx
        out[di + c] = Math.round(top + (bot - top) * fy)
      }
    }
  }
  return out
}

// ---------- 圆角（RGBA）：四角圆弧裁切，带抗锯齿 ----------
// 图标整体为白底正方形，圆角即裁掉四角圆弧之外的白色，内容不受影响。
// 半径取边长的 28%（大圆角风格）；16px 时约 4px，各尺寸视觉一致。
function roundCorners(px, size, radiusRatio = 0.28) {
  const r = Math.max(1, Math.round(size * radiusRatio))
  const rr = r - 0.5 // 角坐标系中的圆心（以角为原点，像素中心计）
  for (let y = 0; y < size; y++) {
    const dy = Math.min(y, size - 1 - y)
    if (dy >= r) continue // 远离边缘，不在任何圆角区
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x)
      if (dx >= r) continue
      // 像素中心到角圆心的距离；圆弧外像素按覆盖率裁掉（线性抗锯齿过渡）
      const dist = Math.hypot(dx + 0.5 - rr, dy + 0.5 - rr)
      const cov = Math.min(1, Math.max(0, r - dist + 0.5))
      const i = (y * size + x) * 4
      px[i + 3] = Math.round(px[i + 3] * cov)
    }
  }
}

// ---------- PNG 编码（RGBA → colorType 6） ----------
function encodePNG(width, height, px) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bitDepth
  ihdr[9] = 6 // colorType RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- ICO 组装（PNG 条目） ----------
function buildICO(pngs) {
  // pngs: [{size, data}]
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  const entries = []
  let offset = 6 + count * 16
  for (const p of pngs) {
    const e = Buffer.alloc(16)
    e[0] = p.size >= 256 ? 0 : p.size
    e[1] = p.size >= 256 ? 0 : p.size
    e[2] = 0 // colors
    e[3] = 0
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(p.data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += p.data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

// ---------- 主流程 ----------
const force = process.argv.includes('--force')
let srcBuf = fs.readFileSync(SRC)
// 源图为 JPEG 时先转 PNG 再进入解码链路
let opaqueWhiteBg = false
if (srcBuf[0] === 0xff && srcBuf[1] === 0xd8 && srcBuf[2] === 0xff) {
  srcBuf = jpegToPNG(SRC)
  opaqueWhiteBg = true // JPEG 无透明通道，白底需裁剪
  console.log('源图为 JPEG，已转换为 PNG')
}
// 已是标准 ICO（头 4 字节 00 00 01 00，LE 存储）→ 源图不是 PNG
else if (srcBuf.readUInt16LE(0) === 0 && srcBuf.readUInt16LE(2) === 1) {
  if (!force) {
    console.log('源文件已是标准 ICO。如需重新生成，请用新的源图覆盖 build/logo.jpg 后再运行。')
    process.exit(0)
  }
  // --force：提取 ICO 中最大尺寸的 PNG 条目作为源图
  const n = srcBuf.readUInt16LE(4)
  let best = null
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16
    const size = srcBuf[o] || 256
    const off = srcBuf.readUInt32LE(o + 12)
    const len = srcBuf.readUInt32LE(o + 8)
    if (!best || size > best.size) best = { size, buf: srcBuf.slice(off, off + len) }
  }
  if (!best) throw new Error('ICO 中无 PNG 条目')
  srcBuf = best.buf
  console.log(`从现有 ICO 提取源图: ${best.size}x${best.size}`)
}
let { width, height, px } = decodePNG(srcBuf)
console.log(`源图: ${width}x${height}`)
if (opaqueWhiteBg) {
  const t = trimWhiteMargins(px, width, height)
  const p = padToSquare(t.px, t.width, t.height)
  px = p.px
  width = p.width
  height = p.height
  console.log(`已裁剪白边并等比居中方化: ${t.width}x${t.height} → ${width}x${height}`)
}

// 缩放前把透明像素置为透明白：双线性插值会在内容边缘与透明像素混合，黑色会发暗、白色自然淡出
for (let i = 0; i < px.length; i += 4) {
  if (px[i + 3] === 0) {
    px[i] = 255
    px[i + 1] = 255
    px[i + 2] = 255
  }
}

const sizes = [256, 64, 48, 32, 16]
const pngs = sizes.map((s) => {
  const rgba = resizeRGBA(px, width, height, s, s)
  roundCorners(rgba, s) // 统一圆角，各尺寸一致
  return { size: s, data: encodePNG(s, s, rgba) }
})
fs.writeFileSync(ICON, buildICO(pngs))
console.log('icon.ico 已生成（标准 ICO，含', sizes.join('/'), 'px）:', ICON)

const tray = pngs.find((p) => p.size === 16)
console.log('TRAY_16_BASE64_START')
console.log(tray.data.toString('base64'))
console.log('TRAY_16_BASE64_END')

const about = pngs.find((p) => p.size === 64)
console.log('ABOUT_64_BASE64_START')
console.log(about.data.toString('base64'))
console.log('ABOUT_64_BASE64_END')
