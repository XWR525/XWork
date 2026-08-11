import React, { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
marked.setOptions({ gfm: true, breaks: true })

// 空会话问候语：按时间段分组，随机取一条（localStorage 记录上次索引避免连续重复）
const GREETINGS = [
  { from: 5, to: 11, items: [
    { title: '🌞 早安，开始今天的工作吧', sub: '把要做的事交给 AI，或先从一个新对话开始' },
    { title: '🚀 新的一天，新的想法', sub: '想好要解决什么问题了吗？' }
  ]},
  { from: 12, to: 18, items: [
    { title: '☕ 下午好，趁现在把想法落地', sub: '有什么需要帮忙处理的？' },
    { title: '📌 下午好，继续推进', sub: '打开工作区，或直接聊聊你的计划' }
  ]},
  { from: 19, to: 23, items: [
    { title: '🌙 晚上好，专注时刻', sub: '把白天的想法整理成行动' },
    { title: '💡 晚间灵感最活跃', sub: '想聊点什么？AI 随时待命' }
  ]},
  { from: 0, to: 4, items: [
    { title: '🕛 还在奋斗，注意休息', sub: '保持节奏，随时可以开始' },
    { title: '🌌 深夜效率高，也别太晚', sub: '简短任务也可以先丢过来' }
  ]}
]

function pickGreeting() {
  const h = new Date().getHours()
  const group = GREETINGS.find((g) => h >= g.from && h <= g.to) || GREETINGS[0]
  let idx = Math.floor(Math.random() * group.items.length)
  const last = Number(localStorage.getItem('xwork-greeting') || -1)
  if (group.items.length > 1 && idx === last) idx = (idx + 1) % group.items.length
  localStorage.setItem('xwork-greeting', String(idx))
  return group.items[idx]
}

// 权限设置：AI 各操作类型清单（设置面板展示，用户可配 允许/询问/禁止）
const PERMISSION_ITEMS = [
  { key: 'read', label: '读取文件', desc: '读取工作区内文件内容' },
  { key: 'edit', label: '修改文件', desc: '编辑 / 新建 / 覆写文件（edit/write/patch）' },
  { key: 'bash', label: '执行命令', desc: '在终端执行命令（含删除、移动等，PowerShell）' },
  { key: 'glob', label: '文件查找', desc: '按模式查找文件（glob）' },
  { key: 'grep', label: '内容搜索', desc: '在文件中搜索文本（grep）' },
  { key: 'list', label: '目录列举', desc: '列出目录内容（list）' },
  { key: 'webfetch', label: '网页抓取', desc: '抓取指定网页内容' },
  { key: 'websearch', label: '联网搜索', desc: '搜索互联网获取信息' },
  { key: 'task', label: '子任务', desc: 'AI 启动子 Agent 并行处理' },
  { key: 'external_directory', label: '工作区外访问', desc: '访问当前工作区之外的路径' },
  { key: 'question', label: '向用户提问', desc: 'AI 主动向你提问，等待你的回答' }
]

// 预设档位：严格（全确认） / 标准（只读放行，改动确认） / 宽松（全部放行）
const PERMISSION_PRESETS = {
  严格: { read: 'ask', edit: 'ask', bash: 'ask', glob: 'ask', grep: 'ask', list: 'ask', webfetch: 'ask', websearch: 'ask', task: 'ask', external_directory: 'ask', question: 'ask' },
  标准: { read: 'allow', edit: 'ask', bash: 'ask', glob: 'allow', grep: 'allow', list: 'allow', webfetch: 'allow', websearch: 'allow', task: 'allow', external_directory: 'ask', question: 'ask' },
  宽松: { read: 'allow', edit: 'allow', bash: 'allow', glob: 'allow', grep: 'allow', list: 'allow', webfetch: 'allow', websearch: 'allow', task: 'allow', external_directory: 'allow', question: 'allow' }
}

// 设置页不展示的内部类型：低风险固定放行；doom_loop 保留防死循环询问
// （与主进程 settings.js 的 INTERNAL_ALLOW_PERMS 保持一致，需同步修改）
const INTERNAL_ALLOW_PERMS = ['todowrite', 'todoread', 'skill', 'lsp', 'codesearch']

// 权限类型 → 当前全局设置的动作（自动应答兜底与全局规则共用同一规则源）
// 内部低风险固定 allow；doom_loop 固定 ask；其余按已保存设置，缺失回退 ask
function globalPermAction(key, permCfg) {
  if (INTERNAL_ALLOW_PERMS.includes(key)) return 'allow'
  if (key === 'doom_loop') return 'ask'
  return (permCfg && permCfg[key]) || 'ask'
}

// 文件树中默认隐藏的常见大目录/无关文件（避免误操作与列表冗长）
// 默认值，可被 app/app.config.json 的 hideDirs/hideFiles 覆盖
const HIDE_DIRS = new Set(['node_modules', '.git', '.svn', '.next', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.idea', '.vscode'])
const HIDE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

// 各轮询/提示时长默认值，可被 app/app.config.json 的 timings 覆盖
const DEFAULT_TIMINGS = {
  workspacePollMs: 2000,
  enginePollMs: 4000,
  toastMs: 4000,
  wsSwitchShowMs: 1200,
  wsSwitchFadeMs: 220
}

// 文件图标：按扩展名映射到 emoji（资源管理器风格，按文件类型显示）
const FILE_ICONS = {
  js: '🟨', mjs: '🟨', cjs: '🟨', ts: '🟦', jsx: '🟨', tsx: '🟦',
  py: '🐍', java: '☕', go: '🐹', rs: '🦀', rb: '💎', php: '🐘',
  c: '⚙️', h: '⚙️', cpp: '⚙️', cc: '⚙️', cs: '⚙️',
  sh: '🐚', ps1: '🪟', bat: '🪟', cmd: '🪟',
  html: '🌐', htm: '🌐', css: '🎨', scss: '🎨', less: '🎨', vue: '💚', svelte: '🔥',
  json: '📋', yaml: '📋', yml: '📋', toml: '📋', xml: '📋', ini: '📋', conf: '📋', config: '📋',
  md: '📝', markdown: '📝', txt: '📄', log: '📜',
  doc: '📄', docx: '📄', rtf: '📄', pdf: '📕',
  xls: '📊', xlsx: '📊', csv: '📊',
  ppt: '📽️', pptx: '📽️',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', ico: '🖼️', bmp: '🖼️',
  mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵',
  mp4: '🎬', avi: '🎬', mov: '🎬', webm: '🎬', mkv: '🎬',
  zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
  exe: '⚙️', msi: '⚙️', dll: '🧩', lock: '🔒', db: '🗄️', sql: '🗄️'
}
function fileIcon(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return '📄'
  return FILE_ICONS[name.slice(dot + 1).toLowerCase()] || '📄'
}

// 路径归一化：统一分隔符与大小写，用于会话目录与当前工作区的比较（Windows 路径不区分大小写）
const normDir = (p) => (p || '').replace(/\\/g, '/').toLowerCase()

// 从引擎消息 info 提取可读错误信息（opencode 错误为 {name, data:{message}} 嵌套结构）；
// abort 类错误由「已停止」徽标单独表达，不在此展示
function extractError(info) {
  const err = info?.error
  if (!err) return ''
  if (/abort/i.test(err.name || '')) return ''
  const d = err.data
  const msg = (d && (d.message || d.error?.message)) || err.message || err.name
  return typeof msg === 'string' ? msg : JSON.stringify(msg)
}

// 将引擎返回的消息数组规范化为渲染结构
// 从引擎加载的消息均为完整内容：直接渲染全文，不再走打字机逐字揭示
function normalize(list) {
  return (list || []).map((m) => ({
    id: m.info.id,
    role: m.info.role,
    time: m.info.time?.created,
    aborted: !!(m.info.error && /abort/i.test(m.info.error.name || '')),
    error: extractError(m.info),
    parts: (m.parts || []).map((p) => ({
      id: p.id,
      callID: p.callID,
      type: p.type,
      text: p.text || '',
      tool: p.tool,
      state: p.state
    }))
  }))
}

// 当前上下文 token 量：最近一条带有效统计的 assistant 消息的 info.tokens（引擎实际返回位置），
// input + cache.read 即实际发送给模型的上下文量；回复失败/未完成时引擎写入全 0 统计，
// 此时向上跳过、沿用上一条成功回复的统计；无任何有效统计（新会话/从未成功）返回 null
function ctxTokenCount(rawMsgs) {
  const list = rawMsgs || []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.info?.role !== 'assistant') continue
    const t = m.info?.tokens
    if (!t) continue
    const n = (t.input || 0) + ((t.cache && t.cache.read) || 0)
    if (n > 0) return n // 全 0 统计（失败/未完成）跳过，继续向上找上一条成功的上下文量
  }
  return null
}

// token 数格式化：千 → k（一位小数），百万 → M
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n || 0))
}

