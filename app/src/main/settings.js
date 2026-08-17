// 设置持久化：模型配置（自定义模型组）
// - apiKey 用 Electron safeStorage 加密存储（Windows DPAPI）
// - 应用时写入 opencode.json 的 provider 段（apiKey 用 {env:VAR} 引用，规避明文落盘）
// - 引擎启动时注入对应环境变量
const fs = require('node:fs')
const path = require('node:path')

// safeStorage 依赖 Electron 运行时；纯 Node 环境（测试）下降级为明文
let safeStorage = null
try {
  ;({ safeStorage } = require('electron'))
} catch {
  /* 非 Electron 环境 */
}

const DEFAULT_SETTINGS = {
  // 自定义模型组：{ id, name, baseURL, apiKey, models[] }，每组 = 一个 OpenAI 兼容 URL + 多个模型 ID
  modelGroups: [],
  // 模型使用统计：providerID/modelID → 消息发送计数（新对话默认最常用模型）
  modelUsage: {},
  workspace: '', // 当前工作区目录（空 = 默认启动目录）
  theme: 'dark', // 界面主题：dark | light（仅影响渲染层，不参与引擎配置）
  closeAction: 'quit', // 点击关闭按钮时的动作：quit = 关闭程序（默认）| tray = 最小化到托盘
  notifyTask: true, // 任务通知：AI 完成回复 / 向你提问时弹系统通知（仅窗口不在前台时）
  // 权限策略：AI 各操作类型的三档配置（创建会话时转为 opencode 规则数组）
  // 标准档：只读/搜索/联网/子任务放行，改文件/执行命令/工作区外访问需确认
  permission: {
    read: 'allow',
    edit: 'ask',
    bash: 'ask',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
    task: 'allow',
    external_directory: 'ask',
    question: 'ask'
  },
  // 应用配置的用户覆盖层：设置面板「配置」页保存的字段（skillApiBase/enginePort/window/hideDirs/hideFiles），
  // 与 app/app.config.json 默认值合并后生效（合并逻辑见 config.js mergeConfig）
  config: {}
}

// 权限类型白名单：仅接受这些 key 的用户配置；其余类型由渲染层固定处理（内部低风险 allow / doom_loop ask）
const PERMISSION_KEYS = Object.keys(DEFAULT_SETTINGS.permission)
// 内部低风险权限类型固定放行（与渲染层 App.jsx 的 INTERNAL_ALLOW_PERMS 保持一致，需同步修改）
const INTERNAL_ALLOW_PERMS = ['todowrite', 'todoread', 'skill', 'lsp', 'codesearch']
const PERMISSION_ACTIONS = ['allow', 'ask', 'deny']

// 校验并归一化权限配置：只保留合法 key 与合法取值，缺失项回退默认
function sanitizePermission(raw) {
  const base = structuredClone(DEFAULT_SETTINGS.permission)
  if (!raw || typeof raw !== 'object') return base
  for (const k of PERMISSION_KEYS) {
    if (PERMISSION_ACTIONS.includes(raw[k])) base[k] = raw[k]
  }
  return base
}

// 渲染进程展示 apiKey 时的掩码值（保存时若仍为该值表示未修改）
const MASK = '••••••'

// 模型组 providerID 前缀（opencode.json 中 provider 段的 key，会话绑定模型后应保持稳定）
const GROUP_PREFIX = 'xgroup-'

// 模型组 id → 环境变量名（仅字母数字，安全）
const envVarOf = (id) => 'XWORK_KEY_' + String(id).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()

// 生成稳定且唯一的模型组 id（由主进程分配，保存时校验格式）
function genGroupId() {
  return GROUP_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function encrypt(plain) {
  if (!plain) return ''
  if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64')
  }
  return 'plain:' + plain
}

function decrypt(stored) {
  if (!stored) return ''
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch {
      return ''
    }
  }
  return stored.startsWith('plain:') ? stored.slice(6) : stored
}

class Settings {
  constructor(file) {
    this.file = file
    this.cache = null
  }

