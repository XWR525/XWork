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

// 引擎端口固定为 4096：设置页「配置」已不再暴露该项，配置文件与用户覆盖层均不能改写它
const FIXED_ENGINE_PORT = 4096

const DEFAULTS = {
  skillApiBase: 'http://localhost:4321',
  enginePort: FIXED_ENGINE_PORT,
  // 更新源：内网 Gitea 发布仓库（该仓库只放发布产物，不含源码）。
  // 为什么不直接用内置的 github provider：它在自定义 host 下会请求 /api/v3/repos/...（GitHub Enterprise 约定），
  // 而 Gitea 的 API 是 /api/v1 → 实测 404。故拆成两步：latestApi 解析最新 release 的 tag，
  // downloadBase + tag 拼出该 release 的资产目录（latest.yml / 安装包 / 差分块三份都在那里）。
  updateSource: {
    latestApi: 'http://192.168.99.201:8418/api/v1/repos/xuwr/XWork/releases/latest',
    downloadBase: 'http://192.168.99.201:8418/xuwr/XWork/releases/download'
  },
  window: { width: 1180, height: 780, minWidth: 900, minHeight: 600, backgroundColor: '#f2f4f8' },
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
    portFreeTimeoutMs: 3000,
    // 子智能体（设计 §5.7 / 评审 v3-S-2）：**必须**写在这里 —— 打包产物不含 app.config.json
    // （build.files 只有 out/** + package.json），打包版只有本文件生效；
    // 且每个使用点仍必须写 `?? 默认值`，不得依赖配置文件一定存在
    subagentLiveMs: 200, // 摘要订阅节流
    subagentPollMs: 1500, // 兜底轮询间隔（仅断流时启用）
    subagentStaleMs: 8000, // 多久无事件才启用兜底轮询
    subagentOutcomeGraceMs: 5000, // finalizing 宽限 / outcome 纠偏窗口
    subagentUnknownAfterMs: 15000, // 无事件多久降级为「状态未知」
    subagentPollFailMaxCount: 3 // 兜底轮询连续失败多少次后停止（单位：次，非毫秒）
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
  cfg.enginePort = FIXED_ENGINE_PORT // 端口固定：忽略 app.config.json 中的任何值
  return cfg
}

const cfg = load()

// 用户覆盖层合并：以 base（app.config.json + 默认值）为底，overrides（设置面板保存）逐层覆盖。
// 顶层与 window/timings 两层对象均按字段覆盖，数组（hideDirs/hideFiles）整体替换
function mergeConfig(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return structuredClone(base)
  const out = { ...base }
  for (const k of Object.keys(base)) {
    // 引擎端口固定为 4096：跳过用户覆盖层里的该项（含旧版本已保存的非 4096 值，避免被"锁死"却无法在 UI 改回）
    if (k === 'enginePort') continue
    const v = overrides[k]
    if (v === undefined || v === null) continue
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v }
    } else {
      out[k] = v
    }
  }
  out.enginePort = FIXED_ENGINE_PORT
  if (typeof out.skillApiBase === 'string') out.skillApiBase = out.skillApiBase.trim().replace(/\/+$/, '')
  return out
}

module.exports = { cfg, mergeConfig }
