// 统一应用配置：读取 app/app.config.json（仓库内，便于修改），缺失字段回退默认值
// 仅主进程使用；渲染层所需字段（隐藏列表/时长）经 config:get IPC 暴露
const fs = require('node:fs')
const path = require('node:path')

let electron = null
try {
  electron = require('electron')
} catch {
  /* 非 Electron 环境（如纯 Node 测试）时用 cwd 兜底 */
}
const root = (electron && electron.app && electron.app.getAppPath()) || process.cwd()

const DEFAULTS = {
  skillApiBase: 'http://localhost:4321',
  enginePort: 4096,
  window: { width: 1180, height: 780, minWidth: 900, minHeight: 600, backgroundColor: '#0f1115' },
  hideDirs: ['node_modules', '.git', '.svn', '.next', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.idea', '.vscode'],
  hideFiles: ['.DS_Store', 'Thumbs.db', 'desktop.ini'],
  timings: {
    workspacePollMs: 2000,
    enginePollMs: 4000,
    toastMs: 4000,
    wsSwitchShowMs: 1200,
    wsSwitchFadeMs: 220,
    sseReconnectMs: 2000,
    engineStartTimeoutMs: 20000,
    engineStopTimeoutMs: 5000,
    engineKillWaitMs: 2000,
    engineHealthTimeoutMs: 1500,
    portFreeTimeoutMs: 3000
  }
}

// 两层浅合并：顶层键与嵌套对象（window/timings）均以默认值为底，配置文件覆盖
function load() {
  const cfg = structuredClone(DEFAULTS)
  try {
    const file = JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8'))
    for (const k of Object.keys(DEFAULTS)) {
      const v = file[k]
      if (v === undefined || v === null) continue
      if (DEFAULTS[k] && typeof DEFAULTS[k] === 'object' && !Array.isArray(DEFAULTS[k])) {
        if (v && typeof v === 'object' && !Array.isArray(v)) cfg[k] = { ...DEFAULTS[k], ...v }
      } else {
        cfg[k] = v
      }
    }
  } catch {
    /* 配置缺失/损坏时使用默认值 */
  }
  cfg.skillApiBase = String(cfg.skillApiBase).trim().replace(/\/+$/, '')
  return cfg
}

const cfg = load()

// 用户覆盖层合并：以 base（app.config.json + 默认值）为底，overrides（设置面板保存）逐层覆盖。
// 顶层与 window/timings 两层对象均按字段覆盖，数组（hideDirs/hideFiles）整体替换
function mergeConfig(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return structuredClone(base)
  const out = { ...base }
  for (const k of Object.keys(base)) {
    const v = overrides[k]
    if (v === undefined || v === null) continue
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v }
    } else {
      out[k] = v
    }
  }
  if (typeof out.skillApiBase === 'string') out.skillApiBase = out.skillApiBase.trim().replace(/\/+$/, '')
  return out
}

module.exports = { cfg, mergeConfig }