// 会话时间显示：MM-DD HH:MM（跨年仍只显示月日，足够区分活跃度）
function fmtDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 工具调用开始时刻：epoch 毫秒 → HH:MM:SS（任务面板工具卡片用；引擎 state.time.start）
function fmtClock(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 工具调用耗时：end - start → 人类可读（0.4s / 12.3s / 2m 05s）；进行中或无 end 返回空
function fmtDur(start, end) {
  if (!start || !end) return ''
  const ms = end - start
  if (ms < 0) return ''
  if (ms < 1000) return ms + 'ms'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + 's'
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  return `${m}m ${String(rs).padStart(2, '0')}s`
}

const STATUS_LABEL = { pending: '等待', running: '执行中', completed: '完成', error: '失败' }

// 目标 user 消息之后是否存在 AI 工具调用（决定「回退至此」按钮是否可用）
function hasToolChangeAfter(messages, idx) {
  for (let i = idx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if ((m.parts || []).some((p) => p.type === 'tool')) return true
  }
  return false
}

// undo 后「实际影响清单」的类型文案（主进程 collectUndoImpact 分类：delete/restore/recover，见 undo功能设计.md §6.3）
const UNDO_IMPACT_META = {
  delete: { icon: '❌', note: '已删除（本轮新建）' },
  restore: { icon: '✏️', note: '已还原到本轮之前' },
  recover: { icon: '✅', note: '已找回（本轮被删/改名，undo 后恢复）' }
}

// 任务执行面板分页：默认展示最近 TOOL_PAGE 条工具步骤（执行中最关心的是底部最新条目），
// 点击「加载更早」每次追加 TOOL_PAGE 条；有界 DOM 保证展开/收起动画每帧重排成本恒定，长任务不卡顿
const TOOL_PAGE = 20

export default function App() {
  const [engine, setEngine] = useState({ running: false, version: null, port: 4096 })
  const [engineError, setEngineError] = useState('')
  const [sessions, setSessions] = useState([])
  const [currentID, setCurrentID] = useState(null)
  // 置顶会话顺序：数组最前 = 显示最上；后置顶的 unshift 到最前；localStorage 持久化
  const [pinnedOrder, setPinnedOrder] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('xwork-pinned') || '[]')
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  })
  const [menu, setMenu] = useState(null) // 会话操作菜单：{ sid, x, y }，null = 关闭
  const dragIdRef = useRef(null) // 拖拽排序中的会话 id
  const [dropPos, setDropPos] = useState(null) // 拖动时指示线的插入位置（置顶区索引，null = 无指示）
  const pinItemRefs = useRef(new Map()) // 置顶会话项 DOM 引用（id -> node），用于拖动时坐标定位
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [input, setInput] = useState('')
  const [perm, setPerm] = useState(null) // 待处理的权限请求
  const [confirm, setConfirm] = useState(null) // 项目风格确认框 {title, message, danger?, confirmLabel?, onConfirm}
  const [question, setQuestion] = useState(null) // AI 提问 {id, sessionID, questions[]}
  const [qSel, setQSek] = useState([]) // 每题选中的选项 label（string[][]）
  const [qText, setQText] = useState([]) // 每题输入框草稿（string[]）
  const [qOther, setQOther] = useState([]) // 每题「其它（自行输入）」是否激活（boolean[]）
  const [toast, setToast] = useState('') // 操作提示
  const [greeting, setGreeting] = useState(pickGreeting) // 空会话问候语（每次新对话重取）
  const [editingID, setEditingID] = useState(null) // 正在重命名的会话
  const [editingTitle, setEditingTitle] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false) // 设置面板
  const [skillHubOpen, setSkillHubOpen] = useState(false) // SKILL HUB 弹窗
  const [skills, setSkills] = useState([]) // 技能列表（来自本地技能服务，按 sort_order 升序）
  const [skillLoading, setSkillLoading] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [skillInstalled, setSkillInstalled] = useState({}) // 已安装技能 slug 集合（来自 .agents/skills 扫描）
  const [skillBusy, setSkillBusy] = useState(null) // 安装中的技能 id（按钮禁用防重复点击）
  const [settingsData, setSettingsData] = useState(null) // 脱敏后的设置
  const [appConfig, setAppConfig] = useState(null) // 有效应用配置（设置面板「配置」页表单）
  const [compacting, setCompacting] = useState(false) // 压缩会话进行中（引擎总结并替换历史，等效 /compact）
  const [ctxTokens, setCtxTokens] = useState(null) // 当前上下文 token 量（最近 assistant 消息 info.tokens 的 input+cache.read，null = 无数据）
  // 「回退至此」：待轻确认的回退信息（messageID + 回退后填入输入框的用户原文）与 git 可用状态
  // undoResult：回退完成后的实际影响清单（{ impact:[{path,type}] }，null = 不展示）
  const [undoDraft, setUndoDraft] = useState(null)
  const [undoResult, setUndoResult] = useState(null)
  const [gitState, setGitState] = useState({ available: false, isGit: false })
  // 已保存的权限配置（自动应答兜底用）：onEvent 回调是 [ ] 闭包，必须经 ref 读取最新值
  const permCfgRef = useRef(null)
  const [appInfo, setAppInfo] = useState(null) // 应用版本信息（「关于」面板）
  const [theme, setTheme] = useState('dark') // 界面主题：dark | light
  const [modelSel, setModelSel] = useState(null) // 当前会话选择的模型 {providerID, modelID}，null = 未选择（发送前必须有效）
  const [agent, setAgent] = useState('build') // 当前会话的模式（opencode agent：build 默认 / plan 只读规划）

  // 工作区：当前目录 + 文件树（懒加载）+ 已添加文件（相对路径清单）
  const [workspace, setWorkspace] = useState('')
  const [wsChildren, setWsChildren] = useState({}) // 目录绝对路径 -> [{name,type}]
  const [expandedDirs, setExpandedDirs] = useState({}) // 已展开目录绝对路径 -> true
  const [addedFiles, setAddedFiles] = useState([]) // 已添加文件（相对工作区路径，发送时注入）
  const [ctxMenu, setCtxMenu] = useState(null) // 文件右键菜单 {x, y, abs, rel, type, name}
  const [sideTab, setSideTab] = useState('chat') // 侧栏分段：chat（对话历史）| files（工作区文件）
  const [panelOpen, setPanelOpen] = useState(false) // 任务执行面板：默认折叠，执行中由收起窄条上的圆点闪烁提示
  const [sidebarW, setSidebarW] = useState(240) // 左边栏宽度（拖动边缘调整）
  const [taskW, setTaskW] = useState(300) // 任务面板展开宽度（拖动边缘调整）
  const [toolVisible, setToolVisible] = useState(TOOL_PAGE) // 任务面板已展示的工具步骤数（分页：从最新向前展示，按钮加载更早）
  const [composerH, setComposerH] = useState(null) // 输入区高度（拖动上缘调整，null = 按内容自适应）
  // 渲染层配置（来自 app/app.config.json，经 config:get IPC 获取）：文件树隐藏列表 + 各时长
  const [hideDirs, setHideDirs] = useState(HIDE_DIRS)
  const [hideFiles, setHideFiles] = useState(HIDE_FILES)
  const [timings, setTimings] = useState(DEFAULT_TIMINGS)
  const [wsSwitching, setWsSwitching] = useState(null) // 工作区切换中（= 目标目录，null = 空闲），驱动切换遮罩

  const listRef = useRef(null)
  const listStickRef = useRef(true) // 对话区是否贴底：上滑即 false，滚回底部自动恢复
  const [showNewHint, setShowNewHint] = useState(false) // 上滑停止跟随期间有新内容时，显示「↓ 新消息」提示
  const currentRef = useRef(currentID)
  currentRef.current = currentID
  const workspaceRef = useRef(workspace) // 供事件处理器取最新工作区（闭包防过期）
  workspaceRef.current = workspace
  const expandedRef = useRef(expandedDirs) // 供事件处理器取最新展开目录
  expandedRef.current = expandedDirs
  const wsTimer = useRef(null) // 遮罩「已切换到」提示的收起定时器
  const wsPollBusy = useRef(false) // 文件树轮询防重入（上次未完成时跳过本次）

  const api = window.xwork

  const refreshSessions = async () => {
    try {
      setSessions(await api.sessionList())
    } catch (e) {
      console.error('session list failed', e)
    }
  }

  const loadSession = async (sid) => {
    setCurrentID(sid)
    setBusy(false)
    setStopping(false)
    // 恢复该会话绑定的模型（opencode 将模型持久化在会话 model 字段）
    const s = sessions.find((x) => x.id === sid)
    if (s?.model?.providerID) setModelSel({ providerID: s.model.providerID, modelID: s.model.id })
    try {
      const msgs = await api.messageList(sid)
      setMessages(normalize(msgs))
      setCtxTokens(ctxTokenCount(msgs)) // 刷新上下文 token 统计
      // 恢复该会话绑定的模式：优先会话字段，其次最后一条用户消息（opencode 在消息上记录 agent）
      let ag = s?.agent
      if (!ag) {
        const users = (msgs || []).filter((m) => m.info?.role === 'user')
        ag = users.length ? users[users.length - 1].info?.agent : ''
      }
      setAgent(ag === 'plan' ? 'plan' : 'build')
    } catch (e) {
      console.error('load messages failed', e)
      setCtxTokens(null)
    }
  }

  // 从引擎状态同步当前工作区并加载根目录文件树
  const loadWorkspace = async () => {
    try {
      const st = await api.engineStatus()
      const ws = st.workspace || ''
      setWorkspace(ws)
      if (ws) {
        refreshInstalled() // 打开工作区时扫描已安装技能
        const list = await api.workspaceListDir(ws)
        if (list && !list.error) setWsChildren((c) => ({ ...c, [ws]: list }))
      }
    } catch (e) {
      console.error('load workspace failed', e)
    }
  }

  // 重新加载工作区文件树：根目录 + 已展开目录（AI 写入/编辑文件后实时刷新）
  const refreshWsTree = async () => {
    const ws = workspaceRef.current
    if (!ws) return
    try {
      const list = await api.workspaceListDir(ws)
      if (list && !list.error) {
        setWsChildren((c) => ({ ...c, [ws]: list }))
        const dirs = Object.keys(expandedRef.current).filter((d) => expandedRef.current[d])
        await Promise.all(
          dirs.map(async (d) => {
            try {
              const sub = await api.workspaceListDir(d)
              if (sub && !sub.error) setWsChildren((c) => ({ ...c, [d]: sub }))
            } catch {
              /* 单个目录读取失败忽略 */
            }
          })
        )
      }
    } catch (e) {
      console.error('refresh workspace tree failed', e)
    }
  }

  // 工作区文件树实时刷新：切到「工作区」Tab 立即刷新一次，此后每 2s 轮询根目录与已展开目录，
  // 使资源管理器中的新增/删除同步显示（与 AI 写入后的即时刷新互补）
  useEffect(() => {
    if (sideTab !== 'files' || !workspace) return
    const tick = async () => {
      if (wsPollBusy.current) return
      wsPollBusy.current = true
      try {
        await refreshWsTree()
      } finally {
        wsPollBusy.current = false
      }
    }
    tick()
    const timer = setInterval(tick, timings.workspacePollMs)
    return () => clearInterval(timer)
  }, [sideTab, workspace, timings])

  // 切换到指定工作区（引擎重启，新 cwd）；「打开文件夹」与「所有工作区」共用
  const switchTo = async (dir) => {
    if (!dir || dir === workspace) return
    try {
      if (wsTimer.current) clearTimeout(wsTimer.current)
      setWsSwitching({ dir, done: false }) // 遮罩淡入，覆盖引擎重启的等待期
      const r = await api.workspaceSwitch(dir)
      if (!r.ok) {
        setWsSwitching(null)
        setToast('切换失败: ' + (r.error || '未知错误'))
        return
      }
      const ws = r.status?.workspace || dir
      setWorkspace(ws)
      setCurrentID(null)
      setMessages([])
      setBusy(false)
      setStopping(false)
      setAddedFiles([])
      setExpandedDirs({})
      setCtxMenu(null)
      refreshSessions()
      const list = await api.workspaceListDir(ws)
      if (list && !list.error) setWsChildren({ [ws]: list })
      // 中央提示「已切换到」停留后淡出收起（leaving 触发透明度过渡，结束后卸载）
      setWsSwitching({ dir: ws, done: true })
      wsTimer.current = setTimeout(() => {
        setWsSwitching({ dir: ws, done: true, leaving: true })
        wsTimer.current = setTimeout(() => setWsSwitching(null), timings.wsSwitchFadeMs)
      }, timings.wsSwitchShowMs)
    } catch (e) {
      if (wsTimer.current) clearTimeout(wsTimer.current)
      setWsSwitching(null)
      console.error('switch workspace failed', e)
      setToast('切换工作区失败: ' + e.message)
    }
  }

  // 选择并切换到新工作区（系统目录选择对话框）
  const openWorkspace = async () => {
    try {
      const dir = await api.workspacePick()
      if (dir) await switchTo(dir)
    } catch (e) {
      setToast('选择工作区失败: ' + e.message)
    }
  }

  // 「所有工作区」折叠列表：展开时从会话数据聚合各工作区（目录名 + 会话数 + 最近使用）
  const [wsAllOpen, setWsAllOpen] = useState(false)
  const [allWs, setAllWs] = useState([])
  const toggleWsAll = async () => {
    const next = !wsAllOpen
    setWsAllOpen(next)
    if (next) {
      try {
        setAllWs(await api.workspaceList())
      } catch {
        setAllWs([])
      }
    }
  }

  // 展开/折叠目录（懒加载子项）
  const toggleDir = async (abs) => {
    if (expandedDirs[abs]) {
      setExpandedDirs((d) => ({ ...d, [abs]: false }))
      return
    }
    setExpandedDirs((d) => ({ ...d, [abs]: true }))
    if (!wsChildren[abs]) {
      try {
        const list = await api.workspaceListDir(abs)
        if (list && !list.error) setWsChildren((c) => ({ ...c, [abs]: list }))
      } catch {
        /* 读取失败则不加载 */
      }
    }
  }

  // 绝对路径 → 相对工作区路径（AI 直接可用的路径）
  const relOf = (abs) => abs.slice(workspace.length).replace(/^[\\/]/, '')

  // 添加/移除文件（存储相对工作区路径，发送时注入）
  const toggleAdd = (rel) => {
    setAddedFiles((cur) => (cur.includes(rel) ? cur.filter((x) => x !== rel) : [...cur, rel]))
  }

  // 右键菜单：记录位置与目标，阻止浏览器默认菜单
  const openCtxMenu = (e, item) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, ...item })
  }

  // 点击页面其它区域关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [ctxMenu])

  // 全局事件流处理
  useEffect(() => {
    const off = api.onEvent((evt) => {
      const p = evt.properties || {}
      const cur = currentRef.current
      switch (evt.type) {
        case 'server.connected':
          // 引擎就绪后刷新状态（engineStart 返回时引擎可能尚未健康）
          api.engineStatus().then((st) => setEngine(st)).catch(() => {})
          loadWorkspace()
          loadModels() // 引擎重启后刷新模型下拉（新 provider 注册完成）
          break
        case 'session.created':
        case 'session.updated':
          refreshSessions()
          break
        case 'message.part.delta': {
          // 流式文本增量（{messageID, partID, field, delta}）
          if (p.sessionID !== cur || p.field !== 'text') return
          const mid = p.messageID
          if (!mid) return
          setMessages((ms) => {
            const i = ms.findIndex((m) => m.id === mid)
            if (i < 0) {
              // 新消息按时间顺序追加到末尾（AI 回复应直接出现在对话列表底部）
              return [...ms, { id: mid, role: 'assistant', streaming: true, streamed: true, parts: [{ type: 'text', text: p.delta || '' }] }]
            }
            const clone = ms.slice()
            const m = clone[i]
            // 已最终落定的消息不再追加 delta（避免 settle 后残留 delta 造成文本重复/不一致）
            if (m.settled) return ms
            const parts = m.parts.slice()
            // 增量优先按 partID 归属 reasoning part（思考文本也走 delta 流式），
            // 使思考内容从首个字符起就在引用块内渲染，而不是先落入正文、结束后才归位
            const ri = parts.findIndex((x) => x.id === p.partID && x.type === 'reasoning')
            if (ri >= 0) {
              parts[ri] = { ...parts[ri], text: (parts[ri].text || '') + (p.delta || '') }
            } else {
              const ti = parts.findIndex((x) => x.type === 'text')
              if (ti >= 0) parts[ti] = { ...parts[ti], text: (parts[ti].text || '') + (p.delta || '') }
              else parts.unshift({ type: 'text', text: p.delta || '' })
            }
            // 无条件进入流式：无论消息当前是否标记流式，delta 都必须累积显示
            clone[i] = { ...m, parts, streaming: true, streamed: true }
            return clone
          })
          break
        }
        case 'message.part.updated': {
          if (p.sessionID !== cur) return
          const part = p.part
          // 注意：messageID 在 part 内部（如 part.messageID），顶层可能没有
          const mid = part?.messageID || p.messageID
          if (!mid || !part) break
          if (part.type === 'text') {
            // 更新文本内容并保持流式模式（引擎在 delta 流式中途也会推 updated，
            // 若此时退出流式，后续 delta 会被丢弃导致文本「整段跳出」）
            setMessages((ms) => {
              const i = ms.findIndex((m) => m.id === mid)
              if (i < 0) return ms
              const clone = ms.slice()
              const m = clone[i]
              const parts = m.parts.slice()
              const ti = parts.findIndex((x) => x.type === 'text')
              if (ti >= 0) parts[ti] = { ...parts[ti], text: part.text }
              else parts.unshift({ type: 'text', text: part.text })
              clone[i] = { ...m, parts, streaming: true, streamed: true }
              return clone
            })
          } else if (part.type === 'reasoning') {
            // 思考过程更新（完整替换当前文本；reasoning 增量经 delta 事件按 partID 路由到此处，
            // 因此必须保留 part.id，使引用块从流式起点就开始累积显示）
            setMessages((ms) => {
              const i = ms.findIndex((m) => m.id === mid)
              if (i < 0) {
                return [...ms, { id: mid, role: 'assistant', streaming: true, streamed: true, parts: [{ id: part.id, type: 'reasoning', text: part.text || '' }] }]
              }
              const clone = ms.slice()
              const m = clone[i]
              const parts = m.parts.slice()
              const ri = parts.findIndex((x) => x.type === 'reasoning')
              if (ri >= 0) parts[ri] = { ...parts[ri], id: part.id, text: part.text }
              else parts.unshift({ id: part.id, type: 'reasoning', text: part.text || '' })
              clone[i] = { ...m, parts, streaming: true, streamed: true }
              return clone
            })
          } else if (part.type === 'tool') {
            // 工具调用状态实时更新（pending → running → completed/error）
            setMessages((ms) => {
              const i = ms.findIndex((m) => m.id === mid)
              if (i < 0) {
                // 消息尚未出现（无文本增量）→ 创建占位追加到末尾，保证实时状态可渲染
                return [...ms, { id: mid, role: 'assistant', streamed: true, parts: [{ id: part.id, callID: part.callID, type: 'tool', tool: part.tool, state: part.state }] }]
              }
              const clone = ms.slice()
              const m = clone[i]
              const parts = m.parts.slice()
              const ti = parts.findIndex((x) => x.type === 'tool' && (x.id === part.id || x.callID === part.callID))
              if (ti >= 0) parts[ti] = { ...parts[ti], tool: part.tool, state: part.state }
              else parts.push({ id: part.id, callID: part.callID, type: 'tool', tool: part.tool, state: part.state })
              clone[i] = { ...m, parts, streamed: true }
              return clone
            })
            // 写入/编辑类工具执行完成 → 实时刷新左侧文件树（新文件立即可见）
            if (part.state?.status === 'completed') refreshWsTree()
          }
          break
        }
        case 'message.updated': {
          // 消息完成（含 finish）→ 仅最终完成（stop/error）时拉取权威数据；
          // tool-calls 是中间步骤，由事件流增量更新，避免频繁重置消息列表
          if (p.sessionID !== cur) break
          const info = p.info
          if (info && info.finish) {
            const f = JSON.stringify(info.finish)
            if (!/tool-calls/.test(f)) {
              loadSession(cur)
            }
          }
          break
        }
        case 'session.idle': {
          // 任务真正结束（多 turn 任务以 idle 为准；POST 只返回首个 step）
          if (p.sessionID !== cur) break
          setBusy(false)
          setStopping(false)
          setCompacting(false) // 压缩会话完成
          loadSession(cur)
          break
        }
        case 'session.error': {
          // 任务失败（如 API Key 无效）：把错误标记到当前会话最后一条 assistant 消息，
          // 避免失败回复渲染成「空气泡」；最终错误以 session.idle 后的权威重载为准
          if (p.sessionID !== cur) break
          setCompacting(false) // 压缩失败也复位，避免按钮卡在「压缩中…」
          const em = extractError({ error: p.error })
          if (!em) break
          setMessages((ms) => {
            if (!ms.length) return ms
            const last = ms[ms.length - 1]
            if (last.role !== 'assistant') return ms
            const clone = ms.slice()
            clone[clone.length - 1] = { ...last, error: em }
            return clone
          })
          break
        }
        case 'permission.asked': {
          // 全局权限兜底：历史会话仍按创建时策略弹 ask，此处按当前已保存的全局设置自动处理
          // （新会话无权限快照，引擎按全局规则直接判断，不会走到这里）
          const action = globalPermAction(p.permission, permCfgRef.current)
          if (action === 'allow') {
            console.log('[perm.asked] global allow, auto-approving', p.id)
            api.permissionRespond(p.sessionID, p.id, 'once')
              .then((ok) => console.log('[perm.asked] respond result:', ok))
              .catch((e) => console.error('[perm.asked] respond failed:', e.message))
          } else if (action === 'deny') {
            console.log('[perm.asked] global deny, auto-rejecting', p.id)
            api.permissionRespond(p.sessionID, p.id, 'reject')
              .then((ok) => console.log('[perm.asked] respond result:', ok))
              .catch((e) => console.error('[perm.asked] respond failed:', e.message))
          } else {
            setPerm(p)
          }
          break
        }
        case 'question.asked': {
          // AI 主动提问（ask 工具）：展示问题/选项弹窗，回答经 /question/{id}/reply 提交
          console.log('[question.asked]', p.sessionID, JSON.stringify(p.questions || []).slice(0, 200))
          const qs = p.questions || []
          setQuestion({ id: p.id, sessionID: p.sessionID, questions: qs })
          setQSek(qs.map(() => []))
          setQText(qs.map(() => ''))
          setQOther(qs.map(() => false))
          break
        }
        case 'engine.exited': {
          // 引擎进程退出事件。可能是瞬态（如冷启动端口瞬占），延迟复查：
          // 复查仍健康则忽略并恢复状态；否则提示用户
          // 引擎进程退出后任何进行中的任务必然中断，立即复位 busy，避免 UI 卡在「执行中」
          setBusy(false)
          setStopping(false)
          setEngine((e) => ({ ...e, running: false }))
          setTimeout(async () => {
            try {
              const st = await api.engineStatus()
              if (st.running) {
                setEngine(st)
                setEngineError('')
                refreshSessions()
              } else {
                setEngineError(`引擎进程退出（code ${p.code}）`)
              }
            } catch {
              setEngineError(`引擎进程退出（code ${p.code}）`)
            }
          }, 3000)
          break
        }
        case 'engine.error':
          setEngineError(p.message)
          break
        default:
          break
      }
    })
    // 启动引擎
    api.engineStart().then((st) => {
      setEngine(st)
      if (st.running) refreshSessions()
      loadWorkspace()
    })
    // 清理事件监听（onEvent 返回 unsubscribe），避免 HMR 重挂载时累积监听器
    return off
  }, [])

  // 拉取渲染层配置（app/app.config.json，经 config:get IPC）：覆盖隐藏列表与时长默认值
  // 提取为可复用函数：启动时与「配置」页保存后都会刷新（隐藏列表/时长即时生效）
  const applyRendererConfig = (c) => {
    if (!c) return
    setHideDirs(new Set(c.hideDirs || []))
    setHideFiles(new Set(c.hideFiles || []))
    setTimings((t) => ({ ...t, ...(c.timings || {}) }))
  }
  useEffect(() => {
    api
      .getConfig()
      .then(applyRendererConfig)
      .catch(() => {
        /* 获取失败则使用默认值 */
      })
  }, [])

  // 引擎未就绪时轮询，保证 UI 状态最终与引擎同步（冷启动引擎可能晚于窗口就绪）
  useEffect(() => {
    if (engine.running) return
    const timer = setInterval(async () => {
      try {
        const st = await api.engineStatus()
        setEngine(st)
        if (st.running) {
          setEngineError('')
          refreshSessions()
          clearInterval(timer)
        }
      } catch {
        /* 查询失败则继续轮询 */
      }
    }, timings.enginePollMs)
    return () => clearInterval(timer)
  }, [engine.running, timings])

  // 自动滚动到底部：仅在贴底时跟随最新内容；用户上滑后停止跟随（保持当前位置可阅读），
  // 期间有新内容则显示「↓ 新消息」提示；滚回底部（onListScroll 判定）自动恢复跟随
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (listStickRef.current) {
      el.scrollTop = el.scrollHeight
      setShowNewHint(false)
    } else {
      setShowNewHint(true)
    }
  }, [messages, busy])

  // 对话区滚动：距底 <30px 视为贴底（恢复跟随），否则上滑（停止跟随并隐藏提示）
  const onListScroll = () => {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    listStickRef.current = nearBottom
    if (nearBottom) setShowNewHint(false)
  }

  // 「↓ 新消息」：点击回到底部并恢复跟随
  const jumpToLatest = () => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
    listStickRef.current = true
    setShowNewHint(false)
  }

  // 操作提示自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), timings.toastMs)
    return () => clearTimeout(t)
  }, [toast, timings])

  // 将同步 POST 的最终结果落定到消息列表
  const settle = (result) => {
    const aborted = !!(result.info?.error && /abort/i.test(result.info.error.name || ''))
    setMessages((ms) => {
      // 刚发送产生的消息必然走打字机；settled 标记用于拦截后续 delta 追加
      const final = {
        id: result.info.id,
        role: 'assistant',
        aborted,
        error: extractError(result.info),
        streamed: true,
        settled: true,
        parts: (result.parts || []).map((p) => ({
          id: p.id,
          callID: p.callID,
          type: p.type,
          text: p.text || '',
          tool: p.tool,
          state: p.state
        }))
      }
      const idx = ms.findIndex((m) => m.id === result.info.id)
      const clone = ms.slice()
      if (idx >= 0) clone[idx] = final
      else clone.push(final)
      return clone
    })
  }

  // 同步 POST 只等到「一个 step」完成（多 turn 工具任务会先返回快照）。
  // 任务真正结束以 session.idle 事件为准；此处在 POST 返回后做一次权威查询兜底：
  // 若最后一条 assistant 消息就是 POST 返回的那条且已最终完成，则任务结束（单 turn / abort）。
  const checkDone = (sid, expectedId) => {
    setTimeout(async () => {
      try {
        const msgs = await api.messageList(sid)
        const assistants = (msgs || []).filter((m) => m.info?.role === 'assistant')
        const last = assistants[assistants.length - 1]
        const f = JSON.stringify(last?.info?.finish || '')
        if (last?.info?.id === expectedId && !/tool-calls/.test(f)) {
          setBusy(false)
          setStopping(false)
        }
      } catch {
        /* 查询失败则依赖 session.idle 复位 */
      }
    }, 2000)
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy || compacting) return // 压缩进行中禁止发送
    // 已添加的工作区文件以 opencode @引用语法注入提示词（与引擎原生「@文件名」交互方式一致）
    let finalText = text
    if (addedFiles.length) {
      finalText =
        text +
        '\n\n【工作区文件】已引用以下文件（@ 引用），请读取其内容并基于此处理：\n' +
        addedFiles.map((p) => '@' + p).join('\n')
    }
    setInput('')
    // 模型必须显式选择（模型组下拉）；无有效模型时不发送
    if (!modelValid) {
      setToast('请先在设置中配置模型组并选择模型')
      return
    }
    let sid = currentID
    // 记录发送前最后一条 assistant 消息时间：POST 失败时据此判断引擎是否已受理本次消息（任务是否在推进）
    const assts = messages.filter((m) => m.role === 'assistant')
    const baselineAsstTime = assts.length ? assts[assts.length - 1].time || 0 : 0
    try {
      if (!sid) {
        // 新会话不再携带权限快照：权限由引擎全局配置（opencode.json permission）统一判断，
        // 修改权限设置并重启引擎后对所有会话生效；历史会话的兜底处理见 permission.asked
        const created = await api.sessionCreate(text.slice(0, 24) || '新对话')
        sid = created.id
        setCurrentID(sid)
        refreshSessions()
      }
      setMessages((ms) => [...ms, { id: 'local-' + Date.now(), role: 'user', parts: [{ type: 'text', text: finalText }] }])
      setBusy(true)
      // 同步等待首个 step 完成；期间实时过程（流式文本/工具/权限/后续 turn）由全局事件流推送
      const result = await api.messageSend(sid, finalText, modelSel, agent)
      settle(result)
      checkDone(sid, result.info.id)
    } catch (e) {
      // POST 失败 ≠ 任务失败：可能只是「等待快照」的通道断开/超时，引擎已受理消息、任务仍在推进。
      // 取证：引擎健康且出现了发送时刻之后的新 assistant 消息 → 静默继续（busy 交由 session.idle 事件复位）；
      // 否则才是真正的发送失败
      let progressed = false
      try {
        const st = await api.engineStatus()
        if (st.running) {
          const msgs = await api.messageList(sid)
          const assistants = (msgs || []).filter((m) => m.info?.role === 'assistant')
          const lastAsst = assistants[assistants.length - 1]
          progressed = !!(lastAsst && (lastAsst.info?.time?.created || 0) > baselineAsstTime)
        }
      } catch {
        progressed = false
      }
      if (progressed) {
        console.warn('message:send 快照等待超时，任务仍在进行，交由事件流处理:', e.message)
      } else {
        console.error('send failed', e)
        setEngineError('发送失败: ' + e.message)
        setBusy(false)
        setStopping(false)
      }
    } finally {
      setStopping(false)
    }
  }

  // 停止当前任务：abort 后同步 POST 会随之返回，busy 由 finally 复位
  const stop = async () => {
    if (!busy || !currentID) return
    setStopping(true)
    try {
      await api.messageAbort(currentID)
    } catch (e) {
      console.error('abort failed', e)
    }
  }

  const respondPerm = async (response) => {
    if (!perm) return
    try {
      await api.permissionRespond(perm.sessionID, perm.id, response)
    } catch (e) {
      console.error('permission respond failed', e)
    }
    setPerm(null)
  }

  // 切换某题的选项选中状态（单选互斥，多选可多选）；点击预设选项时退出「其它」模式
  const toggleQOption = (qi, label) => {
    const multiple = question?.questions?.[qi]?.multiple
    setQSek((cur) => {
      const arr = cur[qi] ? [...cur[qi]] : []
      const i = arr.indexOf(label)
      if (i >= 0) arr.splice(i, 1)
      else if (multiple) arr.push(label)
      else return cur.map((a, j) => (j === qi ? [label] : a))
      return cur.map((a, j) => (j === qi ? arr : a))
    })
    if (qOther[qi]) {
      setQOther((cur) => cur.map((v, j) => (j === qi ? false : v)))
      setQText((cur) => cur.map((v, j) => (j === qi ? '' : v)))
    }
  }

  // 切换某题的「其它（自行输入）」：激活时清空已选选项；退出时清空输入草稿
  const toggleQOther = (qi) => {
    if (!qOther[qi]) {
      setQSek((cur) => cur.map((a, j) => (j === qi ? [] : a)))
    } else {
      setQText((cur) => cur.map((v, j) => (j === qi ? '' : v)))
    }
    setQOther((cur) => cur.map((v, j) => (j === qi ? !v : v)))
  }

  // 提交 AI 提问的回答：每题生成答案数组（「其它」取输入文本；否则选项取选中 label），按题序汇总
  const submitQuestion = async () => {
    if (!question) return
    const answers = question.questions.map((q, i) => {
      if (qOther[i]) {
        const t = (qText[i] || '').trim()
        return t ? [t] : []
      }
      if ((q.options || []).length) return qSel[i] || []
      const t = (qText[i] || '').trim()
      return t ? [t] : []
    })
    if (!answers.some((a) => a.length)) return
    const r = await api.questionReply(question.id, answers)
    if (r.ok) setQuestion(null)
    else setToast('提交回答失败: ' + (r.error || ''))
  }

  // 拒绝/取消 AI 的提问（不回答，让 AI 继续）
  const cancelQuestion = async () => {
    const q = question
    setQuestion(null)
    if (!q) return
    try {
      const r = await api.questionReject(q.id)
      if (!r.ok) setToast('操作失败: ' + (r.error || ''))
    } catch (e) {
      setToast('操作失败: ' + e.message)
    }
  }

  // 复制消息文本到剪贴板
  const copyText = async (md) => {
    try {
      await navigator.clipboard.writeText(md)
      setToast('已复制到剪贴板')
    } catch (e) {
      setToast('复制失败: ' + e.message)
    }
  }

  // 启动时加载已保存的界面主题（旧 preload 无 getTheme 时保持默认暗色）
  useEffect(() => {
    if (typeof api.getTheme !== 'function') return
    api
      .getTheme()
      .then((t) => {
        if (t) setTheme(t)
      })
      .catch(() => {})
  }, [])

  // 主题应用到根元素（CSS 变量随 data-theme 切换）
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // 切换界面主题：即时生效并持久化（不重启引擎）
  const applyTheme = (t) => {
    if (t === theme) return
    setTheme(t)
    if (typeof api.applyTheme === 'function') {
      api.applyTheme(t).catch(() => setToast('主题保存失败'))
    }
  }
  // 关闭时动作（quit=关闭程序 / tray=最小化到托盘）：即时保存并同步本地状态
  const applyCloseAction = (v) => {
    if (typeof api.applyCloseAction === 'function') {
      api.applyCloseAction(v).catch(() => setToast('关闭行为保存失败'))
    }
    setSettingsData((d) => (d ? { ...d, closeAction: v } : d))
  }

  // 工作区变化时刷新 git 可用状态（决定「回退至此」按钮可用性；git 已在主进程静默初始化，isGit 用于日志/兜底判断）
  useEffect(() => {
    if (!workspace) return
    if (typeof api.gitEnsure !== 'function') return
    let stale = false
    api
      .gitEnsure(workspace, {})
      .then((g) => {
        if (stale) return
        setGitState({ available: !!g?.available, isGit: !!(g && g.isGit) })
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [workspace])

  // 「回退至此」：点击气泡左侧按钮 → 轻确认弹窗。
  // 事前不再预估影响清单（bash 等无法精确预测，见 undo功能设计.md §6.2），
  // 实际影响由主进程在 undo 完成后按快照对比收集（§6.3），成功后经 undoResult 展示
  const openUndoConfirm = (m) => {
    setUndoDraft({
      messageID: m.id,
      // 回退成功后把该消息原样填回输入框（用户可能需要编辑后重发）
      userText: (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text || '').join('\n')
    })
  }

  // 回退后刷新：消息列表 + 上下文 token + 工作区文件树（文件变更反映到侧栏）
  // 引擎 revert 只回滚文件快照，消息列表要到下一次发送才截断；因此按目标 user 消息 ID 前端截断：
  // 保留该消息之前的部分，该消息及其后的 AI 回复一并移除（与引擎后续截断结果一致，幂等）
  const refreshAfterUndo = async (targetMsgID) => {
    try {
      const msgs = await api.messageList(currentID)
      const norm = normalize(msgs)
      if (targetMsgID) {
        const idx = norm.findIndex((m) => m.id === targetMsgID)
        if (idx >= 0) {
          const trimmed = norm.slice(0, idx)
          setMessages(trimmed)
          setCtxTokens(ctxTokenCount(trimmed))
        } else {
          setMessages(norm)
          setCtxTokens(ctxTokenCount(msgs))
        }
      } else {
        setMessages(norm)
        setCtxTokens(ctxTokenCount(msgs))
      }
    } catch (e) {
      console.error('refresh after undo failed', e)
    }
    if (workspace && typeof api.workspaceListDir === 'function') {
      try {
        const list = await api.workspaceListDir(workspace)
        if (list && !list.error) setWsChildren((c) => ({ ...c, [workspace]: list }))
      } catch {
        /* 忽略 */
      }
    }
  }

  // 执行回退：调用引擎 revert；失败（含引擎静默失败兜底 no_git_snapshot）给出明确提示。
  // 成功后把被回退的用户消息原样填入输入框（用户可能需要编辑后重发），并截断消息列表
  const doUndo = async (messageID, userText) => {
    try {
      const r = await api.undoTo(currentID, messageID)
      if (!r || !r.ok) {
        if (r?.reason === 'no_git_snapshot') {
          setToast('回退失败：引擎未产生文件快照，文件无法回滚（工作区 git 不可用）')
        } else {
          setToast((r && r.message) || '回退失败')
        }
        return
      }
      setToast('已回退到此轮对话之前')
      if (userText) setInput(userText)
      // 主进程已按快照对比收集实际影响清单（§6.3），非空时展示事后结果面板
      if (r.impact && r.impact.length) setUndoResult({ impact: r.impact })
      refreshAfterUndo(messageID)
    } catch (e) {
      console.error('undo failed', e)
      setToast('回退失败：' + (e.message || '未知错误'))
    }
  }

  // 确认弹窗确认 → 直接执行回退（git 已在工作区建立时静默初始化，见主进程 ensureWorkdirGit；
  //   无 git 环境时「回退至此」按钮已置灰禁用，不会走到这里）
  const onUndoConfirm = () => {
    const { messageID, userText } = undoDraft
    setUndoDraft(null)
    doUndo(messageID, userText)
  }
  // 任务通知开关：即时保存并同步本地状态
  const applyNotifyTask = (v) => {
    if (typeof api.applyNotifyTask === 'function') {
      api.applyNotifyTask(v).catch(() => setToast('任务通知设置保存失败'))
    }
    setSettingsData((d) => (d ? { ...d, notifyTask: v } : d))
  }

  // 加载设置快照（含模型组）；启动与打开设置时调用
  // quiet=true：启动期引擎可能尚未就绪，失败属预期，静默等 server.connected 重试
  const loadModels = async (quiet = false) => {
    try {
      const data = await api.getSettings()
      setSettingsData(data)
      // 同步权限配置到 ref（自动应答兜底实时读取）
      permCfgRef.current = (data && data.permission) || PERMISSION_PRESETS.标准
    } catch (e) {
      console.error('load models failed', e)
      if (!quiet) setToast('加载设置失败: ' + e.message)
    }
  }

  // 启动时加载模型数据（供聊天框模型下拉与设置面板使用）；引擎未就绪时静默，由 server.connected 重试
  useEffect(() => {
    loadModels(true)
    // 应用版本信息为静态数据，启动时加载一次
    api.appInfo().then(setAppInfo).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 置顶顺序持久化到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem('xwork-pinned', JSON.stringify(pinnedOrder))
    } catch {
      /* 存储不可用时忽略（置顶仅本次会话有效） */
    }
  }, [pinnedOrder])

  // 点击页面任意处关闭会话操作菜单（菜单内点击已 stopPropagation）
  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  // 压缩当前会话：引擎将历史总结为摘要并替换（等效 opencode /compact），不可逆，需确认
  // 使用当前会话绑定的模型做总结；异步执行，完成后 session.idle 自动重载消息
  const doCompact = () => {
    if (!currentID || busy || compacting) return
    if (!modelSel) {
      setToast('请先选择要使用的模型')
      return
    }
    setConfirm({
      title: '压缩会话',
      message: '将把当前会话的历史对话压缩为一段摘要并替换（保留近期内容）。压缩后无法恢复完整历史，确定继续吗？',
      confirmLabel: '压缩',
      danger: true,
      onConfirm: async () => {
        setCompacting(true)
        try {
          const r = await api.compactSession(currentID, modelSel)
          if (!r.ok) throw new Error(r.error || '压缩失败')
          setToast('压缩中，完成后自动刷新…')
        } catch (e) {
          setToast('压缩失败: ' + e.message)
          setCompacting(false)
        }
      }
    })
  }

  // 打开设置：刷新数据后展示面板
  const openSettings = async () => {
    setSettingsOpen(true)
    await loadModels()
    // 加载有效应用配置（默认值 + 用户覆盖层），供「配置」页表单展示
    api.getConfig().then(setAppConfig).catch(() => {})
  }

  // 保存「配置」页表单：写入用户覆盖层，刷新渲染层即时生效字段；端口/窗口尺寸重启应用后生效
  const saveAppConfig = async (vals) => {
    try {
      const r = await api.saveConfig(vals)
      if (!r.ok) throw new Error(r.error || '保存失败')
      const fresh = await api.getConfig()
      setAppConfig(fresh)
      applyRendererConfig(fresh) // 隐藏列表/时长立即生效（文件树与轮询无需重启）
      setToast('配置已保存（引擎端口 / 窗口尺寸重启应用后生效）')
    } catch (e) {
      setToast('保存配置失败: ' + e.message)
    }
  }

  // 打开 SKILL HUB：拉取技能列表（主进程经 IPC 请求本地技能服务，无 CORS 限制）
  const openSkillHub = async () => {
    setSkillHubOpen(true)
    setSkillLoading(true)
    setSkillError('')
    refreshInstalled() // 打开弹窗时同步已安装状态（解压目录以磁盘实际为准）
    try {
      const r = await api.skillList()
      if (r.ok) setSkills(r.skills)
      else setSkillError(r.error || '技能加载失败')
    } catch (e) {
      setSkillError('技能加载失败: ' + e.message)
    } finally {
      setSkillLoading(false)
    }
  }

  // 扫描工作区 .agents/skills，得到已安装技能 slug 集合（文件夹名 = slug），驱动安装/卸载按钮
  const refreshInstalled = async () => {
    try {
      const r = await api.skillInstalled()
      if (r.ok) setSkillInstalled(Object.fromEntries((r.slugs || []).map((s) => [s, true])))
    } catch {
      /* 扫描失败忽略，视为未安装 */
    }
  }

  // 安装技能：主进程下载 zip 并解压到工作区，成功后刷新已安装状态
  const installSkill = async (s) => {
    if (skillBusy) return
    setSkillBusy(s.id)
    try {
      const r = await api.skillInstall(s.id)
      if (r.ok) {
        setToast(`「${s.name}」已安装，重启引擎后生效`)
        refreshInstalled()
      } else {
        setToast(r.error || '安装失败')
      }
    } catch (e) {
      setToast('安装失败: ' + e.message)
    } finally {
      setSkillBusy(null)
    }
  }

  // 卸载技能：确认后删除 .agents/skills/<slug> 整个文件夹（复用全局确认框）
  const uninstallSkill = (s) => {
    setConfirm({
      title: '卸载技能',
      message: `确定要卸载「${s.name}」吗？将删除工作区 .agents/skills/${s.slug} 文件夹。`,
      danger: true,
      confirmLabel: '卸载',
      onConfirm: async () => {
        try {
          const r = await api.skillUninstall(s.slug)
          if (r.ok) {
            setToast(`「${s.name}」已卸载`)
            refreshInstalled()
          } else {
            setToast(r.error || '卸载失败')
          }
        } catch (e) {
          setToast('卸载失败: ' + e.message)
        }
      }
    })
  }

  // 重启引擎：安装新技能后需重启才能识别，经主进程 stop → 强制新进程
  const restartEngine = async () => {
    try {
      const r = await api.engineRestart()
      setToast(r.ok ? '引擎已重启，技能已生效' : '引擎重启失败: ' + (r.error || '未知错误'))
    } catch (e) {
      setToast('引擎重启失败: ' + e.message)
    }
  }

  // 拖拽调整侧栏宽度：type = 'left'（左边栏右缘）/ 'task'（任务面板左缘）
  // mousedown 记录起点，window mousemove 期间用函数式 setState 更新，mouseup 清理监听
  const startResize = (type, e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = type === 'left' ? sidebarW : taskW
    const setter = type === 'left' ? setSidebarW : setTaskW
    const min = type === 'left' ? 160 : 200
    const max = type === 'left' ? 480 : 600
    const onMove = (ev) => {
      // 左边栏向右拉变宽；任务面板向左拉变宽
      const delta = type === 'left' ? ev.clientX - startX : startX - ev.clientX
      setter(Math.min(max, Math.max(min, startW + delta)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('resizing')
  }

  // 拖拽调整输入区高度：向上拉变高（消息区自动腾出空间），最小 100px（手柄到窗口底边的距离），最大不超过窗口一半
  const startResizeV = (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = document.querySelector('.composer')?.offsetHeight ?? 120
    const onMove = (ev) => {
      const h = Math.min(window.innerHeight * 0.5, Math.max(100, startH + (startY - ev.clientY)))
      setComposerH(Math.round(h))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing', 'resizing-v')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('resizing', 'resizing-v')
  }

  // 保存设置（主进程加密存储 + 写配置；restart=true 时重启引擎生效；note 可覆盖提示文案）
  const saveSettings = async (form, restart = true, note = '') => {
    try {
      await api.saveSettings(form, restart)
      setSettingsOpen(false)
      setToast(note || (restart ? '设置已保存，引擎已重启生效' : '设置已保存，重启引擎后生效'))
      loadModels() // 立即刷新聊天框模型下拉与设置面板数据
    } catch (e) {
      setToast('保存失败: ' + e.message)
    }
  }

  // 应用最常用模型为当前选择（须仍存在于模型组中有效），无记录或已失效则置空让用户选择
  const applyFrequentModel = async () => {
    try {
      const fm = await api.frequentModel()
      if (
        fm &&
        availableModels.some((m) => m.providerID === fm.providerID && m.modelID === fm.modelID)
      ) {
        setModelSel(fm)
      } else {
        setModelSel(null)
      }
    } catch {
      setModelSel(null)
    }
  }

  const newChat = async () => {
    setCurrentID(null)
    setMessages([])
    setBusy(false)
    setStopping(false)
    setGreeting(pickGreeting())
    setAgent('build') // 新对话默认 build 模式
    // 默认最常用模型（须仍存在于模型组中有效），无记录或已失效则置空让用户选择
    await applyFrequentModel()
  }

  // 打开程序时（空会话）默认选择最常用模型并回到 build 模式；有会话时由 loadSession 恢复，不覆盖
  useEffect(() => {
    if (currentID || !settingsData) return
    applyFrequentModel()
    setAgent('build')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentID, settingsData])

  // 删除历史会话（项目风格确认框确认后从引擎删除）
  const removeSession = async (sid) => {
    const s = sessions.find((x) => x.id === sid)
    setConfirm({
      title: '删除会话',
      message: `确定删除会话「${(s && s.title) || ''}」？此操作不可恢复。`,
      danger: true,
      confirmLabel: '删除',
      onConfirm: async () => {
        try {
          await api.sessionDelete(sid)
          if (sid === currentID) newChat()
          refreshSessions()
        } catch (e) {
          setToast('删除失败: ' + e.message)
        }
      }
    })
  }

  // 删除工作区（仅路径不存在的条目显示 ×）：移除注册表条目 + 删除该目录下引擎会话
  const removeWorkspace = (dir) => {
    const w = allWs.find((x) => normDir(x.dir) === normDir(dir))
    setConfirm({
      title: '删除工作区',
      message: `确定删除工作区「${(w && w.name) || ''}」？将同时删除该目录下的历史会话，此操作不可恢复。`,
      danger: true,
      confirmLabel: '删除',
      onConfirm: async () => {
        try {
          const r = await api.workspaceDelete(dir)
          if (r.ok) {
            setAllWs((prev) => prev.filter((x) => normDir(x.dir) !== normDir(dir)))
            setToast(
              r.warning ||
                (r.sessionsDeleted ? `已删除工作区及 ${r.sessionsDeleted} 个会话` : '已删除工作区')
            )
          } else {
            setToast('删除失败: ' + (r.error || '未知错误'))
          }
        } catch (e) {
          setToast('删除失败: ' + e.message)
        }
      }
    })
  }

  // 保存重命名（双击标题进入编辑）
  const saveRename = async (sid) => {
    const t = editingTitle.trim()
    const old = sessions.find((s) => s.id === sid)?.title
    setEditingID(null)
    if (!t || t === old) return
    try {
      await api.sessionRename(sid, t)
      refreshSessions()
    } catch (e) {
      setToast('重命名失败: ' + e.message)
    }
  }

  // 会话列表排序：置顶区（按置顶顺序，不动）在前；普通区按「最新回复时间」降序，回复过的排上面
  const byUpdatedDesc = (a, b) => (b.time?.updated || b.time?.created || 0) - (a.time?.updated || a.time?.created || 0)
  const pinnedList = pinnedOrder.map((id) => sessions.find((s) => s.id === id)).filter(Boolean)
  const normalList = sessions.filter((s) => !pinnedOrder.includes(s.id)).sort(byUpdatedDesc)
  const orderedSessions = [...pinnedList, ...normalList]
  const visibleSessions = workspace
    ? orderedSessions.filter((s) => normDir(s.directory) === normDir(workspace))
    : orderedSessions

  // 拖拽排序语义（与 onScrollDragOver 坐标计算一致）：插入位置基于「剔除拖拽项后的置顶列表」
  const dragIdx = dragIdRef.current != null ? pinnedOrder.indexOf(dragIdRef.current) : -1
  const finalCount = pinnedOrder.filter((id, i) => i !== dragIdx && pinItemRefs.current.get(id)).length

  // 置顶 / 取消置顶：后置顶的排最前；取消后回到按回复时间排序的普通区
  const togglePin = (sid) => {
    setPinnedOrder((prev) => (prev.includes(sid) ? prev.filter((id) => id !== sid) : [sid, ...prev]))
    setMenu(null)
  }

  // 置顶会话拖动排序：拖动时仅在目标位置显示指示线（dropPos），松开鼠标（drop）后才真正移动
  const onDragStart = (e, sid) => {
    dragIdRef.current = sid
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', sid)
    setDropPos(0) // 起始默认指示在最前
  }
  // 容器统一计算插入位置：按鼠标 Y 与各置顶项中线的相对位置判断，
  // 与 dragover 的 target 元素无关 → 卡片间隙/空白/普通区微动不会产生跳变
  const onScrollDragOver = (e) => {
    const dragging = dragIdRef.current
    if (!dragging) return
    e.preventDefault() // 允许 drop
    const items = pinnedOrder
      .filter((id) => id !== dragging)
      .map((id) => ({ id, el: pinItemRefs.current.get(id) }))
      .filter((x) => x.el)
    if (!items.length) {
      setDropPos(0)
      return
    }
    const y = e.clientY
    let insertAt = items.length // 默认末尾
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].el.getBoundingClientRect()
      if (y < rect.top + rect.height / 2) {
        insertAt = i
        break
      }
    }
    setDropPos(insertAt)
  }
  const onDrop = (e) => {
    e.preventDefault()
    const dragging = dragIdRef.current
    if (dragging && dropPos !== null) {
      setPinnedOrder((prev) => {
        if (!prev.includes(dragging)) return prev
        const next = prev.filter((id) => id !== dragging)
        next.splice(Math.min(dropPos, next.length), 0, dragging)
        return next
      })
    }
    dragIdRef.current = null
    setDropPos(null)
  }
  const onDragEnd = () => {
    dragIdRef.current = null
    setDropPos(null)
  }

  // 任务执行面板：按时间顺序提取所有工具调用
  const toolSteps = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const p of m.parts) {
      if (p.type === 'tool') {
        toolSteps.push({ key: p.id || p.callID || Math.random().toString(36).slice(2), tool: p.tool, state: p.state, aborted: m.aborted })
      }
    }
  }

  // 渲染工作区文件树（懒加载：仅渲染已展开路径；隐藏大目录/无关文件）
  // 文件夹样式：类型图标 + 名称；文件点击添加/移除到对话；右键呼出菜单
  const renderWsTree = (nodes, parentAbs, depth) => {
    if (!nodes) return <div className="ws-empty">加载中…</div>
    const visible = nodes.filter(
      (n) => !(n.type === 'dir' && hideDirs.has(n.name)) && !(n.type === 'file' && hideFiles.has(n.name))
    )
    if (!visible.length) return <div className="ws-empty">（空）</div>
    return visible.map((n) => {
      const abs = parentAbs + '\\' + n.name
      if (n.type === 'dir') {
        const exp = !!expandedDirs[abs]
        return (
          <div key={abs}>
            <div
              className="ws-node ws-dir"
              style={{ paddingLeft: depth * 14 + 2 }}
              onClick={() => toggleDir(abs)}
              onContextMenu={(e) => openCtxMenu(e, { abs, rel: relOf(abs), type: 'dir', name: n.name })}
              title={abs}
            >
              <span className="ws-arrow">{exp ? '▾' : '▸'}</span>
              <span className="ws-ic">{exp ? '📂' : '📁'}</span>
              <span className="ws-name">{n.name}</span>
            </div>
            {exp && renderWsTree(wsChildren[abs], abs, depth + 1)}
          </div>
        )
      }
      // 添加的文件存相对工作区的路径（AI 直接可用）
      const rel = relOf(abs)
      const added = addedFiles.includes(rel)
      return (
        <div
          key={abs}
          className={`ws-node ws-file ${added ? 'added' : ''}`}
          style={{ paddingLeft: depth * 14 + 2 }}
          onClick={() => toggleAdd(rel)}
          onContextMenu={(e) => openCtxMenu(e, { abs, rel, type: 'file', name: n.name })}
          title={rel}
        >
          <span className="ws-ic">{fileIcon(n.name)}</span>
          <span className="ws-name">{n.name}</span>
          <button className="ws-add" title={added ? '从对话移除' : '添加到对话'} onClick={(e) => { e.stopPropagation(); toggleAdd(rel) }}>
            {added ? '✓' : '+'}
          </button>
        </div>
      )
    })
  }

  // 当前正在进行的步骤（用于面板顶部状态）
  const currentStep = (() => {
    if (!busy) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      for (const p of m.parts) {
        if (p.type === 'tool' && (p.state?.status === 'running' || p.state?.status === 'pending')) {
          return { kind: 'tool', tool: p.tool, input: p.state?.input }
        }
        if (p.type === 'reasoning' && p.text) return { kind: 'thinking' }
        if (p.type === 'text' && p.text && m.streaming) return { kind: 'writing', text: p.text }
      }
    }
    return { kind: 'working' }
  })()

  // 可用模型列表（聊天框下拉）：全部来自自定义模型组
  const availableModels = (() => {
    const list = []
    if (!settingsData) return list
    for (const g of settingsData.modelGroups || []) {
      for (const m of g.models) list.push({ providerID: g.id, modelID: m, label: g.name + ' / ' + m })
    }
    return list
  })()

  // 当前选择的模型是否仍可用（模型组被删除后视为未选择，发送被拦截）
  const modelValid =
    !!modelSel && availableModels.some((m) => m.providerID === modelSel.providerID && m.modelID === modelSel.modelID)

  // 下拉值 → 模型对象（格式 providerID/modelID）
  const applyModelSel = (key) => {
    if (!key) return setModelSel(null)
    const i = key.lastIndexOf('/')
    setModelSel({ providerID: key.slice(0, i), modelID: key.slice(i + 1) })
  }

  return (
    <div className="app">
      {/* 自绘标题栏：无边框窗口的拖拽区 + 窗口控制按钮 */}
      <header className="topbar titlebar" onDoubleClick={() => api.windowMaximize()}>
        <div className="brand">◈ XWork</div>
        <div
          className="engine-status"
          title={engine.running ? `引擎已连接 v${engine.version}（端口 ${engine.port}）` : '引擎未启动'}
        >
          <span className={`dot ${engine.running ? 'ok' : 'bad'}`} />
          <span>{engine.running ? '就绪' : '未连接'}</span>
        </div>
        {engineError && (
          <div className="engine-error" title={engineError}>
            {engineError}
          </div>
        )}
        <div className="tb-spacer" />
        <button className="settings-btn" onClick={openSkillHub} title="技能中心（开发中）">
          🧩 Skill Hub
        </button>
        <button className="settings-btn" onClick={openSettings} title="模型与设置">
          ⚙ 设置
        </button>
        <div className="win-controls">
          <button className="wc-btn" title="最小化" onClick={() => api.windowMinimize()}>
            ─
          </button>
          <button className="wc-btn" title="最大化 / 还原" onClick={() => api.windowMaximize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
            </svg>
          </button>
          <button className="wc-btn wc-close" title="关闭" onClick={() => api.windowClose()}>
            ✕
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar" style={{ width: sidebarW }}>
          <div
            className="resize-handle"
            title="拖动调整宽度"
            onMouseDown={(e) => startResize('left', e)}
          />
          <button className="new-btn" onClick={newChat}>
            🗨️ 新对话
          </button>
          <div className="side-tabs">
            <button
              className={`side-tab ${sideTab === 'chat' ? 'active' : ''}`}
              onClick={() => setSideTab('chat')}
            >
              💬 对话
            </button>
            <button
              className={`side-tab ${sideTab === 'files' ? 'active' : ''}`}
              onClick={() => setSideTab('files')}
            >
              📁 工作区
            </button>
          </div>

          {/* 对话 / 文件 两个视图共处一个轨道，切换时平滑滑动；非活动视图滑动结束后隐藏（避免滚动条透出） */}
          <div className="side-views">
            <div className={`side-track ${sideTab === 'files' ? 'files' : ''}`}>
              <div className={`side-view session-list ${sideTab === 'files' ? 'inactive' : ''}`}>
              {/* 会话归属标识：当前列表只包含该工作区创建的会话（上下文纯净） */}
              <div className="session-head" title={workspace || '未选择工作区'}>
                {/* key 随工作区变化：切换后标识文字淡入 */}
                <span className="session-ws-label" key={workspace || 'none'}>
                  📂 {workspace ? workspace.split(/[\\/]/).pop() : '未选择工作区'}
                </span>
              </div>
              {/* key 随工作区变化：切换后新列表重挂载，触发淡入上滑动画 */}
              <div
                className="session-scroll"
                key={workspace || 'none'}
                onDragOver={onScrollDragOver}
                onDrop={onDrop}
              >
              {visibleSessions.map((s) => {
                // 该项在「剔除拖拽项后的置顶列表」中的位置；dropPos 与之同语义
                const origIdx = pinnedOrder.indexOf(s.id)
                const finalIdx =
                  origIdx !== -1 && origIdx !== dragIdx ? origIdx - (dragIdx >= 0 && dragIdx < origIdx ? 1 : 0) : -1
                // 指示线位置：finalIdx === dropPos 插到该项上方；dropPos 为末尾时插到最后一个置顶项下方
                // finalIdx !== -1 限定仅置顶项显示（被拖项与普通区排除）：
                // 否则仅 1 个置顶项被拖时 finalCount-1 === -1 会让所有 finalIdx=-1 的普通会话都亮线
                const lineBefore = dropPos !== null && finalIdx !== -1 && finalIdx === dropPos
                const lineAfter =
                  dropPos !== null &&
                  finalIdx !== -1 &&
                  finalIdx === finalCount - 1 &&
                  dropPos === finalCount
                return (
                    <div
                      key={s.id}
                      className="session-row"
                      ref={(el) => {
                        if (el) pinItemRefs.current.set(s.id, el)
                        else pinItemRefs.current.delete(s.id)
                      }}
                    >
                    {lineBefore && <div className="drop-line before" />}
                    <div
                      className={`session-item ${s.id === currentID ? 'active' : ''} ${pinnedOrder.includes(s.id) ? 'pinned' : ''}`}
                      draggable={pinnedOrder.includes(s.id)}
                      onDragStart={(e) => onDragStart(e, s.id)}
                      onDragEnd={onDragEnd}
                      onClick={() => loadSession(s.id)}
                    >
                  {editingID === s.id ? (
                    <input
                      className="rename-input"
                      value={editingTitle}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => saveRename(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          saveRename(s.id)
                        }
                        if (e.key === 'Escape') setEditingID(null)
                      }}
                    />
                  ) : (
                    <div
                      className="session-title"
                      title="双击重命名"
                      onDoubleClick={() => {
                        setEditingID(s.id)
                        setEditingTitle(s.title || s.slug || '')
                      }}
                    >
                      {pinnedOrder.includes(s.id) && <span className="pin-badge">📌</span>}
                      {s.title || s.slug || '未命名'}
                    </div>
                  )}
                  <div className="session-meta">
                    <span title="最新回复时间">{fmtDateTime(s.time?.updated || s.time?.created)}</span>
                    <button
                      className={`more-btn ${menu && menu.sid === s.id ? 'menu-open' : ''}`}
                      title="更多操作"
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = e.currentTarget.getBoundingClientRect()
                        setMenu({ sid: s.id, x: rect.right - 104, y: rect.bottom + 4 })
                      }}
                    >
                      ⋯
                    </button>
                  </div>
                  {menu && menu.sid === s.id && (
                    <div
                      className="session-menu"
                      style={{ left: menu.x, top: menu.y }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button onClick={() => togglePin(s.id)}>
                        {pinnedOrder.includes(s.id) ? '取消置顶' : '置顶'}
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          setMenu(null)
                          removeSession(s.id)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  )}
                  </div>
                  {lineAfter && <div className="drop-line after" />}
                </div>
                )
              })}
              {visibleSessions.length === 0 && (
                <div className="empty-hint">
                  {sessions.length === 0 ? '暂无会话' : '当前工作区暂无会话'}
                  <div className="empty-sub">点击上方「新对话」开始</div>
                </div>
              )}
              </div>
              </div>
              <div className={`side-view ws-panel ${sideTab === 'chat' ? 'inactive' : ''}`}>
              <div className="ws-head">
                <span className="ws-label" title={workspace || '未打开工作区'}>
                  📂 {workspace ? workspace.split(/[\\/]/).pop() : '未打开工作区'}
                </span>
                <button className="ws-open-btn" onClick={openWorkspace} disabled={busy}>
                  {workspace ? '切换' : '打开文件夹'}
                </button>
              </div>
              {workspace ? (
                <div className="ws-tree" key={workspace}>{renderWsTree(wsChildren[workspace], workspace, 0)}</div>
              ) : (
                <div className="ws-empty-cta">
                  <div className="ws-empty-text">打开一个文件夹作为工作区，AI 将在此目录中读取与修改文件</div>
                  <button className="ws-open-btn" onClick={openWorkspace} disabled={busy}>
                    打开文件夹
                  </button>
                </div>
              )}
              {/* 所有工作区：底部可展开列表，聚合所有发生过会话的目录，点击切换 */}
              <div className="ws-all">
                <button
                  className={`ws-all-btn ${wsAllOpen ? 'open' : ''}`}
                  onClick={toggleWsAll}
                  disabled={busy}
                >
                  <span>{wsAllOpen ? '📂' : '📁'} 所有工作区</span>
                  <span className="caret">›</span>
                </button>
                <div className={`ws-all-list ${wsAllOpen ? 'open' : ''}`}>
                  {allWs.length === 0 ? (
                    <div className="empty-hint">暂无其他工作区</div>
                  ) : (
                    allWs.map((w) => (
                      <div
                        key={w.dir}
                        className={`ws-all-item ${normDir(w.dir) === normDir(workspace) ? 'active' : ''} ${w.exists === false ? 'missing' : ''}`}
                        title={w.dir}
                        onClick={() => {
                          setWsAllOpen(false)
                          switchTo(w.dir)
                        }}
                      >
                        <div className="ws-all-name">{w.name}</div>
                        <div className="ws-all-path">{w.dir}</div>
                        <div className="ws-all-meta">
                          {w.count} 个会话 · 最近 {fmtDateTime(w.last)}
                          {w.exists === false && ' · 路径不存在'}
                        </div>
                        {w.exists === false && (
                          <button
                            className="ws-all-del"
                            title="删除工作区"
                            onClick={(e) => {
                              e.stopPropagation()
                              removeWorkspace(w.dir)
                            }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
              </div>
            </div>
          </div>
        </aside>

        <main className="main">
          <div className="message-list" ref={listRef} onScroll={onListScroll}>
            {!currentID && !busy && (
              <div className="greeting">
                <div className="greet-title">{greeting.title}</div>
                <div className="greet-sub">{greeting.sub}</div>
              </div>
            )}
            {messages.map((m, mi) => (
              <MessageView
                key={m.id}
                m={m}
                onCopy={copyText}
                onUndo={openUndoConfirm}
                canUndo={m.role === 'user' && hasToolChangeAfter(messages, mi)}
                gitAvailable={gitState.available}
                busy={busy}
              />
            ))}
            {busy && (
              <div className="busy-hint">
                {stopping ? '正在停止…' : 'AI 正在执行中…'}
                {currentStep?.kind === 'tool' && ` 正在${currentStep.tool}`}
              </div>
            )}
            {showNewHint && (
              <button className="new-hint" onClick={jumpToLatest} title="回到最新内容">
                ↓ 新消息
              </button>
            )}
          </div>

          {/* 输入区：整个下部区域为一个圆角矩形输入框，右下角为发送按钮，其左侧为模型选择（向上弹出） */}
          <div className="composer" style={composerH ? { height: composerH } : undefined}>
            <div
              className="composer-resize"
              title="拖动调整高度"
              onMouseDown={startResizeV}
            />
            <div className="composer-box">
              {addedFiles.length > 0 && (
                <div className="composer-files">
                  {addedFiles.map((rel) => (
                    <span key={rel} className="cf-chip" title={rel}>
                      {fileIcon(rel.split(/[\\/]/).pop())} {rel}
                      <button onClick={() => toggleAdd(rel)}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                placeholder="想让我做什么？"
                rows={2}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <div className="composer-foot">
                <div className="composer-actions">
                  {/* 当前上下文 token 统计：最近 assistant 消息的 info.tokens（input + cache.read），完成时刷新 */}
                  {ctxTokens !== null && (
                    <span className="ctx-tokens" title="当前会话上下文长度(Token)">
                      {fmtTokens(ctxTokens)}
                    </span>
                  )}
                  {/* 压缩会话：引擎将历史总结为摘要并替换（等效 opencode /compact），位于模式切换左侧 */}
                  {currentID && (
                    <button
                      className="compact-btn"
                      onClick={doCompact}
                      disabled={busy || compacting}
                      title={compacting ? '压缩中…' : '将历史对话压缩为摘要，以降低信息精度换取更多可用上下文空间'}
                    >
                      {compacting ? '压缩中…' : '压缩'}
                    </button>
                  )}
                  <AgentPicker value={agent} onPick={setAgent} />
                  <ModelPicker
                    models={availableModels}
                    value={modelValid ? modelSel : null}
                    onPick={applyModelSel}
                  />
                  {busy ? (
                    <button className="send-btn stop" disabled={stopping} onClick={stop} title={stopping ? '正在停止…' : '停止任务'}>
                      ■
                    </button>
                  ) : (
                    <button className="send-btn" disabled={!input.trim()} onClick={send} title="发送">
                      ↑
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 工作区切换遮罩：覆盖引擎重启等待期；完成后中央改为「已切换到」提示，短暂停留后收起 */}
          {wsSwitching && (
            <div className={`ws-switch-mask ${wsSwitching.leaving ? 'leaving' : ''}`}>
              <div className="ws-switch-box">
                {wsSwitching.done ? (
                  <span className="ws-done-icon">✓</span>
                ) : (
                  <span className="ws-spinner" />
                )}
                <span>
                  {wsSwitching.done
                    ? `已切换到 📂 ${wsSwitching.dir.split(/[\\/]/).pop()}`
                    : `正在切换到 📂 ${wsSwitching.dir.split(/[\\/]/).pop()}…`}
                </span>
              </div>
            </div>
          )}
        </main>

        {/* 任务面板：常驻容器，展开/收起用宽度过渡动画（窄条从右侧滑入滑出） */}
        <aside
          className={`task-side ${panelOpen ? '' : 'closed'}`}
          style={
            panelOpen
              ? { width: taskW, gridTemplateColumns: `${taskW}px 0px` }
              : undefined
          }
        >
          <div
            className="resize-handle"
            title="拖动调整宽度"
            onMouseDown={(e) => startResize('task', e)}
          />
          <div className="task-panel">
            {/* 标题行在滚动区之外，天然固定于顶部，内容滚动不会从其后方穿越 */}
            <div className="panel-head">
              <span className="panel-title">任务执行过程</span>
              {/* 折叠时重置分页：重新展开始终只渲染最近 TOOL_PAGE 条，避免累积加载的历史持续占据 DOM */}
              <button
                className="panel-toggle"
                title="折叠"
                onClick={() => {
                  setPanelOpen(false)
                  setToolVisible(TOOL_PAGE)
                }}
              >
                »
              </button>
            </div>
            <div className="task-body">
              {busy && currentStep && (
                <div className="current-step">
                  {currentStep.kind === 'tool' && <div className="cs-text">正在执行 {currentStep.tool}</div>}
                  {currentStep.kind === 'thinking' && <div className="cs-text">正在思考…</div>}
                  {currentStep.kind === 'writing' && (
                    <>
                      <div className="cs-text">正在生成回复</div>
                      <div className="cs-preview">{currentStep.text.slice(-200)}</div>
                    </>
                  )}
                  {currentStep.kind === 'working' && <div className="cs-text">任务进行中…</div>}
                </div>
              )}
              {toolSteps.length === 0 ? (
                <div className="empty-hint">暂无执行记录</div>
              ) : (
                <>
                  {/* 分页：倒序展示（最新在上、更早在下），只渲染最近 toolVisible 条；
                      隐藏的是最早的记录，底部按钮向下逐批加载更早的 */}
                  {toolSteps.slice(-toolVisible).reverse().map((s) => (
                    <ToolCard key={s.key} step={s} />
                  ))}
                  {toolSteps.length > toolVisible && (
                    <button className="load-more" onClick={() => setToolVisible((v) => v + TOOL_PAGE)}>
                      加载更早的 {toolSteps.length - toolVisible} 条
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="task-strip" title="任务执行过程" onClick={() => setPanelOpen(true)}>
            <span className={`ts-dot ${busy ? 'busy' : ''}`} />
            <span className="ts-text">执行过程</span>
          </div>
        </aside>
      </div>

      {/* 文件右键菜单：打开 / 打开所在文件夹 / 复制路径 */}
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div className="ctx-title" title={ctxMenu.abs}>
            {ctxMenu.type === 'dir' ? '📁' : fileIcon(ctxMenu.name)} {ctxMenu.name}
          </div>
          <button
            onClick={() => {
              api.fileOpen(ctxMenu.abs)
              setCtxMenu(null)
            }}
          >
            打开
          </button>
          <button
            onClick={() => {
              api.fileShowInFolder(ctxMenu.abs)
              setCtxMenu(null)
            }}
          >
            打开所在文件夹
          </button>
          <button
            onClick={() => {
              api.copyText(ctxMenu.abs)
              setToast('已复制路径')
              setCtxMenu(null)
            }}
          >
            复制路径
          </button>
        </div>
      )}

      {perm && (
        <div className="perm-mask">
          <div className="perm-card">
            <div className="perm-title">需要你的确认</div>
            <div className="perm-desc">
              AI 想要执行操作：
              <code>{PERMISSION_ITEMS.find((x) => x.key === perm.permission)?.label || perm.permission}</code>
            </div>
            {perm.metadata?.command ? (
              // 实际命令最精确：bash 等权限的 patterns 内容就是命令本身，与 command 重复，只显示 command
              <div className="perm-cmd">
                <code>{perm.metadata.command}</code>
              </div>
            ) : (
              perm.patterns && perm.patterns.length > 0 && (
                <div className="perm-cmd">
                  {[...new Set(perm.patterns)].map((s, i) => (
                    <code key={i}>{s}</code>
                  ))}
                </div>
              )
            )}
            <div className="perm-btns">
              <button onClick={() => respondPerm('reject')}>拒绝</button>
              <button onClick={() => respondPerm('once')}>允许一次</button>
              <button className="primary" onClick={() => respondPerm('always')}>
                总是允许
              </button>
            </div>
          </div>
        </div>
      )}

      {question && (
        <div className="perm-mask">
          <div className="perm-card question-card">
            <div className="perm-title">AI 向你提问</div>
            {question.questions.map((q, i) => {
              const opts = q.options || []
              return (
                <div className="q-item" key={i}>
                  {q.header && <div className="q-header">{q.header}</div>}
                  <div className="q-text">{q.question}</div>
                  {opts.length > 0 ? (
                    <div className="q-opts">
                      {opts.map((o) => {
                        const sel = (qSel[i] || []).includes(o.label)
                        return (
                          <button
                            key={o.label}
                            className={'q-opt' + (sel ? ' sel' : '')}
                            onClick={() => toggleQOption(i, o.label)}
                          >
                            <span className="q-opt-label">{o.label}</span>
                            {o.description && <span className="q-opt-desc">{o.description}</span>}
                          </button>
                        )
                      })}
                      <button
                        className={'q-opt other' + (qOther[i] ? ' sel' : '')}
                        onClick={() => toggleQOther(i)}
                      >
                        <span className="q-opt-label">其它（自行输入）</span>
                      </button>
                      {qOther[i] && (
                        <input
                          className="q-input"
                          value={qText[i] || ''}
                          placeholder="输入你的回答…"
                          onChange={(e) =>
                            setQText((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitQuestion()
                          }}
                          autoFocus
                        />
                      )}
                    </div>
                  ) : (
                    <input
                      className="q-input"
                      value={qText[i] || ''}
                      placeholder="输入你的回答…"
                      onChange={(e) =>
                        setQText((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitQuestion()
                      }}
                      autoFocus
                    />
                  )}
                </div>
              )
            })}
            <div className="perm-btns">
              <button onClick={cancelQuestion}>取消</button>
              <button className="primary" onClick={submitQuestion}>
                提交回答
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="perm-mask z-top">
          <div className="perm-card">
            <div className="perm-title">{confirm.title || '需要确认'}</div>
            <div className="perm-desc">{confirm.message}</div>
            <div className="perm-btns">
              <button onClick={() => setConfirm(null)}>取消</button>
              <button
                className={confirm.danger ? 'danger' : 'primary'}
                onClick={() => {
                  const fn = confirm.onConfirm
                  setConfirm(null)
                  fn && fn()
                }}
              >
                {confirm.confirmLabel || '确认'}
              </button>
            </div>
          </div>
        </div>
      )}

      {undoDraft && (
        <div className="perm-mask z-top">
          <div className="perm-card">
            <div className="perm-title">回退到此轮对话之前？</div>
            <div className="perm-desc">将撤销此条及之后全部 AI 变更，此操作不可恢复。</div>
            <div className="perm-desc">实际影响了哪些文件，将在回退完成后展示。</div>
            <div className="perm-btns">
              <button onClick={() => setUndoDraft(null)}>取消</button>
              <button className="danger" onClick={onUndoConfirm}>
                确认回退
              </button>
            </div>
          </div>
        </div>
      )}

      {undoResult && (
        <div className="perm-mask z-top">
          <div className="perm-card">
            <div className="perm-title">已回退到此轮对话之前</div>
            <div className="undo-impact">
              <div className="undo-impact-head">实际影响（{undoResult.impact.length} 个）</div>
              <div className="undo-impact-list">
                {undoResult.impact.map((f, i) => {
                  const meta = UNDO_IMPACT_META[f.type] || { icon: '📄', note: '' }
                  return (
                    <div className="undo-impact-item" key={i}>
                      <span className="undo-impact-icon">{meta.icon}</span>
                      <span className="undo-impact-path">{f.path}</span>
                      <span className="undo-impact-note">{meta.note}</span>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="perm-btns">
              <button className="primary" onClick={() => setUndoResult(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {skillHubOpen && (
        <div className="perm-mask" onClick={() => setSkillHubOpen(false)}>
          <div className="perm-card skill-hub-card" onClick={(e) => e.stopPropagation()}>
            <div className="perm-title">🧩 Skill Hub</div>
            {skillLoading ? (
              <div className="skill-hub-state">技能加载中…</div>
            ) : skillError ? (
              <div className="skill-hub-state">
                <div className="skill-hub-error">{skillError}</div>
                <button className="primary" onClick={openSkillHub}>重试</button>
              </div>
            ) : skills.length === 0 ? (
              <div className="skill-hub-state">暂无可用技能</div>
            ) : (
              <div className="skill-list">
                {[...skills]
                  .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
                  .map((s) => (
                    <div className="skill-card" key={s.id} data-skill-id={s.id}>
                      <div className="skill-icon">{s.icon || '🧩'}</div>
                      <div className="skill-card-main">
                        <div className="skill-card-head">
                          <span className="skill-name">{s.name}</span>
                          <span className="skill-slug">/{s.slug}</span>
                        </div>
                        <div className="skill-desc">{s.description}</div>
                        <div className="skill-meta">{s.file_count ?? 0} 个文件</div>
                      </div>
                      {skillInstalled[s.slug] ? (
                        <button className="skill-install" onClick={() => uninstallSkill(s)}>
                          卸载
                        </button>
                      ) : (
                        <button
                          className="skill-install"
                          disabled={skillBusy === s.id}
                          onClick={() => installSkill(s)}
                        >
                          {skillBusy === s.id ? '安装中…' : '安装'}
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            )}
            <div className="perm-btns">
              <button onClick={restartEngine}>重启引擎</button>
              <button className="primary" onClick={() => setSkillHubOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {settingsOpen && settingsData && (
        <SettingsPanel
          data={settingsData}
          busy={busy}
          theme={theme}
          appInfo={appInfo}
          engineVersion={engine.version}
          appConfig={appConfig}
          onThemeChange={applyTheme}
          onCloseActionChange={applyCloseAction}
          onNotifyTaskChange={applyNotifyTask}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
          onSaveConfig={saveAppConfig}
        />
      )}
    </div>
  )
}

// 模型组表单空草稿（添加/编辑共用）
const EMPTY_DRAFT = { name: '', baseURL: '', apiKey: '', modelsText: '' }

// 模型组表单字段（添加与编辑共用）：组名 / Base URL / API Key / 模型 ID + 测试连接
function GroupFormFields({ draft, setDraft, apiKeyPlaceholder, test, onTest, onCancel, onSubmit, submitLabel }) {
  const valid = draft.name.trim() && draft.baseURL.trim() && draft.modelsText.trim()
  return (
    <>
      <div className="set-group">
        <div className="set-label">组名（如 DeepSeek / Kimi）</div>
        <input
          className="set-input"
          placeholder="Kimi"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </div>
      <div className="set-group">
        <div className="set-label">Base URL（OpenAI 兼容）</div>
        <input
          className="set-input"
          placeholder="https://api.moonshot.cn/v1"
          value={draft.baseURL}
          onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
        />
      </div>
      <div className="set-group">
        <div className="set-label">API Key</div>
        <input
          className="set-input"
          type="password"
          placeholder={apiKeyPlaceholder}
          value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
        />
      </div>
      <div className="set-group">
        <div className="set-label">模型 ID（每行一个，可添加多个）</div>
        <textarea
          className="set-input mg-models"
          rows={3}
          placeholder={'kimi-k2-0711-preview\nmoonshot-v1-8k'}
          value={draft.modelsText}
          onChange={(e) => setDraft({ ...draft, modelsText: e.target.value })}
        />
      </div>
      <div className="mg-form-btns">
        <button onClick={(e) => onTest(e)} disabled={!draft.baseURL.trim() || test?.status === 'testing'}>
          {test?.status === 'testing' ? '测试中…' : '测试连接'}
        </button>
        <button onClick={onCancel}>取消</button>
        <button className="primary" disabled={!valid} onClick={onSubmit}>
          {submitLabel}
        </button>
      </div>
    </>
  )
}

// 模型组卡片（编辑⇄收起切换动画）：表单与卡片同 DOM 挂载、display 互斥切换，
// 容器 height 由 JS 测量内容高度后 transition 平滑过渡（0fr 互斥 grid 的总高会跳变，不用）
// test/onTest = 卡片测试（已保存配置）；formTest/onFormTest = 表单测试（当前草稿）
function GroupCard({
  g,
  editing,
  draft,
  setDraft,
  test,
  onTest,
  formTest,
  onFormTest,
  onEdit,
  onRemove,
  onCancel,
  onSubmit
}) {
  const boxRef = useRef(null)
  const formRef = useRef(null)
  const cardRef = useRef(null)
  const prevH = useRef(null) // 上一次的目标高度（= 本次动画的起点）
  useEffect(() => {
    const el = boxRef.current
    const form = formRef.current
    const card = cardRef.current
    if (!el || !form || !card) return
    // 当前显示内容的实际高度（表单或卡片）
    const target = editing ? form.offsetHeight : card.offsetHeight
    el.style.height = prevH.current == null ? 'auto' : prevH.current + 'px'
    requestAnimationFrame(() => {
      el.style.height = target + 'px'
      prevH.current = target
    })
  }, [editing])
  return (
    <div className={`mg-anim ${editing ? 'editing' : ''}`} ref={boxRef}>
      <div className="mg-form" ref={formRef}>
        <GroupFormFields
          draft={draft}
          setDraft={setDraft}
          apiKeyPlaceholder="sk-…（留空保留原值）"
          test={formTest}
          onTest={onFormTest}
          onCancel={onCancel}
          onSubmit={onSubmit}
          submitLabel="保存修改"
        />
      </div>
      <div className="mg-card" ref={cardRef}>
        <div className="mg-card-head">
          <span className="mg-name">{g.name}</span>
          <div className="mg-card-actions">
            <button
              className="mg-test"
              onClick={(e) => onTest(e)}
              disabled={test?.status === 'testing'}
              title="测试该组已保存的 Base URL 与 API Key"
            >
              {test?.status === 'testing' ? '测试中…' : '测试'}
            </button>
            <button className="mg-edit" onClick={onEdit}>
              编辑
            </button>
            <button className="mg-del" onClick={onRemove}>
              删除
            </button>
          </div>
        </div>
        <div className="mg-row" title={g.baseURL}>
          {g.baseURL}
        </div>
        <div className="mg-row">{g.models.join('、')}</div>
      </div>
    </div>
  )
}

// 设置面板：总览式（左侧导航 + 右侧内容），含「模型设置」「界面设置」「权限设置」「关于」
function SettingsPanel({ data, busy, theme, appInfo, engineVersion, appConfig, onThemeChange, onCloseActionChange, onNotifyTaskChange, onClose, onSave, onSaveConfig }) {
  const [tab, setTab] = useState('model') // model | appearance | permission | config | about
  const [form, setForm] = useState(data)
  useEffect(() => setForm(data), [data])
  // 「配置」页表单草稿：由有效配置（默认值 + 用户覆盖层）异步到达后填充；多行字段以文本承载便于编辑
  const [configForm, setConfigForm] = useState(null)
  useEffect(() => {
    if (!appConfig) return
    setConfigForm({
      skillApiBase: appConfig.skillApiBase || '',
      enginePort: appConfig.enginePort ?? '',
      window: { ...(appConfig.window || {}) },
      hideDirsText: (appConfig.hideDirs || []).join('\n'),
      hideFilesText: (appConfig.hideFiles || []).join('\n')
    })
  }, [appConfig])
  const [adding, setAdding] = useState(false) // 是否显示「添加模型组」表单
  const [editing, setEditing] = useState(null) // 正在编辑的模型组下标（null = 未编辑）
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT }) // 添加/编辑模型组草稿
  const [cardTest, setCardTest] = useState({}) // 卡片测试状态：groupId -> {status:'testing'|'ok'|'fail', error?}
  const [formTest, setFormTest] = useState(null) // 添加/编辑表单草稿测试状态（同一时刻只有一个表单）
  const [bubble, setBubble] = useState(null) // 测试结果漂浮气泡：{top, right, status:'ok'|'fail', error?}
  const bubbleTimer = useRef(null)
  // 卸载时清理成功气泡的自动消失定时器
  useEffect(() => () => { if (bubbleTimer.current) clearTimeout(bubbleTimer.current) }, [])
  // 检查更新状态机：idle | checking | available | downloading | downloaded | latest | error
  const [update, setUpdate] = useState({ status: 'idle' })
  // 订阅主进程推送的更新事件（update.*），驱动状态机
  useEffect(() => {
    const off = window.xwork.onEvent((evt) => {
      if (!evt.type || !evt.type.startsWith('update.')) return
      const t = evt.type.slice('update.'.length)
      const p = evt.properties || {}
      if (t === 'checking-for-update') setUpdate({ status: 'checking' })
      else if (t === 'update-available') setUpdate({ status: 'available', version: p.version })
      else if (t === 'update-not-available') setUpdate({ status: 'latest' })
      else if (t === 'download-progress')
        setUpdate((u) => ({ ...u, status: 'downloading', percent: Math.round(p.percent || 0) }))
      else if (t === 'update-downloaded')
        setUpdate((u) => ({ ...u, status: 'downloaded', version: p.version || u.version }))
      else if (t === 'error') setUpdate({ status: 'error', message: p.message || '更新过程出错' })
    })
    return off
  }, [])
  // 手动检查更新；开发模式下主进程未启用 autoUpdater，返回 disabled 提示
  const doCheckUpdate = async () => {
    setUpdate({ status: 'checking' })
    const r = await window.xwork.updateCheck()
    if (!r.ok) setUpdate({ status: 'error', message: r.disabled ? '开发模式下不可用，请使用安装版验证' : r.error })
  }
  const resetDraft = () => setDraft({ ...EMPTY_DRAFT })
  const updateGroups = (updater) => setForm((f) => ({ ...f, modelGroups: updater(f.modelGroups || []) }))
  const removeGroup = (gi) => updateGroups((gs) => gs.filter((_, i) => i !== gi))
  // 开始添加：关闭编辑，清空草稿
  const startAdd = () => {
    setAdding(true)
    setEditing(null)
    resetDraft()
    setFormTest(null)
  }
  // 开始编辑：关闭添加，草稿预填该组数据（apiKey 留空 = 保存时保留原值）
  const startEdit = (gi) => {
    const g = (form.modelGroups || [])[gi]
    if (!g) return
    setAdding(false)
    setEditing(gi)
    setDraft({ name: g.name, baseURL: g.baseURL, apiKey: '', modelsText: g.models.join('\n') })
    setFormTest(null)
  }
  const cancelForm = () => {
    setAdding(false)
    setEditing(null)
    resetDraft()
    setFormTest(null)
  }
  // 在测试按钮附近弹出结果气泡：成功自动消失，失败手动关闭（✕）
  const showBubble = (anchor, result) => {
    const r = anchor.getBoundingClientRect()
    // 下方空间不足时改为在按钮上方弹出
    const below = window.innerHeight - r.bottom > 120
    setBubble({
      top: below ? r.bottom + 8 : undefined,
      bottom: below ? undefined : window.innerHeight - r.top + 8,
      right: Math.max(8, window.innerWidth - r.right),
      status: result.ok ? 'ok' : 'fail',
      error: result.error || ''
    })
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    if (result.ok) {
      // 成功：停留 2s 后淡出（leaving 触发 opacity 过渡），结束后卸载
      bubbleTimer.current = setTimeout(() => {
        setBubble((b) => (b ? { ...b, leaving: true } : b))
        bubbleTimer.current = setTimeout(() => setBubble(null), 250)
      }, 2000)
    }
  }
  // 测试连接：卡片测已保存配置（key 由主进程解密）；表单测当前草稿（未保存的 baseURL/key）
  const runCardTest = async (g, e) => {
    if ((cardTest[g.id] || {}).status === 'testing') return
    const anchor = e.currentTarget
    setCardTest((m) => ({ ...m, [g.id]: { status: 'testing' } }))
    try {
      const r = await window.xwork.modelTest({ groupId: g.id })
      const result = r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || '连接失败' }
      setCardTest((m) => ({ ...m, [g.id]: result.ok ? { status: 'ok' } : { status: 'fail', error: result.error } }))
      showBubble(anchor, result)
    } catch (err) {
      setCardTest((m) => ({ ...m, [g.id]: { status: 'fail', error: err.message } }))
      showBubble(anchor, { ok: false, error: err.message })
    }
  }
  const runFormTest = async (e) => {
    if ((formTest || {}).status === 'testing' || !draft.baseURL.trim()) return
    const anchor = e.currentTarget
    setFormTest({ status: 'testing' })
    // 编辑表单：传组 id，草稿 key 留空时主进程回退已保存 key（「留空保留原值」语义）
    const gid = editing != null ? (form.modelGroups || [])[editing]?.id : undefined
    try {
      const r = await window.xwork.modelTest({ groupId: gid, baseURL: draft.baseURL, apiKey: draft.apiKey })
      const result = r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || '连接失败' }
      setFormTest(result.ok ? { status: 'ok' } : { status: 'fail', error: result.error })
      showBubble(anchor, result)
    } catch (err) {
      setFormTest({ status: 'fail', error: err.message })
      showBubble(anchor, { ok: false, error: err.message })
    }
  }
  // 权限设置：单项三档切换 / 预设档位一键填充
  const setPermItem = (k, v) => setForm((f) => ({ ...f, permission: { ...f.permission, [k]: v } }))
  const applyPreset = (name) => setForm((f) => ({ ...f, permission: { ...PERMISSION_PRESETS[name] } }))
  const confirmAdd = () => {
    const models = draft.modelsText.split('\n').map((x) => x.trim()).filter(Boolean)
    updateGroups((gs) => [
      ...gs,
      {
        id: 'xgroup-' + Math.random().toString(36).slice(2, 12),
        name: draft.name.trim(),
        baseURL: draft.baseURL.trim(),
        apiKey: draft.apiKey.trim(),
        models
      }
    ])
    cancelForm()
  }
  const confirmEdit = () => {
    if (editing === null) return
    const models = draft.modelsText.split('\n').map((x) => x.trim()).filter(Boolean)
    updateGroups((gs) =>
      gs.map((g, i) =>
        i === editing
          ? {
              ...g, // 保留 id（会话绑定保持稳定）
              name: draft.name.trim(),
              baseURL: draft.baseURL.trim(),
              apiKey: draft.apiKey.trim() ? draft.apiKey.trim() : g.apiKey, // 留空保留原 key
              models
            }
          : g
      )
    )
    cancelForm()
  }

  // 「保存」：模型/权限/配置仅写设置不关闭（可见保存提示）；界面设置主题已即时保存；关于页无表单
  const handleSave = () => {
    if (tab === 'model') onSave(form, false)
    else if (tab === 'permission') onSave(form, false, '权限设置已保存，将应用于之后新建的会话')
    else if (tab === 'config') {
      if (!configForm) return
      // 多行字段按行拆分还原为数组；数值字段原样传递（主进程 sanitize 做类型/范围校验）
      onSaveConfig({
        skillApiBase: configForm.skillApiBase,
        enginePort: configForm.enginePort,
        window: configForm.window,
        hideDirs: configForm.hideDirsText.split('\n').map((x) => x.trim()).filter(Boolean),
        hideFiles: configForm.hideFilesText.split('\n').map((x) => x.trim()).filter(Boolean)
      })
    }
    else onClose()
  }

  return (
    <div className="perm-mask">
      <div className="perm-card settings-card settings-wrap">
        {/* 左侧导航：设置分类 */}
        <div className="settings-nav">
          <div className="settings-nav-title">设置</div>
          <button className={`settings-nav-item ${tab === 'model' ? 'active' : ''}`} onClick={() => setTab('model')}>
            ⚙️ 模型设置
          </button>
          <button className={`settings-nav-item ${tab === 'appearance' ? 'active' : ''}`} onClick={() => setTab('appearance')}>
            🎨 界面设置
          </button>
          <button className={`settings-nav-item ${tab === 'permission' ? 'active' : ''}`} onClick={() => setTab('permission')}>
            🛡️ 权限设置
          </button>
          <button className={`settings-nav-item ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>
            📄 配置
          </button>
          <button className={`settings-nav-item ${tab === 'about' ? 'active' : ''}`} onClick={() => setTab('about')}>
            ℹ️ 关于
          </button>
        </div>

        {/* 右侧内容：可滚动设置区 + 固定底部按钮栏 */}
        <div className="settings-col">
          <div className="settings-body">
            {tab === 'model' ? (
            <>
              <div className="perm-title">模型设置</div>

              {/* 自定义模型组：每次添加 = 一个 OpenAI 兼容 URL + 多个模型 ID */}
              <div className="set-group">
                <div className="set-label">模型组（自定义 OpenAI 兼容接口）</div>
                {(form.modelGroups || []).length === 0 && (
                  <div className="set-hint">
                    尚未添加模型组。可添加 DeepSeek / Kimi 等任意 OpenAI 兼容服务，每个组支持多个模型 ID。
                  </div>
                )}
                {/* 每个模型组：表单与卡片同挂载，编辑⇄收起平滑动画 */}
                {(form.modelGroups || []).map((g, gi) => (
                  <GroupCard
                    key={g.id}
                    g={g}
                    editing={editing === gi}
                    draft={draft}
                    setDraft={setDraft}
                    test={cardTest[g.id]}
                    onTest={(e) => runCardTest(g, e)}
                    formTest={formTest}
                    onFormTest={runFormTest}
                    onEdit={() => startEdit(gi)}
                    onRemove={() => removeGroup(gi)}
                    onCancel={cancelForm}
                    onSubmit={confirmEdit}
                  />
                ))}
                {adding ? (
                  <div className="mg-form">
                    <GroupFormFields
                      draft={draft}
                      setDraft={setDraft}
                      apiKeyPlaceholder="sk-…"
                      test={formTest}
                      onTest={runFormTest}
                      onCancel={cancelForm}
                      onSubmit={confirmAdd}
                      submitLabel="添加模型组"
                    />
                  </div>
                ) : (
                  <button className="mg-add" onClick={startAdd}>
                    + 添加模型组
                  </button>
                )}
              </div>

              <div className="set-hint">模型设置保存并重启引擎后生效；任务执行中不可保存。</div>
            </>
          ) : tab === 'config' ? (
            <>
              <div className="perm-title">配置</div>

              {/* 技能服务地址：Skill Hub 列表 / 下载接口所在服务 */}
              <div className="set-group">
                <div className="set-label">技能服务地址</div>
                <input
                  className="set-input"
                  placeholder="http://localhost:4321"
                  value={configForm?.skillApiBase || ''}
                  onChange={(e) => setConfigForm((c) => (c ? { ...c, skillApiBase: e.target.value } : c))}
                />
                <div className="set-hint">Skill Hub 技能列表与下载接口的地址。</div>
              </div>

              {/* 引擎端口：opencode 引擎监听端口 */}
              <div className="set-group">
                <div className="set-label">opencode 引擎端口</div>
                <input
                  className="set-input"
                  type="number"
                  min={1}
                  max={65535}
                  value={configForm?.enginePort ?? ''}
                  onChange={(e) => setConfigForm((c) => (c ? { ...c, enginePort: e.target.value } : c))}
                />
              </div>

              {/* 窗口尺寸：宽/高/最小宽/最小高 */}
              <div className="set-group">
                <div className="set-label">窗口尺寸（重启应用后生效）</div>
                <div className="cfg-row">
                  {[
                    ['width', '宽'],
                    ['height', '高'],
                    ['minWidth', '最小宽'],
                    ['minHeight', '最小高']
                  ].map(([k, label]) => (
                    <div key={k} className="cfg-cell">
                      <input
                        className="set-input"
                        type="number"
                        min={1}
                        value={configForm?.window?.[k] ?? ''}
                        onChange={(e) =>
                          setConfigForm((c) => (c ? { ...c, window: { ...c.window, [k]: e.target.value } } : c))
                        }
                      />
                      <div className="set-label">{label}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 文件树隐藏目录 / 隐藏文件：每行一个 */}
              <div className="set-group">
                <div className="set-label">文件树隐藏目录（每行一个）</div>
                <textarea
                  className="set-input"
                  rows={4}
                  placeholder={'node_modules\n.git\ndist'}
                  value={configForm?.hideDirsText || ''}
                  onChange={(e) => setConfigForm((c) => (c ? { ...c, hideDirsText: e.target.value } : c))}
                />
              </div>
              <div className="set-group">
                <div className="set-label">文件树隐藏文件（每行一个）</div>
                <textarea
                  className="set-input"
                  rows={3}
                  placeholder={'.DS_Store\nThumbs.db'}
                  value={configForm?.hideFilesText || ''}
                  onChange={(e) => setConfigForm((c) => (c ? { ...c, hideFilesText: e.target.value } : c))}
                />
              </div>

              <div className="set-hint">
                保存后即时生效（文件树隐藏列表）；引擎端口与窗口尺寸需重启应用后生效。
              </div>
            </>
          ) : tab === 'permission' ? (
            <>
              <div className="perm-title">权限设置</div>

              {/* 预设档位：一键填充所有操作类型 */}
              <div className="set-group">
                <div className="set-label">快速预设</div>
                <div className="perm-presets">
                  {Object.keys(PERMISSION_PRESETS).map((name) => (
                    <button key={name} className="perm-preset-btn" onClick={() => applyPreset(name)}>
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              {/* 操作清单：每项三档（允许 / 询问 / 禁止） */}
              <div className="perm-list">
                {PERMISSION_ITEMS.map((it) => (
                  <div className="perm-item" key={it.key}>
                    <div className="perm-item-info">
                      <div className="perm-item-name">{it.label}</div>
                      <div className="perm-item-desc">{it.desc}</div>
                    </div>
                    <div className="perm-opts">
                      {[
                        ['allow', '允许'],
                        ['ask', '询问'],
                        ['deny', '禁止']
                      ].map(([act, label]) => (
                        <label key={act} className="perm-opt">
                          <input
                            type="radio"
                            name={`perm-${it.key}`}
                            data-action={act}
                            checked={(form.permission && form.permission[it.key]) === act}
                            onChange={() => setPermItem(it.key, act)}
                          />
                          <span data-action={act}>{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="set-hint">
                权限配置保存并重启引擎后全局生效：新会话按全局规则执行；
                <br />
                注意：历史会话中曾被设为「禁止」的操作类型仍会直接拒绝，需新建会话才彻底放开。
              </div>
            </>
          ) : tab === 'about' ? (
            <>
              <div className="perm-title">关于</div>

              {/* 基础版本信息：应用名 + 右侧检查更新入口（进设置第一眼可见） */}
              <div className="set-group">
                <div className="about-head">
                  <div className="about-logo">X</div>
                  <div className="about-id">
                    <div className="about-name">{appInfo?.name || 'XWork'}</div>
                    <div className="about-ver">版本 {appInfo?.version || '—'}</div>
                  </div>
                  <div className="about-update" title={update.status === 'error' ? update.message : undefined}>
                    {update.status === 'idle' && (
                      <button className="about-update-btn accent" onClick={doCheckUpdate}>
                        检查更新
                      </button>
                    )}
                    {update.status === 'checking' && <span className="about-update-hint">检查中…</span>}
                    {update.status === 'latest' && <span className="about-update-hint">已是最新版本</span>}
                    {update.status === 'available' && (
                      <button
                        className="about-update-btn accent"
                        onClick={async () => {
                          const r = await window.xwork.updateDownload()
                          if (!r.ok) setUpdate({ status: 'error', message: r.error })
                        }}
                      >
                        下载 v{update.version}
                      </button>
                    )}
                    {update.status === 'downloading' && (
                      <span className="about-update-hint">下载中 {update.percent}%</span>
                    )}
                    {update.status === 'downloaded' && (
                      <button
                        className="about-update-btn accent"
                        onClick={async () => {
                          const r = await window.xwork.updateInstall()
                          if (!r.ok) setUpdate({ status: 'error', message: r.error })
                        }}
                      >
                        重启并安装
                      </button>
                    )}
                    {update.status === 'error' && (
                      <button className="about-update-btn" onClick={doCheckUpdate}>
                        重试
                      </button>
                    )}
                  </div>
                </div>
                <div className="about-rows">
                  <div className="about-row">
                    <span>opencode 引擎</span>
                    <span>{engineVersion ? 'v' + engineVersion : '未连接'}</span>
                  </div>
                  <div className="about-row">
                    <span>Electron</span>
                    <span>{appInfo?.electron || '—'}</span>
                  </div>
                  <div className="about-row">
                    <span>Chromium</span>
                    <span>{appInfo?.chrome || '—'}</span>
                  </div>
                  <div className="about-row">
                    <span>Node.js</span>
                    <span>{appInfo?.node || '—'}</span>
                  </div>
                  <div className="about-row">
                    <span>平台</span>
                    <span>{appInfo?.platform || '—'}</span>
                  </div>
                </div>
              </div>

              {/* 项目链接：系统浏览器打开（shell.openExternal） */}
              <div className="set-group">
                <div className="set-label">项目链接</div>
                <button
                  className="about-link"
                  onClick={() => window.xwork.openExternal('https://github.com/XWR525/XWork')}
                >
                  <span>GitHub 仓库</span>
                  <span>↗</span>
                </button>
                <button
                  className="about-link"
                  onClick={() => window.xwork.openExternal('https://github.com/XWR525/XWork/issues')}
                >
                  <span>问题反馈（Issues）</span>
                  <span>↗</span>
                </button>
              </div>

              {/* 日志：打开真实写入的日志目录 */}
              <div className="set-group">
                <div className="set-label">日志</div>
                <button
                  className="about-link"
                  onClick={async () => {
                    const r = await window.xwork.logOpen()
                    if (!r.ok) setToast('无法打开日志目录')
                  }}
                >
                  <span>打开日志目录</span>
                  <span>📂</span>
                </button>
                <div className="set-hint">应用运行日志（含报错）写入该目录，排查问题时可在此查看。</div>
              </div>

              {/* 许可与致谢 */}
              <div className="set-group">
                <div className="set-label">许可与致谢</div>
                <div className="about-rows">
                  <div className="about-row">
                    <span>XWork</span>
                    <span>MIT License</span>
                  </div>
                  <div className="about-row">
                    <span>Electron</span>
                    <span>MIT License</span>
                  </div>
                  <div className="about-row">
                    <span>Chromium</span>
                    <span>BSD-3-Clause</span>
                  </div>
                  <div className="about-row">
                    <span>React</span>
                    <span>MIT License</span>
                  </div>
                  <div className="about-row">
                    <span>opencode 引擎</span>
                    <span>MIT License</span>
                  </div>
                  <div className="about-row">
                    <span>electron-builder / NSIS</span>
                    <span>MIT / zlib 许可</span>
                  </div>
                </div>
                <div className="set-hint">
                  本项目基于 MIT 许可开源，完整许可文本随安装包（LICENSE.electron.txt 等）一同分发。
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="perm-title">界面设置</div>

              <div className="set-group">
                <div className="set-title">界面风格</div>
                <div className="set-desc">界面主题即时生效并自动保存，无需重启引擎。</div>
                <label className="set-radio">
                  <input type="radio" name="theme" checked={theme === 'dark'} onChange={() => onThemeChange('dark')} />
                  🌙 暗色
                </label>
                <label className="set-radio">
                  <input type="radio" name="theme" checked={theme === 'light'} onChange={() => onThemeChange('light')} />
                  🌞 亮色
                </label>
              </div>

              <div className="set-group">
                <div className="set-title">关闭窗口时</div>
                <div className="set-desc">「最小化到托盘」时，关闭窗口不会退出程序，AI 任务在后台继续运行；点击托盘图标恢复窗口，右键托盘菜单可退出。</div>
                <label className="set-radio">
                  <input type="radio" name="closeAction" checked={(data.closeAction || 'quit') === 'quit'} onChange={() => onCloseActionChange('quit')} />
                  ❌ 关闭程序
                </label>
                <label className="set-radio">
                  <input type="radio" name="closeAction" checked={(data.closeAction || 'quit') === 'tray'} onChange={() => onCloseActionChange('tray')} />
                  🚩 最小化到系统托盘
                </label>
              </div>

              <div className="set-group">
                <div className="set-title">任务通知</div>
                <div className="set-desc">AI 完成回复或向你提问时，在系统托盘弹出通知（仅窗口不在前台时）。</div>
                <label className="set-toggle">
                  <input type="checkbox" checked={data.notifyTask !== false} onChange={(e) => onNotifyTaskChange(e.target.checked)} />
                  <span className="set-toggle-track" />
                  <span className="set-toggle-label">{data.notifyTask !== false ? '开启' : '关闭'}</span>
                </label>
              </div>
            </>
          )}
          </div>

          {/* 面板级底部按钮：始终显示「取消」「保存」；模型设置另需「保存并重启」 */}
          <div className="settings-footer">
            <button onClick={onClose}>取消</button>
            <button onClick={handleSave}>保存</button>
            {tab === 'model' && (
              <button className="primary" disabled={busy} onClick={() => onSave(form, true)}>
                保存并重启引擎
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 测试连接结果漂浮气泡：跟随测试按钮弹出；成功自动消失，失败手动关闭 */}
      {bubble && (
        <div
          className={`test-bubble ${bubble.status}${bubble.leaving ? ' leaving' : ''}`}
          style={{ top: bubble.top, bottom: bubble.bottom, right: bubble.right }}
          role="status"
        >
          <span>{bubble.status === 'ok' ? '✓ 连接正常' : '✗ ' + (bubble.error || '连接失败')}</span>
          {bubble.status === 'fail' && (
            <button className="test-bubble-close" onClick={() => setBubble(null)} title="关闭">
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// opencode 内置模式（agent）说明：build 全工具开发；plan 只读规划（禁 write/edit/patch/bash）
const AGENT_OPTIONS = [
  { id: 'build', label: '执行 - Build', desc: '可修改文件、执行命令（默认）' },
  { id: 'plan', label: '规划 - Plan', desc: '只读权限：不能修改文件、不执行命令' }
]

// 模式选择器：与模型选择器同款交互（按钮 + 向上弹出的选项列表），位于模型选择器左侧
function AgentPicker({ value, onPick }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  // 点击外部 / 失焦时关闭
  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [open])
  const current = AGENT_OPTIONS.find((a) => a.id === value) || AGENT_OPTIONS[0]
  return (
    <div className="model-picker" ref={ref}>
      <button
        className="model-pick-btn"
        onClick={() => setOpen(!open)}
        title="本次对话的模式（build：可修改文件、执行命令；plan：只读，不能修改文件）"
      >
        <span className="mp-label">{current.label}</span>
        <span className="mp-arrow">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="model-pop">
          {AGENT_OPTIONS.map((a) => (
            <button
              key={a.id}
              className={`model-opt ${value === a.id ? 'active' : ''}`}
              onClick={() => {
                onPick(a.id)
                setOpen(false)
              }}
            >
              <div className="mp-opt-title">{a.label}</div>
              <div className="mp-opt-desc">{a.desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 模型选择器：按钮 + 向上弹出的选项列表（位于输入框右下角发送按钮左侧）
function ModelPicker({ models, value, onPick }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  // 点击外部 / 失焦时关闭
  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [open])
  const current =
    value && models.find((m) => m.providerID === value.providerID && m.modelID === value.modelID)
  return (
    <div className="model-picker" ref={ref}>
      <button
        className="model-pick-btn"
        onClick={() => setOpen(!open)}
        title="本次对话使用的模型（发送后绑定到该对话）"
      >
        <span className="mp-label">{current ? current.label : '选择模型'}</span>
        <span className="mp-arrow">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="model-pop">
          {models.length === 0 ? (
            <div className="model-pop-empty">暂无可选模型</div>
          ) : (
            models.map((m) => (
              <button
                key={m.providerID + '/' + m.modelID}
                className={`model-opt ${
                  current && current.providerID === m.providerID && current.modelID === m.modelID ? 'active' : ''
                }`}
                onClick={() => {
                  onPick(m.providerID + '/' + m.modelID)
                  setOpen(false)
                }}
              >
                {m.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// 工具调用卡片（任务执行面板）
function ToolCard({ step }) {
  const [open, setOpen] = useState(false)
  const st = step.state?.status || 'pending'
  const input = step.state?.input
  const output = step.state?.output ?? step.state?.metadata?.output ?? ''
  // 引擎为每个工具调用记录 state.time = { start, end }（epoch 毫秒）；进行中只有 start
  const t = step.state?.time || {}
  const clock = fmtClock(t.start)
  const dur = fmtDur(t.start, t.end)
  const fmt = (v) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    return s.length > 800 ? s.slice(0, 800) + '\n…（已截断）' : s
  }
  return (
    <div className={`tool-card ${st}`}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`tool-dot ${st}`} />
        <span className="tool-name">{step.tool}</span>
        {clock && (
          <span className="tool-time" title={`开始 ${clock}${dur ? ' · 耗时 ' + dur : ''}`}>
            {clock}
            {dur ? ` · ${dur}` : ''}
          </span>
        )}
        <span className={`tool-status ${st}`}>{STATUS_LABEL[st] || st}</span>
        <span className="tool-arrow">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="tool-body">
          {input && (
            <div className="tool-field">
              <div className="field-label">输入</div>
              <pre>{fmt(input)}</pre>
            </div>
          )}
          {output ? (
            <div className="tool-field">
              <div className="field-label">输出</div>
              <pre>{fmt(output)}</pre>
            </div>
          ) : (
            st === 'running' && <div className="tool-field"><div className="field-label">输出</div><div className="running-dots">执行中…</div></div>
          )}
        </div>
      )}
    </div>
  )
}

// AI 思考过程：可折叠区块，展开/收起带高度过渡动画（grid 0fr→1fr，纯 CSS 无需测量高度）
// 流式进行中强制展开（与 <details open={streaming}> 行为一致），结束后按用户选择
// 思考文本内部独立滚动：贴底时跟随最新思考内容，上滑后停止跟随，滚回底部恢复
function ReasoningBlock({ text, streaming }) {
  const [open, setOpen] = useState(false)
  const isOpen = open || streaming
  const innerRef = useRef(null)
  const stickRef = useRef(true)
  useEffect(() => {
    const el = innerRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div className="reasoning">
      <button className={`reasoning-summary${isOpen ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className="reasoning-caret">▶</span>
        思考过程
      </button>
      <div className={`reasoning-body${isOpen ? ' open' : ''}`}>
        <div
          className="reasoning-inner"
          ref={innerRef}
          onScroll={() => {
            const el = innerRef.current
            if (!el) return
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
          }}
        >
          {text}
        </div>
      </div>
    </div>
  )
}

function MessageView({ m, onCopy, onUndo, canUndo, gitAvailable, busy }) {
  const mdText = m.parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n')
  if (m.role === 'user') {
    // 压缩会话产生的 compaction 消息：本身无正文，仅标记"此前的历史已被压缩"，显示为提示条而非空气泡
    if (m.parts.some((p) => p.type === 'compaction')) {
      return (
        <div className="row compact">
          <div className="compact-marker">历史对话已压缩</div>
        </div>
      )
    }
    // 「回退至此」按钮：hover 气泡时显示；无变更 / 无 git / 操作进行中时置灰并给 tooltip 说明
    const undoDisabled = !canUndo || busy || !gitAvailable
    const undoTitle = !gitAvailable
      ? '此功能需要本机安装 Git'
      : !canUndo
        ? '此条之后没有可撤销的变更'
        : '回退至此（撤销此条及之后的全部 AI 变更）'
    return (
      <div className="row user">
        <button
          className={'undo-btn' + (undoDisabled ? ' disabled' : '')}
          title={undoTitle}
          disabled={undoDisabled}
          onClick={() => !undoDisabled && onUndo && onUndo(m)}
        >
          ↶
        </button>
        <div className="bubble user">
          {m.parts.map((p, i) => (p.type === 'text' ? <div key={i}>{p.text}</div> : null))}
        </div>
      </div>
    )
  }
  return (
    <div className="row assistant">
      <div className="bubble assistant">
        {m.aborted && <div className="aborted-badge">已停止（输出不完整）</div>}
        {m.error && !m.aborted && <div className="msg-error">回复失败：{m.error}</div>}
        {m.parts.map((p, i) => {
          if (p.type === 'text') return null // 文本统一由下方 TextBlock 渲染
          if (p.type === 'reasoning') {
            return <ReasoningBlock key={i} text={p.text} streaming={m.streaming} />
          }
          if (p.type === 'tool') {
            // 仅显示工具名与状态，隐藏输入参数（可能含文件路径 / 完整代码，避免信息泄露）
            const st = p.state?.status || ''
            return (
              <div key={i} className={`tool-chip ${st}`}>
                [工具] {p.tool} {st && `· ${STATUS_LABEL[st] || st}`}
              </div>
            )
          }
          return null
        })}
        {mdText.trim() && <TextBlock key="text" text={mdText} streamed={m.streamed} />}
      </div>
      {mdText.trim() && !m.streaming && !m.aborted && (
        <button className="copy-btn" title="复制" onClick={() => onCopy(mdText)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      )}
    </div>
  )
}

// 文本块：曾流式输出的消息走打字机逐字揭示，历史消息直接渲染 Markdown
function TextBlock({ text, streamed }) {
  if (!streamed) {
    return <div className="md-body" dangerouslySetInnerHTML={{ __html: marked.parse(text) }} />
  }
  return <TypewriterText text={text} />
}

// 打字机组件：每 25ms 揭示 2 个字符，把引擎的整块 delta 平滑为逐字输出。
// 用 ref 记录已揭示长度，文本增长时持续追赶而不重置；揭示完成后渲染 Markdown。
function TypewriterText({ text }) {
  const textRef = useRef(text)
  textRef.current = text
  const shownRef = useRef(0)
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      if (shownRef.current < textRef.current.length) {
        shownRef.current = Math.min(textRef.current.length, shownRef.current + 2)
        setShown(shownRef.current)
      }
    }, 25)
    return () => clearInterval(timer)
  }, [])
  if (shown >= text.length) {
    return <div className="md-body" dangerouslySetInnerHTML={{ __html: marked.parse(text) }} />
  }
  return (
    <div className="streaming">
      {text.slice(0, shown)}
      <span className="cursor" />
    </div>
  )
}