  load() {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.cache = { ...structuredClone(DEFAULT_SETTINGS), ...raw }
    } catch {
      this.cache = structuredClone(DEFAULT_SETTINGS)
    }
    // 迁移清理：内置 DeepSeek 已移除，删除旧版本遗留字段
    delete this.cache.deepseek
    return this.cache
  }

  // 保存：apiKey 为掩码值时不覆盖（保留原值），否则加密；模型组整体同步
  save(raw) {
    const s = this.load()
    if (raw.workspace !== undefined) s.workspace = raw.workspace
    if (raw.theme === 'dark' || raw.theme === 'light') s.theme = raw.theme
    if (raw.closeAction === 'tray' || raw.closeAction === 'quit') s.closeAction = raw.closeAction
    if (typeof raw.notifyTask === 'boolean') s.notifyTask = raw.notifyTask
    // 权限策略：校验归一化后整体替换（11 项齐全，缺失项回退默认）
    if (raw.permission !== undefined) s.permission = sanitizePermission(raw.permission)
    // 应用配置用户覆盖层：整体替换（配置内容已由主进程 config:save 校验）
    if (raw.config && typeof raw.config === 'object') s.config = raw.config
    // 模型组整体同步：新增/编辑/删除均以 raw.modelGroups 为准
    if (Array.isArray(raw.modelGroups)) {
      s.modelGroups = raw.modelGroups
        .filter((g) => g && g.name && g.baseURL && Array.isArray(g.models) && g.models.length)
        .map((g) => {
          const prev = (s.modelGroups || []).find((p) => p.id === g.id)
          return {
            id: /^xgroup-[a-z0-9]+$/i.test(g.id || '') ? g.id : genGroupId(),
            name: String(g.name).trim(),
            baseURL: String(g.baseURL).trim(),
            apiKey: g.apiKey === MASK ? (prev && prev.apiKey ? prev.apiKey : '') : encrypt(g.apiKey),
            models: g.models.map((m) => String(m).trim()).filter(Boolean)
          }
        })
    }
    // 清理旧版本遗留字段（provider 单选 / custom 自定义已被模型组取代）
    delete s.provider
    delete s.custom
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2))
    this.cache = s
    return s
  }

  // 渲染进程可见（apiKey 脱敏）
  public() {
    const s = this.load()
    return {
      theme: s.theme,
      closeAction: s.closeAction,
      notifyTask: s.notifyTask,
      permission: s.permission,
      modelGroups: (s.modelGroups || []).map((g) => ({
        id: g.id,
        name: g.name,
        baseURL: g.baseURL,
        apiKey: g.apiKey ? MASK : '',
        models: g.models
      }))
    }
  }

  // 引擎启动注入的环境变量（明文 Key）
  env() {
    const s = this.load()
    const env = {}
    for (const g of s.modelGroups || []) {
      if (g.apiKey) env[envVarOf(g.id)] = decrypt(g.apiKey)
    }
    return env
  }

  // 记录模型使用（每次消息发送成功后调用）：键 providerID/modelID → 计数
  recordModelUsage(model) {
    const s = this.load()
    const key = (model.providerID || '?') + '/' + (model.modelID || '?')
    s.modelUsage = s.modelUsage || {}
    s.modelUsage[key] = (s.modelUsage[key] || 0) + 1
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2))
    this.cache = s
  }

  // 最常用模型（计数最高；无任何使用记录返回 null）
  frequentModel() {
    const s = this.load()
    const usage = s.modelUsage || {}
    let bestKey = null
    for (const key of Object.keys(usage)) {
      if (!bestKey || usage[key] > usage[bestKey]) bestKey = key
    }
    if (!bestKey) return null
    const i = bestKey.indexOf('/')
    return { providerID: bestKey.slice(0, i), modelID: bestKey.slice(i + 1) }
  }

  // 按 id 取模型组（apiKey 解密为明文，仅供主进程测试连接等场景使用）
  groupById(id) {
    const s = this.load()
    const g = (s.modelGroups || []).find((x) => x.id === id)
    if (!g) return null
    return { ...g, apiKey: g.apiKey ? decrypt(g.apiKey) : '' }
  }
}

// 将设置应用到 opencode.json（保留既有字段，按模型组写入/移除自定义 provider）
// opts.allPermissions=true：任务引擎配置（无人值守，全部操作类型 allow，不弹确认框；question 由事件流自动应答）
function applyToOpencode(configFile, settings, opts = {}) {
  const s = settings.load()
  let cfg = { $schema: 'https://opencode.ai/config.json' }
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch {
    /* 配置不存在或损坏则用默认 */
  }
  // 先移除旧版本遗留 provider（内置 deepseek / 旧 xwork-custom）与当前所有模型组 provider
  // （整体重写，保证删除的组被清除；deepseek 已改由模型组配置）
  if (cfg.provider) {
    for (const key of Object.keys(cfg.provider)) {
      if (key === 'deepseek' || key === 'xwork-custom' || key.startsWith(GROUP_PREFIX)) {
        delete cfg.provider[key]
      }
    }
    if (!Object.keys(cfg.provider).length) delete cfg.provider
  }
  // 写入每个模型组：一组 = 一个 OpenAI 兼容 provider，models 为该组全部模型 ID
  const groups = (s.modelGroups || []).filter((g) => g.baseURL && g.models.length)
  if (groups.length) {
    cfg.provider = cfg.provider || {}
    for (const g of groups) {
      const models = {}
      for (const m of g.models) models[m] = { name: m }
      cfg.provider[g.id] = {
        npm: '@ai-sdk/openai-compatible',
        name: g.name,
        options: {
          baseURL: g.baseURL,
          apiKey: '{env:' + envVarOf(g.id) + '}'
        },
        models
      }
    }
  }
  // 权限规则：任务引擎全 allow；普通引擎按设置档（11 项 + 内部固定项 + doom_loop）
  const permission = {}
  if (opts.allPermissions) {
    // 覆盖 opencode 已知操作类型，全部放行（无人值守不弹确认框）
    const ALL_KEYS = new Set([
      ...PERMISSION_KEYS,
      ...INTERNAL_ALLOW_PERMS,
      'doom_loop', 'write', 'tool', 'agent', 'exact', 'ask',
      'image', 'timeout', 'output', 'scope', 'permission', 'mcp', 'schema', 'env', 'notification', 'admin'
    ])
    for (const k of ALL_KEYS) permission[k] = 'allow'
  } else {
    for (const k of PERMISSION_KEYS) permission[k] = s.permission?.[k] || 'ask'
    for (const k of INTERNAL_ALLOW_PERMS) permission[k] = 'allow'
    permission.doom_loop = 'ask'
  }
  cfg.permission = permission
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2))
}

module.exports = { Settings, applyToOpencode, MASK }
