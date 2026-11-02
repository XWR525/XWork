// 本地相处计数器：undo / abort / permissionDeny / compact / taskRuns
// 文件与 xwork-settings.json 同级（<xdgHome>/xwork-counters.json）；只存 5 个整数。
const fs = require('node:fs')
const path = require('node:path')

const KEYS = ['undo', 'abort', 'permissionDeny', 'compact', 'taskRuns']

function emptyCounters() {
  return { undo: 0, abort: 0, permissionDeny: 0, compact: 0, taskRuns: 0 }
}

class StatsCounters {
  constructor(file) {
    this.file = file
    this.data = this._load()
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const src = raw && raw.counters && typeof raw.counters === 'object' ? raw.counters : {}
      const out = emptyCounters()
      for (const k of KEYS) {
        const n = Number(src[k])
        if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n)
      }
      return { version: 1, counters: out, updatedAt: Number(raw.updatedAt) || 0 }
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        console.warn('[stats-counters] 读取失败，重置为 0:', e.message)
        try {
          fs.renameSync(this.file, this.file + '.bak-' + Date.now())
        } catch {
          /* 备份失败不影响统计 */
        }
      }
      return { version: 1, counters: emptyCounters(), updatedAt: 0 }
    }
  }

  all() {
    return { ...this.data.counters }
  }

  increment(key, n = 1) {
    if (!KEYS.includes(key)) return this.all()
    const add = Number(n)
    if (!Number.isFinite(add) || add <= 0) return this.all()
    this.data.counters[key] = Math.max(0, Math.floor(this.data.counters[key] + add))
    this.data.updatedAt = Date.now()
    this._save()
    return this.all()
  }

  _save() {
    const text = JSON.stringify(this.data, null, 2)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp-' + process.pid
      fs.writeFileSync(tmp, text, 'utf8')
      try {
        fs.renameSync(tmp, this.file)
      } catch {
        // Windows 上 rename 覆盖已存在目标可能失败，退化为直接写
        fs.writeFileSync(this.file, text, 'utf8')
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      console.warn('[stats-counters] 写入失败:', e.message)
    }
  }
}

module.exports = { StatsCounters, KEYS, emptyCounters }
