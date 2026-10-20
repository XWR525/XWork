// 设置持久化：模型配置（自定义模型组）
// - apiKey 用 Electron safeStorage 加密存储（Windows DPAPI）
// - 应用时写入 opencode.json（V2）的 providers 段（apiKey 用 {env:VAR} 引用，规避明文落盘）
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
  theme: 'light', // 界面主题：dark | light（仅影响渲染层，不参与引擎配置）
  // 流式正文揭示效果：emerge = 浮现（默认，模糊→清晰）| typewriter = 打字机（逐字直出，改造前的行为）
  // 纯渲染层偏好，切换即时生效、不重启引擎（设计 §5.6）
  streamReveal: 'emerge',
  closeAction: 'quit', // 点击关闭按钮时的动作：quit = 关闭程序（默认）| tray = 最小化到托盘
  notifyTask: true, // 任务通知：AI 完成回复 / 向你提问时弹系统通知（仅窗口不在前台时）
  // 权限策略：AI 各操作类型的三档配置（生成 V2 permissions 规则数组）
  // 默认严格档：全部操作需询问；用户可在设置面板「权限」页切换为 标准/宽松 档
  // 注：V2 已取消 list 动作，此处不再保留该键（历史设置中的该键会被 sanitize 丢弃）
  permission: {
    read: 'ask',
    edit: 'ask',
    bash: 'ask',
    glob: 'ask',
    grep: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    task: 'ask',
    external_directory: 'ask',
    question: 'ask'
  },
  // 应用配置的用户覆盖层：设置面板「配置」页保存的字段（skillApiBase/window/hideDirs/hideFiles），
  // 与 app/app.config.json 默认值合并后生效（合并逻辑见 config.js mergeConfig）
  // 注意：引擎端口不在此列——它固定为 4096（设置页已隐藏该项），config.js 会忽略任何来源的该字段
  config: {},
  // .agents → .opencode junction 桥接（让 .agents/{agents,commands} 被引擎加载）
  // v1 无 UI：手工编辑 xwork-settings.json 即生效（load() 会读到，save() 会保留）
  agentsBridge: { enabled: true }
}

