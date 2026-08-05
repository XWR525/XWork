// 轻量文件日志：主进程 console 补丁 + 文件写入（单文件 1MB 轮转 × 5）
// 打包版写入 exe 旁 logs/；开发版写入 app/logs/；不可写时回退 userData/logs
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const util = require('node:util')

const MAX_SIZE = 1024 * 1024 // 单个日志文件上限 1MB
const MAX_FILES = 5 // 轮转保留文件数（main.log + main.1..4.log）

// 保存原始 console 方法：补丁内部必须走原始方法，避免写文件时递归触发自身
const orig = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error
}

let logDir = '' // 日志目录（init 后确定）
const streams = new Map() // 文件名 -> { stream, size }（每个文件独立流，便于轮转）

function now() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function format(level, args) {
  return `[${now()}] [${level}] ${util.format(...args)}\n`
}

function fileSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

// 轮转 filename：main.log -> main.1.log -> ... -> main.4.log（删除最旧）
function rotate(filename) {
  const s = streams.get(filename)
  if (!s) return
  try {
    s.stream.end()
    streams.delete(filename)
    const dot = filename.lastIndexOf('.')
    const stem = filename.slice(0, dot)
    const ext = filename.slice(dot)
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = path.join(logDir, `${stem}.${i}${ext}`)
      if (i === MAX_FILES - 1) {
        try {
          fs.unlinkSync(from)
        } catch {
          /* 不存在则忽略 */
        }
      } else {
        const to = path.join(logDir, `${stem}.${i + 1}${ext}`)
        try {
          if (fs.existsSync(from)) fs.renameSync(from, to)
        } catch {
          /* 忽略 */
        }
      }
    }
    const base = path.join(logDir, filename)
    try {
      fs.renameSync(base, path.join(logDir, `${stem}.1${ext}`))
    } catch {
      /* 忽略 */
    }
  } catch {
    /* 轮转失败不致命 */
  }
}

function getStream(filename) {
  let s = streams.get(filename)
  if (!s) {
    try {
      const p = path.join(logDir, filename)
      s = { stream: fs.createWriteStream(p, { flags: 'a' }), size: fileSize(p) }
      streams.set(filename, s)
    } catch {
      return null
    }
  }
  return s
}

// 追加一行日志；超过 1MB 触发该文件轮转
function append(filename, level, args) {
  if (!logDir) return
  const s = getStream(filename)
  if (!s) return
  const line = format(level, args)
  try {
    s.stream.write(line)
  } catch {
    return
  }
  s.size += Buffer.byteLength(line)
  if (s.size >= MAX_SIZE) rotate(filename)
}

// 初始化：确定目录（打包版 exe 旁 / 开发版项目内，不可写则回退 userData）、补丁 console
function init() {
  if (logDir) return
  let candidates = []
  try {
    candidates = app.isPackaged
      ? [
          path.join(path.dirname(process.execPath), 'logs'),
          path.join(app.getPath('userData'), 'logs')
        ]
      : [path.join(app.getAppPath(), 'logs')]
  } catch {
    candidates = []
  }
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, 'main.log'), '') // 探测可写性
      logDir = dir
      break
    } catch {
      /* 该候选不可写，尝试下一个 */
    }
  }
  patchConsole()
  if (logDir) append('main.log', 'INFO', [`[logger] 日志目录: ${logDir}`])
  else orig.error('[logger] 无法创建日志目录，日志仅输出到终端')
}

// 补丁 console：同时输出终端 + 写入 main.log（现有与未来新增的 console 调用自动落盘）
function patchConsole() {
  const map = [
    ['log', 'INFO'],
    ['info', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR']
  ]
  for (const [name, level] of map) {
    const fn = orig[name]
    if (typeof fn !== 'function') continue
    console[name] = (...args) => {
      append('main.log', level, args)
      fn.apply(console, args)
    }
  }
}

// electron-updater 日志适配：写入独立 updater.log（与主进程日志分开，便于单独排查更新问题）
function updaterLogger() {
  return {
    log: (...a) => append('updater.log', 'INFO', a),
    info: (...a) => append('updater.log', 'INFO', a),
    warn: (...a) => append('updater.log', 'WARN', a),
    error: (...a) => append('updater.log', 'ERROR', a),
    debug: (...a) => append('updater.log', 'DEBUG', a)
  }
}

// 渲染进程日志（经 preload 转发）：写入 main.log，带 [renderer] 前缀便于区分来源
function renderer(level, text) {
  append('main.log', level, [`[renderer] ${text}`])
}

// 当前日志目录（未初始化成功时为空字符串）
function dir() {
  return logDir
}

module.exports = { init, updaterLogger, renderer, dir }