// 权限类型白名单：仅接受这些 key 的用户配置；其余类型由渲染层固定处理（内部低风险 allow / doom_loop ask）
const PERMISSION_KEYS = Object.keys(DEFAULT_SETTINGS.permission)
// 内部低风险权限类型固定放行（与渲染层 App.jsx 的 INTERNAL_ALLOW_PERMS 保持一致，需同步修改）
// V2 动作集中仅 skill 仍属内部低风险（todowrite/todoread/lsp/codesearch 已无对应动作）
const INTERNAL_ALLOW_PERMS = ['skill']
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
    // 流式揭示档位：只接受两个合法值；手改配置文件写了别的东西时回退默认
    if (this.cache.streamReveal !== 'emerge' && this.cache.streamReveal !== 'typewriter') {
      this.cache.streamReveal = DEFAULT_SETTINGS.streamReveal
    }
    return this.cache
  }

  // 保存：apiKey 为掩码值时不覆盖（保留原值），否则加密；模型组整体同步
  save(raw) {
    const s = this.load()
    if (raw.workspace !== undefined) s.workspace = raw.workspace
    if (raw.theme === 'dark' || raw.theme === 'light') s.theme = raw.theme
    if (raw.closeAction === 'tray' || raw.closeAction === 'quit') s.closeAction = raw.closeAction
    if (typeof raw.notifyTask === 'boolean') s.notifyTask = raw.notifyTask
    if (raw.streamReveal === 'emerge' || raw.streamReveal === 'typewriter') s.streamReveal = raw.streamReveal
    // 权限策略：校验归一化后整体替换（11 项齐全，缺失项回退默认）
    if (raw.permission !== undefined) s.permission = sanitizePermission(raw.permission)
    // 应用配置用户覆盖层：整体替换（配置内容已由主进程 config:save 校验）
    if (raw.config && typeof raw.config === 'object') s.config = raw.config
    // .agents 桥接开关：只接受布尔；其余形态忽略（保持原值）
    if (raw.agentsBridge !== undefined && typeof raw.agentsBridge === 'object' && raw.agentsBridge !== null) {
      if (typeof raw.agentsBridge.enabled === 'boolean') {
        s.agentsBridge = { ...(s.agentsBridge || {}), enabled: raw.agentsBridge.enabled }
      }
    }
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
      streamReveal: s.streamReveal,
      closeAction: s.closeAction,
      notifyTask: s.notifyTask,
      permission: s.permission,
      agentsBridge: { enabled: s.agentsBridge?.enabled !== false },
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

// 固定内置的 AI 身份指令：写入引擎全局 AGENTS.md（opencode 启动时自动加载到所有会话），
// 使模型自我认知为 XWork 而非 opencode；对话引擎与任务引擎共用 applyToOpencode，一次写入两者均生效
const XWORK_IDENTITY = `# XWork 身份声明

你是 XWork —— 桌面端 AI 工作台 XWork 的内置 AI 助手（XWork 基于开源Agent引擎构建，对用户统一以 XWork 身份出现）。

当用户询问你的身份、名字或出身（例如「你是谁」「你叫什么」「你是哪个 AI」）时，明确回答你是「XWork」。

需要提及底层执行引擎或框架时，一律称作「XWork 执行引擎」，不要向用户提及或列举具体第三方引擎 / 框架的名称。

# 语言要求

回复用户时始终使用中文（这是固定要求）：所有叙述、解释、总结、提问、反馈一律用中文输出；代码、命令、文件名、API 名称、专有名词等可保留原文，但围绕它们的说明文字必须是中文。除非用户在本条会话中明确要求使用其它语言，否则不要切换为英文或其它语言。
`

// 将设置应用到 opencode.json（V2 原生格式：providers 映射 + permissions 有序规则数组）
// opts.allPermissions=true：任务引擎配置（无人值守，一条通配 allow 规则，不弹确认框；question 由事件流自动应答）
function applyToOpencode(configFile, settings, opts = {}) {
  const s = settings.load()
  let cfg = { $schema: 'https://opencode.ai/config.json' }
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch {
    /* 配置不存在或损坏则用默认 */
  }
  // 清理 V1 遗留段（V2 虽可自动归一化，但原生格式 diff 可控，不依赖归一化层）
  delete cfg.provider
  delete cfg.permission
  // 模型组整体重写：**先移除全部旧的 xgroup-* provider**，再按当前设置写入。
  // 只增不删会导致「设置里删掉的模型组仍留在引擎里」（可被选到），且其 {env:} 引用在引擎进程中不存在，
  // 会让配置热重载的环境守卫永远判定「必须重启」（实测踩坑）
  const groups = (s.modelGroups || []).filter((g) => g.baseURL && g.models.length)
  if (cfg.providers && typeof cfg.providers === 'object') {
    for (const key of Object.keys(cfg.providers)) {
      if (key.startsWith(GROUP_PREFIX)) delete cfg.providers[key]
    }
    if (!Object.keys(cfg.providers).length) delete cfg.providers
  }
  // 写入每个模型组：一组 = 一个 OpenAI 兼容 provider，models 为该组全部模型 ID
  if (groups.length) {
    cfg.providers = cfg.providers || {}
    for (const g of groups) {
      const models = {}
      for (const m of g.models) models[m] = { name: m }
      cfg.providers[g.id] = {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: g.name,
        settings: {
          baseURL: g.baseURL,
          apiKey: '{env:' + envVarOf(g.id) + '}'
        },
        models
      }
    }
  }
  cfg.permissions = buildPermissionRules(s, opts)
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2))
  // 注入 AI 身份指令：写入同目录的全局 AGENTS.md，opencode 启动时自动加载，无需改动 opencode.json
  fs.writeFileSync(path.join(path.dirname(configFile), 'AGENTS.md'), XWORK_IDENTITY)
}

// XWork 设置存储键（V1 命名）→ V2 权限 action 的映射（存储层不动，仅生成引擎配置时转换）
const V2_ACTION_MAP = {
  read: 'read',
  edit: 'edit',
  bash: 'shell', // V2 改名：bash → shell
  glob: 'glob',
  grep: 'grep',
  // list：V2 已取消该动作类型，跳过
  webfetch: 'webfetch',
  websearch: 'websearch',
  task: 'subagent', // V2 改名：task → subagent
  external_directory: 'external_directory',
  question: 'question'
}

// 生成 V2 permissions 规则数组（有序，最后匹配胜出）
// 任务引擎全放行 = 一条通配规则；普通引擎 = 各操作类型三档 + 内部低风险（skill）放行
function buildPermissionRules(s, opts = {}) {
  if (opts.allPermissions) {
    return [{ action: '*', resource: '*', effect: 'allow' }]
  }
  const rules = []
  for (const k of PERMISSION_KEYS) {
    const action = V2_ACTION_MAP[k]
    if (!action) continue
    rules.push({ action, resource: '*', effect: s.permission?.[k] || 'ask' })
  }
  // 内部固定放行：V2 仅保留 skill 动作（todowrite/todoread/lsp/codesearch 已无对应动作）
  if (INTERNAL_ALLOW_PERMS.includes('skill')) {
    rules.push({ action: 'skill', resource: '*', effect: 'allow' })
  }
  return rules
}

module.exports = { Settings, applyToOpencode, MASK }
