import React, { memo, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import markedKatex from 'marked-katex-extension'
import ABOUT_LOGO from './assets/logo.svg'
import { advanceTypewriterBurst, TW_TICK_MS } from './typewriter.mjs'
import { easeInOutCubic, iconSize, MORPH_MS, rotateDeg, shapePoints, SIZE_SEND } from './sendButtonMorph.mjs'
import {
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Clock3,
  Coffee,
  Copy,
  Database,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileLock2,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideo,
  Flag,
  Flame,
  Folder,
  FolderOpen,
  Globe,
  History,
  Info,
  Keyboard,
  Lightbulb,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Minus,
  Moon,
  MoreHorizontal,
  Palette,
  Pencil,
  Pin,
  Play,
  Plus,
  Puzzle,
  Rocket,
  RotateCcw,
  RotateCwClock,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Sunrise,
  Terminal,
  Timer,
  Trash2,
  TrendingUp,
  Wrench,
  X,
  XCircle,
  Zap
} from 'lucide-react'
import { __iconData as copyIconData } from 'lucide-react/dist/esm/icons/copy.mjs'
import { sampleTotal, unwrapEmerge, wrapEmerge } from './emergeDom.mjs'
import {
  mergeToolState,
  resolveToolName,
  stampToolTime,
  normalizePart,
  unwrapSubagentOutput,
  judgePhase,
  conclusionText,
  identityLevel,
  childSessionId,
  phaseLabel,
  canTerminate,
  statusClassOf,
  livePatchFromSubagentPart,
  safeAgentColor,
  pollDecision,
  busyHintText,
  PHASE
} from './subagentModel.mjs'
import {
  createSubagentStore,
  createSubagentStream,
  reduceChildEvent,
  SUBAGENT_LIVE_THROTTLE_MS
} from './subagentLiveStore.mjs'
import {
  buildChildIndex,
  childSessionIds,
  childBadgeCount,
  visiblePinnedOrder,
  moveWithinVisible,
  mergePinnedOrder,
  childSessionLabel,
  shortSid
} from './sessionList.mjs'
import {
  RANGE_OPTIONS,
  fmtInt,
  fmtTokenCompact,
  fmtPct,
  fmtDuration,
  fmtDateMD,
  tokenTotal,
  tokenSegments,
  cacheHitRate,
  currentStreak,
  buildHeatmap,
  percentShares,
  topTools,
  pickPersona,
  bookEquiv,
  fmtCharsWan,
  nextHalfHourAt
} from './stats.mjs'
// ===== 渲染层跨组件上下文 =====
// ⚠ 必须放在下方「marked 配置块」【之前】：验收脚本（Part B）会把该配置块整段塞进 Function 求值，
// 那段里不能出现 createContext 之类的外部引用。
// 揭示档位：'emerge'（浮现，默认）/ 'typewriter'（打字机）。经 context 下发以穿透 MessageView 的 memo，
// 切换即时生效、无需重启（设计 §5.6 / D9）。
const RevealModeContext = createContext('emerge')

// 贴底跟随的「内容长高」通知：揭示动画每帧只改组件本地 shown，消息数组不变 ⇒ App 的滚动 effect 不触发，
// 视口会自己往上漂（"输出快结束时就不贴底"）。揭示层在 layout effect 里调它，滚动跟**真实高度**走。
const ScrollFollowContext = createContext(null)
const ScrollFollowControlContext = createContext(null)

// 揭示进度按「会话/消息」持久化：主会话 ↔ 子会话、Work ↔ 其它页面切换时
// TextBlock 会卸载重挂，不能只依赖组件内 useRef，否则会从 0 重播。
const revealProgressByMessage = new Map()

// 聊天内容列宽度（消息列表 + 输入框共用）
const CHAT_COL_DEFAULT = 840
const CHAT_COL_MIN = 720
const CHAT_COL_MAX = 1200
const CHAT_COL_GUTTER = 32

marked.setOptions({ gfm: true, breaks: true })

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Lucide 图标数据 → 字符串 SVG，供 marked 生成的 HTML（代码块复制按钮）使用
function lucideSvg(data, size = 12, strokeWidth = 1.8) {
  const nodes = (data?.node || [])
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs || {})
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${escapeHtml(String(v))}"`)
        .join(' ')
      return `<${tag} ${a} />`
    })
    .join('')
  return `<svg class="lucide lucide-copy" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${nodes}</svg>`
}

// LaTeX 公式渲染（$..$ 行内 / $$..$$ 块级）；代码块 highlight.js 语法高亮，未识别语言降级纯文本
marked.use(markedKatex({ throwOnError: false }))
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0]
      if (language === 'mermaid') {
        // Mermaid 图表：先输出占位容器（源码以 <pre> 展示，样式同普通代码块），
        // SVG 由全局后处理异步渲染（见下方 mermaid 设施与 App 内的 MutationObserver）
        return `<div class="md-mermaid"><pre><code class="hljs language-plaintext">${escapeHtml(text)}</code></pre></div>`
      }
      const name = language && hljs.getLanguage(language) ? language : 'plaintext'
      const copyBtn = `<button type="button" class="code-copy" title="复制代码" aria-label="复制代码">${lucideSvg(copyIconData, 12, 1.8)}<span class="code-copy-label">复制</span></button>`
      return `<div class="code-block">${copyBtn}<pre><code class="hljs language-${name}">${hljs.highlight(text, { language: name }).value}</code></pre></div>`
    }
  }
})

// 上标 X^2^ / 下标 H~2~O（Pandoc 风格，GFM 原生不支持）；单波浪线优先注册为下标，
// 不再落入内置删除线规则（GFM 单 ~ 也算删除线导致 H~2~O 误显示删除线），删除线仍用 ~~..~~
marked.use({
  extensions: [
    {
      name: 'superscript',
      level: 'inline',
      start(src) { return src.indexOf('^') },
      tokenizer(src) {
        const m = /^\^([^\s^]+)\^/.exec(src)
        if (m) return { type: 'superscript', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }
      },
      renderer(token) { return '<sup>' + this.parser.parseInline(token.tokens) + '</sup>' }
    },
    {
      name: 'subscript',
      level: 'inline',
      start(src) { return src.indexOf('~') },
      tokenizer(src) {
        const m = /^~([^\s~]+)~/.exec(src)
        if (m) return { type: 'subscript', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }
      },
      renderer(token) { return '<sub>' + this.parser.parseInline(token.tokens) + '</sub>' }
    },
    {
      // 高亮 ==文本==（Markdown It / Typora 风格，渲染为 <mark>）；内容不能以空白或 = 开头结尾，
      // 避免 x == y == z 这类普通文本误判，=== 也不会误匹配
      name: 'mark',
      level: 'inline',
      start(src) { return src.indexOf('==') },
      tokenizer(src) {
        const m = /^==([^\s=](?:[^=\n]*[^\s=])?)==/.exec(src)
        if (m) return { type: 'mark', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }
      },
      renderer(token) { return '<mark>' + this.parser.parseInline(token.tokens) + '</mark>' }
    }
  ]
})

// 定义列表（PHP Markdown Extra 风格：术语行 + 行首冒号定义行，GFM 原生不支持）。
// 术语行不能是标题/列表/引用/围栏/HTML/缩进代码等其他块级语法，避免劫持内置规则
marked.use({
  extensions: [
    {
      name: 'definitionList',
      level: 'block',
      start(src) {
        const m = /^ {0,3}:[ \t]/m.exec(src)
        if (!m) return
        const nl = src.lastIndexOf('\n', m.index)
        if (nl === -1) return
        const prev = src.lastIndexOf('\n', nl - 1)
        return prev === -1 ? 0 : prev + 1
      },
      tokenizer(src) {
        if (!/^ {0,3}:[ \t]/m.test(src)) return
        const lines = src.split('\n')
        const groups = []
        let i = 0
        while (i < lines.length) {
          const term = lines[i]
          if (!term.trim() || /^ {0,3}:/.test(term) ||
              /^(?: {0,3}(?:#{1,6}[ \t]|>|```|~~~|[-*+][ \t]|\d{1,9}[.)][ \t]|<[A-Za-z])|\t| {4}\S)/.test(term)) break
          if (i + 1 >= lines.length || !/^ {0,3}:[ \t]/.test(lines[i + 1])) break
          const defs = []
          i++
          while (i < lines.length && /^ {0,3}:[ \t]/.test(lines[i])) {
            defs.push(lines[i].replace(/^ {0,3}:[ \t]/, ''))
            i++
          }
          groups.push({ term, defs })
        }
        if (!groups.length) return
        return {
          type: 'definitionList',
          raw: lines.slice(0, i).join('\n') + (i < lines.length ? '\n' : ''),
          groups: groups.map(g => ({
            term: this.lexer.inlineTokens(g.term),
            defs: g.defs.map(d => this.lexer.inlineTokens(d))
          }))
        }
      },
      renderer(token) {
        let html = '<dl>'
        for (const g of token.groups) {
          html += '<dt>' + this.parser.parseInline(g.term) + '</dt>'
          for (const d of g.defs) html += '<dd>' + this.parser.parseInline(d) + '</dd>'
        }
        return html + '</dl>\n'
      }
    }
  ]
})

// ===== Mermaid 图表（```mermaid 代码块 → SVG 图）=====
// code renderer 只输出占位容器（源码先以 <pre> 展示），SVG 渲染由全局后处理完成：
// 首次使用时才动态 import mermaid 包（体积大，避免拖慢启动）；渲染结果按 主题+源码 缓存；
// 流式打字中（.md-body.streaming）跳过，打字结束后 class 变化自动触发补渲染；
// 语法错误降级为错误提示 + 保留源码，不影响其余内容。
const MERMAID_THEME_EVENT = 'xwork-mermaid-theme'
let mermaidLibPromise = null
const mermaidSvgCache = new Map() // `主题\u0000源码` → svg 字符串
let mermaidSeq = 0

function currentMermaidTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'default' : 'dark'
}

function loadMermaid() {
  if (!mermaidLibPromise) mermaidLibPromise = import('mermaid').then((m) => m.default)
  return mermaidLibPromise
}

// 渲染单个占位容器：data-state 防重入；data-src 记录源码供主题切换时重渲染
async function renderMermaidNode(node) {
  if (!node.dataset.src) node.dataset.src = node.textContent
  const code = node.dataset.src
  const key = currentMermaidTheme() + '\u0000' + code
  try {
    let svg = mermaidSvgCache.get(key)
    if (svg === undefined) {
      const mermaid = await loadMermaid()
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: currentMermaidTheme() })
      await mermaid.parse(code) // 语法预检：错误直接抛出、不注入 DOM
      svg = (await mermaid.render('mmd-' + mermaidSeq++, code)).svg
      mermaidSvgCache.set(key, svg)
    }
    node.innerHTML = svg
    node.classList.add('md-mermaid-ok')
    node.dataset.state = 'done'
  } catch (err) {
    node.classList.add('md-mermaid-err')
    const msg = document.createElement('div')
    msg.className = 'md-mermaid-err-msg'
    msg.textContent = 'Mermaid 图表渲染失败：' + String((err && err.message) || err).slice(0, 200)
    node.prepend(msg)
    node.dataset.state = 'error'
  }
}

// 扫描占位容器并渲染；流式打字中的跳过（打字结束后 class 变化会再次触发扫描）
function scanMermaid(root) {
  const nodes = root.querySelectorAll('.md-mermaid:not([data-state])')
  for (const node of nodes) {
    if (node.closest('.md-body.streaming')) continue
    node.dataset.state = 'pending'
    renderMermaidNode(node)
  }
}

// 主题切换：让已渲染/渲染中的图表按新主题重画（缓存按主题键控，旧图原样保留直到新图就绪）
function rerenderMermaidTheme() {
  document.querySelectorAll('.md-mermaid[data-src]').forEach((node) => {
    delete node.dataset.state
    node.classList.remove('md-mermaid-ok', 'md-mermaid-err')
    const msg = node.querySelector('.md-mermaid-err-msg')
    if (msg) msg.remove()
    node.dataset.state = 'pending'
    renderMermaidNode(node)
  })
}

// 空会话问候语：按时间段分组，随机取一条（localStorage 记录上次索引避免连续重复）
const GREETINGS = [
  { from: 5, to: 11, items: [
    { Icon: Sunrise, title: '早安，开始今天的工作吧', sub: '把要做的事交给 AI，或先从一个新对话开始' },
    { Icon: Rocket, title: '新的一天，新的想法', sub: '想好要解决什么问题了吗？' }
  ]},
  { from: 12, to: 18, items: [
    { Icon: Coffee, title: '下午好，趁现在把想法落地', sub: '有什么需要帮忙处理的？' },
    { Icon: Pin, title: '下午好，继续推进', sub: '打开工作区，或直接聊聊你的计划' }
  ]},
  { from: 19, to: 23, items: [
    { Icon: Moon, title: '晚上好，专注时刻', sub: '把白天的想法整理成行动' },
    { Icon: Lightbulb, title: '晚间灵感最活跃', sub: '想聊点什么？AI 随时待命' }
  ]},
  { from: 0, to: 4, items: [
    { Icon: Clock3, title: '还在奋斗，注意休息', sub: '保持节奏，随时可以开始' },
    { Icon: Sparkles, title: '深夜效率高，也别太晚', sub: '简短任务也可以先丢过来' }
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
// 注：V2 已取消「目录列举」（list）动作，此处不再展示该项
const PERMISSION_ITEMS = [
  { key: 'read', label: '读取文件', desc: '读取工作区内文件内容' },
  { key: 'edit', label: '修改文件', desc: '编辑 / 新建 / 覆写文件（edit/write/patch）' },
  { key: 'bash', label: '执行命令', desc: '在终端执行命令（含删除、移动等，PowerShell）' },
  { key: 'glob', label: '文件查找', desc: '按模式查找文件（glob）' },
  { key: 'grep', label: '内容搜索', desc: '在文件中搜索文本（grep）' },
  { key: 'webfetch', label: '网页抓取', desc: '抓取指定网页内容' },
  { key: 'websearch', label: '联网搜索', desc: '搜索互联网获取信息' },
  // ⚠ key 必须保持 'task'：它是引擎的权限键（permission.task），只有展示文案改「子智能体」
  { key: 'task', label: '子智能体', desc: 'AI 启动子智能体并行处理' },
  { key: 'external_directory', label: '工作区外访问', desc: '访问当前工作区之外的路径' },
  { key: 'question', label: '向用户提问', desc: 'AI 主动向你提问，等待你的回答' }
]

// 预设档位：严格（全确认） / 标准（只读放行，改动确认） / 宽松（全部放行）
const PERMISSION_PRESETS = {
  严格: { read: 'ask', edit: 'ask', bash: 'ask', glob: 'ask', grep: 'ask', webfetch: 'ask', websearch: 'ask', task: 'ask', external_directory: 'ask', question: 'ask' },
  标准: { read: 'allow', edit: 'ask', bash: 'ask', glob: 'allow', grep: 'allow', webfetch: 'allow', websearch: 'allow', task: 'allow', external_directory: 'ask', question: 'ask' },
  宽松: { read: 'allow', edit: 'allow', bash: 'allow', glob: 'allow', grep: 'allow', webfetch: 'allow', websearch: 'allow', task: 'allow', external_directory: 'allow', question: 'allow' }
}

// 设置页不展示的内部类型：低风险固定放行（与主进程 settings.js 的 INTERNAL_ALLOW_PERMS 保持一致，需同步修改）
const INTERNAL_ALLOW_PERMS = ['skill']

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

// .agents 桥接警告的去重窗口：同一「原因 + 工作区」在窗口内只提示一次。
// 引擎每次启动/重启都会重新校验桥接，不去重会让同一条阻断提示反复弹出。
const BRIDGE_WARN_DEDUPE_MS = 10 * 60 * 1000

// 各轮询/提示时长默认值，可被 app/app.config.json 的 timings 覆盖
const DEFAULT_TIMINGS = {
  workspacePollMs: 2000,
  enginePollMs: 4000,
  toastMs: 4000,
  wsSwitchShowMs: 1200,
  wsSwitchFadeMs: 220,
  // 子智能体（设计 §5.7）：这里的值是渲染层兜底；打包版真正的默认值在 config.js 的 DEFAULTS.timings
  subagentLiveMs: 200,
  subagentPollMs: 1500,
  subagentStaleMs: 8000,
  subagentOutcomeGraceMs: 5000,
  subagentUnknownAfterMs: 15000,
  subagentPollFailMaxCount: 3
}

// 文件图标：按扩展名映射到 Lucide 图标（资源管理器风格，按文件类型显示）
const FILE_ICONS = {
  js: FileCode2, mjs: FileCode2, cjs: FileCode2, ts: FileCode2, jsx: FileCode2, tsx: FileCode2,
  py: FileCode2, java: FileCode2, go: FileCode2, rs: FileCode2, rb: FileCode2, php: FileCode2,
  c: FileCog, h: FileCog, cpp: FileCog, cc: FileCog, cs: FileCog,
  sh: FileTerminal, ps1: FileTerminal, bat: FileTerminal, cmd: FileTerminal,
  html: Globe, htm: Globe, css: Palette, scss: Palette, less: Palette, vue: Palette, svelte: Palette,
  json: FileJson, yaml: FileJson, yml: FileJson, toml: FileJson, xml: FileJson, ini: FileJson, conf: FileJson, config: FileJson,
  md: FileText, markdown: FileText, txt: FileText, log: FileText,
  doc: FileText, docx: FileText, rtf: FileText, pdf: FileText,
  xls: FileSpreadsheet, xlsx: FileSpreadsheet, csv: FileSpreadsheet,
  ppt: FileText, pptx: FileText,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, svg: FileImage, webp: FileImage, ico: FileImage, bmp: FileImage,
  mp3: FileAudio, wav: FileAudio, flac: FileAudio, ogg: FileAudio,
  mp4: FileVideo, avi: FileVideo, mov: FileVideo, webm: FileVideo, mkv: FileVideo,
  zip: FileArchive, rar: FileArchive, '7z': FileArchive, tar: FileArchive, gz: FileArchive,
  exe: FileCog, msi: FileCog, dll: FileCog, lock: FileLock2, db: Database, sql: Database
}
function fileIcon(name) {
  const dot = name.lastIndexOf('.')
  const Icon = dot > 0 ? FILE_ICONS[name.slice(dot + 1).toLowerCase()] || File : File
  return <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
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
  return (list || []).map((m) => {
    const out = {
      id: m.info.id,
      role: m.info.role,
      time: m.info.time?.created,
      aborted: !!(m.info.error && /abort/i.test(m.info.error.name || '')),
      error: extractError(m.info),
      // 字段白名单统一收敛到 subagentModel.normalizePart（评审 v2-B-3 + v3-S-7）：
      // 此前 normalize()/settleApply() 各有一份白名单，任何新增字段（如 subagentNotice）
      // 漏掉一处就会"只在 SSE 路径存在、GET 路径全丢"，并被 streamCacheRef 缓存整个会话
      parts: (m.parts || []).map(normalizePart)
    }
    // 子智能体通知条（bridge 由 synthetic 映射而来）的 info 级字段必须显式透传
    if (m.info.subagentNotice) out.subagentNotice = m.info.subagentNotice
    return out
  })
}

// 切走 Work 时 Work 整页会卸载，TextBlock 的本地揭示进度随之丢失。
// 用当前已累积的正文长度写入 revealTo，重新挂载时直接从这里继续，避免整段重播。
function markStreamedTextRevealed(ms) {
  if (!Array.isArray(ms)) return ms
  let changed = false
  const next = ms.map((m) => {
    if (!m.streaming && !m.streamed) return m
    const md = (m.parts || [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join('\n')
    if (!md || (m.revealTo ?? 0) >= md.length) return m
    changed = true
    return { ...m, revealTo: md.length }
  })
  return changed ? next : ms
}

function childMessageText(m) {
  return (m.parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('\n')
}

// 子会话 GET 快照与实时镜像合并：保留镜像中已累积的更长正文，
// 同时补入 GET 才有的用户提示/更早消息，避免点进子会话时从中间开始。
function mergeChildSnapshot(live, snapshot) {
  const liveById = new Map((live || []).map((m) => [m.id, m]))
  const used = new Set()
  const merged = []
  for (const m of snapshot || []) {
    const current = liveById.get(m.id)
    if (!current) {
      merged.push(m)
    } else {
      // 用户提示以快照为准；assistant 正文取更长的一份，兼容流式 GET 半截快照。
      merged.push(
        m.role === 'user' || childMessageText(current).length >= childMessageText(m).length ? current : m
      )
    }
    used.add(m.id)
  }
  for (const m of live || []) if (!used.has(m.id)) merged.push(m)
  return merged
}

// ---- 流式增量纯函数（事件处理与会话级流式缓存共用，不依赖组件状态） ----

// 文本增量追加（message.part.delta）：优先按 partID 归属 reasoning，其次 text
function applyDelta(ms, p) {
  const mid = p.messageID
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
}

// 消息部分完整更新（message.part.updated）：text/reasoning 完整替换、tool 状态更新
function applyPartUpdated(ms, part, mid) {
  if (part.type === 'text') {
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
  }
  if (part.type === 'reasoning') {
    const i = ms.findIndex((m) => m.id === mid)
    if (i < 0) {
      return [
        ...ms,
        {
          id: mid,
          role: 'assistant',
          streaming: true,
          streamed: true,
          parts: [{ id: part.id, type: 'reasoning', text: part.text || '', streaming: part.streaming === true }]
        }
      ]
    }
    const clone = ms.slice()
    const m = clone[i]
    const parts = m.parts.slice()
    // 同一消息可能有多段 reasoning（r0/r1…）：必须按 id 定位，不能总更新第一个。
    const ri = parts.findIndex((x) => x.type === 'reasoning' && x.id === part.id)
    if (ri >= 0) {
      parts[ri] = {
        ...parts[ri],
        id: part.id,
        text: part.text,
        // 事件未带状态时保留旧值，避免普通 part 更新提前关闭当前思考段。
        streaming: part.streaming !== undefined ? part.streaming === true : parts[ri].streaming
      }
    } else {
      parts.unshift({ id: part.id, type: 'reasoning', text: part.text || '', streaming: part.streaming === true })
    }
    clone[i] = { ...m, parts, streaming: true, streamed: true }
    return clone
  }
  if (part.type === 'tool') {
    // 时间戳语义（v2.4 定稿）：_tEnd = 「最后一次状态更新时刻」——注意【不是】"最后一次产生输出的时刻"：
    // progress 带 metadata 因而也会刷新它。详见 subagentModel.stampToolTime 的注释。
    const _tEnd = Date.now()
    const timed = (st) => stampToolTime(st, _tEnd)
    const i = ms.findIndex((m) => m.id === mid)
    if (i < 0) {
      // 消息尚未出现（无文本增量）→ 创建占位追加到末尾，保证实时状态可渲染
      return [...ms, { id: mid, role: 'assistant', streamed: true, parts: [{ id: part.id, callID: part.callID, type: 'tool', tool: part.tool, state: timed(part.state) }] }]
    }
    const clone = ms.slice()
    const m = clone[i]
    const parts = m.parts.slice()
    const ti = parts.findIndex((x) => x.type === 'tool' && (x.id === part.id || x.callID === part.callID))
    // P10：state 不能整体替换（progress 只带 metadata、success 只带 output+metadata，都会冲掉 called 的 input）。
    // mergeToolState 额外保证：状态单调化（迟到的 progress 不把 completed 打回 running）、
    // metadata 按键合并（不把 metadata.status 写回 running ⇒ 不误判 background）、streaming 的字符串 input 不覆盖对象。
    // tool 名兜底（v2-M-12）：SSE 断流后 bridge 的 _toolNames 缓存缺项会给出 undefined。
    if (ti >= 0) {
      const tool = resolveToolName(parts[ti].tool, part.tool)
      parts[ti] = { ...parts[ti], tool, state: timed(mergeToolState(parts[ti].state, part.state)) }
    } else {
      parts.push({ id: part.id, callID: part.callID, type: 'tool', tool: part.tool, state: timed(part.state) })
    }
    clone[i] = { ...m, parts, streamed: true }
    return clone
  }
  return ms
}

// 同步 POST 最终结果落定（settle）：替换为已落定的消息
function settleApply(ms, result) {
  const aborted = !!(result.info?.error && /abort/i.test(result.info.error.name || ''))
  const final = {
    id: result.info.id,
    role: 'assistant',
    aborted,
    error: extractError(result.info),
    streamed: true,
    settled: true,
    // 与 normalize() 共用同一个字段白名单（v3-S-7）
    parts: (result.parts || []).map(normalizePart)
  }
  const idx = ms.findIndex((m) => m.id === result.info.id)
  const clone = ms.slice()
  // 用户已切离 Work 时，页切离标记的 revealTo 必须跨 settle 保留，
  // 否则最终结果替换消息后会再次从 0 开始揭示。
  const prior = idx >= 0 ? clone[idx] : null
  if (prior && prior.revealTo != null) final.revealTo = prior.revealTo
  if (idx >= 0) clone[idx] = final
  else clone.push(final)
  return clone
}

// ── 子智能体运行时：模块级单例（设计 §5.1 ② / §5.7）──────────────────────────
// 为什么是模块级而不是组件 state（评审 v2-B-4）：SubagentCard 位于 memo 化的 MessageView 内部，
// 摘要一旦经 props 下传，每次节流写入都会让父会话【每一条】消息的 memo 失效并重跑 marked.parse。
// 这里让卡片用 useSyncExternalStore 只订阅自己 childSid 的摘要 ⇒ 其它卡片与消息零重渲染。
const subagentLive = createSubagentStore({ throttleMs: SUBAGENT_LIVE_THROTTLE_MS })
// 展开态的消息镜像总线：注入现有的两个纯函数，保证子会话时间线与主会话同一套整形逻辑（单一真源）
const subagentStream = createSubagentStream({ applyPart: applyPartUpdated, applyDelta })

/** 父会话的 subagent 工具 part → 摘要（身份 / phase / 结论 / 错误文案） */
function digestSubagentPart(part, props) {
  if (!part || part.type !== 'tool' || part.tool !== 'subagent') return
  const st = part.state || {}
  const childSid = childSessionId(st)
  if (!childSid) return // 一级降级：拿不到子会话 id 时不建摘要（卡片仍用 input 显示身份）
  // 子代理工具一开始执行就建立空镜像，确保之后打开子会话时能拿到从第一步开始的增量，
  // 而不是只从点击那一刻开始接收。
  if (!subagentStream.has(childSid)) subagentStream.seed(childSid, [])
  const prev = subagentLive.get(childSid)
  const { patch } = livePatchFromSubagentPart(part, {
    prev,
    generation: subagentLive.getGeneration(),
    timings: subagentLive.timings()
  })
  patch.parentSid = (prev && prev.parentSid) || props.sessionID || ''
  subagentLive.addKnownChild(childSid) // 通知条去重依据（§5.3 第 8 点）
  subagentLive.digest(childSid, patch)
}

/** 子会话自身事件 → 摘要（活动行 / steps / toolCount / 最终文本）；只跟踪已知子会话 */
function digestChildEvent(props, type) {
  const sid = props && props.sessionID
  if (!sid) return
  const prev = subagentLive.get(sid)
  if (!prev) return
  if (!subagentStream.has(sid)) subagentStream.seed(sid, [])
  const { state, patch } = reduceChildEvent(prev._childState, type, props)
  patch._childState = state
  subagentLive.digest(sid, patch)
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

// 执行中会话的已运行时长：ms → mm:ss（超过 1 小时 → h:mm:ss）
function fmtRunElapsed(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
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
  delete: { Icon: XCircle, note: '已删除（本轮新建）' },
  restore: { Icon: RotateCcw, note: '已还原到本轮之前' },
  recover: { Icon: CheckCircle2, note: '已找回（本轮被删/改名，undo 后恢复）' }
}

// 任务执行面板分页：默认展示最近 TOOL_PAGE 条工具步骤（执行中最关心的是底部最新条目），
// 点击「加载更早」每次追加 TOOL_PAGE 条；有界 DOM 保证展开/收起动画每帧重排成本恒定，长任务不卡顿
const TOOL_PAGE = 20

// 发送 / 中止按钮图标：形状在两种状态间逐帧插值（旋转 90° + 变形 + 尺寸 17→19px）。
// 发送 / 停止：保留原先的 SVG 形变动画（其余界面图标使用 Lucide）
// 一个按钮 + 一个 svg：React 换元素会卸载重建 DOM，形变会闪一下且在切换瞬间丢失点击目标。
function SendStopIcon({ active }) {
  const svgRef = useRef(null)
  const polyRef = useRef(null)
  const tRef = useRef(active ? 1 : 0) // 当前形态（0=发送，1=中止），动画期间连续变化
  const rafRef = useRef(0)

  const paint = useCallback((t) => {
    const svg = svgRef.current
    const poly = polyRef.current
    if (!svg || !poly) return
    poly.setAttribute('points', shapePoints(t))
    poly.setAttribute('transform', `rotate(${rotateDeg(t)} 50 50)`)
    const px = iconSize(t).toFixed(2) + 'px'
    svg.style.width = px
    svg.style.height = px
  }, [])

  useEffect(() => {
    const target = active ? 1 : 0
    const from = tRef.current
    if (from === target) return undefined
    // 系统「减少动态效果」：直接切到目标形态，不做旋转/变形动画
    const reduce =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      tRef.current = target
      paint(target)
      return undefined
    }
    const started = performance.now()
    cancelAnimationFrame(rafRef.current)
    const tick = (now) => {
      const p = Math.min(1, (now - started) / MORPH_MS)
      const t = from + (target - from) * easeInOutCubic(p)
      tRef.current = t
      paint(t)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [active, paint])

  const initial = active ? 1 : 0
  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{ width: SIZE_SEND + 'px', height: SIZE_SEND + 'px' }}
    >
      <polygon ref={polyRef} points={shapePoints(initial)} transform={`rotate(${rotateDeg(initial)} 50 50)`} />
    </svg>
  )
}

// 推理强度档位（与主进程 settings.js 的 EFFORT_LEVELS 一致）：default = 不下发 variant
const EFFORT_OPTIONS = [
  { value: 'default', label: 'Default', hint: 'No extra field; use the model default' },
  { value: 'low', label: 'Low', hint: 'reasoning_effort: low' },
  { value: 'medium', label: 'Medium', hint: 'reasoning_effort: medium' },
  { value: 'high', label: 'High', hint: 'reasoning_effort: high' }
]
const EFFORT_VARIANTS = ['low', 'medium', 'high']
// 档位 → Model.Ref.variant：default/关闭/未知值一律 undefined（不写该字段）
const effortVariantOf = (level, enabled) => (enabled && EFFORT_VARIANTS.includes(level) ? level : undefined)
// 会话 model.variant → 档位：default/缺失/未知值 → default
const effortFromSession = (variant, enabled) => (enabled && EFFORT_VARIANTS.includes(variant) ? variant : 'default')

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
  // 子智能会话下钻视图（null = 主会话视图）与标题行下拉框状态
  const [childViewSid, setChildViewSid] = useState(null)
  const [childPopOpen, setChildPopOpen] = useState(false)
  const [childVisible, setChildVisible] = useState(TOOL_PAGE)
  const [childErr, setChildErr] = useState('')
  // 标题栏重命名（双击触发）：与左侧列表的 editingID 分开，避免同一会话在两处同时出现输入框
  const [titleEditing, setTitleEditing] = useState(false)
  const dragIdRef = useRef(null) // 拖拽排序中的会话 id
  const [dropPos, setDropPos] = useState(null) // 拖动时指示线的插入位置（置顶区索引，null = 无指示）
  const pinItemRefs = useRef(new Map()) // 置顶会话项 DOM 引用（id -> node），用于拖动时坐标定位
  const [messages, setMessages] = useState([])
  // ── 子会话下钻视图：**必须在任何使用点之前**声明 ─────────────────────────────
  // 教训（2026-10-19 白屏事故）：滚动效果的依赖数组在渲染期就要读 `viewMessages`，
  // 而它原先声明在 2000 行之后 ⇒ 首帧抛 `Cannot access 'viewMessages' before initialization`
  // （TDZ），React 挂载失败 ⇒ 整窗全白。凡"被 effect 依赖/resize 计算用到"的派生值都必须上移到这里。
  const isChildView = !!childViewSid
  const childSub = useCallback(
    (cb) => (childViewSid ? subagentStream.subscriber(childViewSid)(cb) : () => {}),
    [childViewSid]
  )
  const childSnap = useCallback(() => (childViewSid ? subagentStream.get(childViewSid) : null), [childViewSid])
  const childMirror = useSyncExternalStore(childSub, childSnap, childSnap)
  // 对话区实际渲染的消息：主会话 messages / 子会话镜像
  const viewMessages = isChildView ? childMirror || [] : messages
  const parentSession = currentID ? sessions.find((x) => x.id === currentID) : null
  const parentTitle = (parentSession && parentSession.title) || '新会话'
  // 多会话并发（设计：同一工作区可同时运行多个会话）：执行中状态按会话记（sessionID → 开始时间（ms）），
  // 不再是一个布尔。为什么必须按会话：单个布尔只能表达「当前这个」，切到别的会话时会把仍在跑的会话
  // 误判成空闲（2026-10-21 事故：AI 还在输出却显示发送按钮）。
  const [runningSessions, setRunningSessions] = useState(() => new Map())
  const runningRef = useRef(runningSessions) // 事件回调里读最新集合（闭包防过期）
  runningRef.current = runningSessions
  // 当前会话视角的 busy：保持既有语义，所有调用点（输入区、停止、禁用态）无需改动
  const busy = !!currentID && runningSessions.has(currentID)
  // 运行中会话的计时展示：每秒刷新一次「运行中 · mm:ss」（没有运行中会话时不挂定时器）
  const [nowTs, setNowTs] = useState(Date.now())
  useEffect(() => {
    if (!runningSessions.size) return undefined
    setNowTs(Date.now())
    const t = setInterval(() => setNowTs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [runningSessions.size])
  // 登记 / 注销「某会话正在执行」。startedAt 缺省为调用时刻（用于侧栏计时）
  const markRunning = (sid, startedAt) => {
    if (!sid) return
    setRunningSessions((prev) => {
      if (prev.has(sid)) return prev
      const next = new Map(prev)
      next.set(sid, startedAt || Date.now())
      return next
    })
  }
  const markIdle = (sid) => {
    if (!sid) return
    setRunningSessions((prev) => {
      if (!prev.has(sid)) return prev
      const next = new Map(prev)
      next.delete(sid)
      return next
    })
  }
  const clearRunning = () => setRunningSessions((prev) => (prev.size ? new Map() : prev))
  const [stopping, setStopping] = useState(false)
  const [input, setInput] = useState('')
  const [permQueue, setPermQueue] = useState([]) // 待处理的权限请求队列（引擎可能并发弹出多个 ask，逐个确认）
  const perm = permQueue[0] // 当前展示的请求 = 队首，确认后自动轮到下一个
  const [confirm, setConfirm] = useState(null) // 项目风格确认框 {title, message, danger?, confirmLabel?, onConfirm}
  const [question, setQuestion] = useState(null) // AI 提问 {id, sessionID, questions[]}
  const [qSel, setQSek] = useState([]) // 每题选中的选项 label（string[][]）
  const [qText, setQText] = useState([]) // 每题输入框草稿（string[]）
  const [qOther, setQOther] = useState([]) // 每题「其它（自行输入）」是否激活（boolean[]）
  const [toast, setToast] = useState('') // 操作提示
  // .agents 桥接提示去重：`code + workspace` → 上次提示时间。
  // 为什么需要：桥接在【每次】引擎启动/重启时都会校验，若不去重会反复弹同一条阻断提示
  // （见 功能设计文档/agents目录junction桥接设计.md §5.6 的 10 分钟折叠）
  const bridgeWarnSeenRef = useRef(new Map())
  const [greeting, setGreeting] = useState(pickGreeting) // 空会话问候语（每次新对话重取）
  const [editingID, setEditingID] = useState(null) // 正在重命名的会话
  const [editingTitle, setEditingTitle] = useState('')
  const [page, setPage] = useState('chat') // 主视图：chat（Work）| tasks（定时任务）| hub（Skill Hub）| settings（设置）
  const [settingsResetKey, setSettingsResetKey] = useState(0) // 设置页「取消」时递增：丢弃草稿并重新挂载
  const [settingsVisited, setSettingsVisited] = useState(false) // 首次进入设置后才挂载（保证拿到最新设置快照）
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
  const [theme, setTheme] = useState('light') // 界面主题：dark | light
  // 流式正文揭示档位：emerge = 浮现（默认）| typewriter = 打字机。纯渲染层偏好，切换即时生效（§5.6）
  const [streamReveal, setStreamReveal] = useState('emerge')
  const [modelSel, setModelSel] = useState(null) // 当前会话选择的模型 {providerID, modelID}，null = 未选择（发送前必须有效）
  // 推理强度（会话级）：default | low | medium | high；只在发送时随模型下发
  const [effort, setEffort] = useState('default')
  const effortRef = useRef('default') // 供全局事件回调读取最新档位（effect 闭包不随渲染更新）
  effortRef.current = effort
  // effortSidRef：已按会话回填过档位的 sessionID。session.idle 会重载同一会话，
  // 此时不得用可能过期的 sessions 反向覆盖用户刚选的档位（设计 §4.5）。
  const effortSidRef = useRef(null)
  const effortEnabled = settingsData?.effort?.enabled !== false
  const effortEnabledRef = useRef(true)
  effortEnabledRef.current = effortEnabled
  const [agent, setAgent] = useState('build') // 当前会话的模式（opencode agent：build 默认 / plan 只读规划）
  // 智能体列表（引擎注册表，含工作区 .agents 里的自定义项）——由主进程 agents:list 提供。
  // 曾经的 AgentPicker 写死 build/plan，导致 .agents 里的智能体虽然被引擎加载却无处可选。
  const [agentList, setAgentList] = useState(null) // null = 尚未取到（选择器回退内置两项）
  // 名册 id 集合的 ref：loadSession 定义在这之前，不能把 agentList 加进它的依赖（会打乱既有依赖顺序），
  // 故用 ref 读取最新名册，供"agent 回填放宽"判断（见 loadSession / 设计 §5.5(b)）
  const agentIdsRef = useRef(new Set())
  useEffect(() => {
    agentIdsRef.current = new Set((agentList || []).map((a) => a.id))
  }, [agentList])
  // 智能体列表加载中：只把选择器本身切到"加载中"（转圈 + 禁用），不锁整页。
  // 为什么需要：引擎启动后要等约 2~4 秒注册表才收敛，此前下拉框只显示兜底两项，
  // 用户会以为 .agents 没生效。这里给出明确的进行中反馈，并避免在列表不完整时误选。
  const [agentsLoading, setAgentsLoading] = useState(true)
  const agentsLoadingSince = useRef(0)
  const agentsBootstrap = useRef(true) // 首轮加载负责收掉初始转圈（见 loadAgents）
  const agentsRetryRef = useRef(0) // 冷启动空列表的重试计数（引擎就绪但 agents 为空时重试，最多 10 次）

  // 工作区：当前目录 + 文件树（懒加载）+ 已添加文件（相对路径清单）
  const [workspace, setWorkspace] = useState('')
  const [wsChildren, setWsChildren] = useState({}) // 目录绝对路径 -> [{name,type}]
  const [expandedDirs, setExpandedDirs] = useState({}) // 已展开目录绝对路径 -> true
  const [addedFiles, setAddedFiles] = useState([]) // 已添加文件（相对工作区路径，发送时注入）
  const [ctxMenu, setCtxMenu] = useState(null) // 文件右键菜单 {x, y, abs, rel, type, name}
  const [sideTab, setSideTab] = useState('chat') // 侧栏分段：chat（对话历史）| files（工作区文件）
  const [sidebarW, setSidebarW] = useState(256) // 左边栏宽度（拖动边缘调整）
  const [chatColW, setChatColW] = useState(() => {
    try {
      const raw = localStorage.getItem('xwork-chat-col-width')
      if (raw != null) {
        const n = Number(raw)
        if (Number.isFinite(n)) return Math.min(CHAT_COL_MAX, Math.max(CHAT_COL_MIN, n))
      }
    } catch {}
    return CHAT_COL_DEFAULT
  })
  // 拖拽实时宽度（null = 未拖拽）：拖拽期间只更新 dragW（覆盖在聊天区上），松手提交到 sidebarW
  const [dragW, setDragW] = useState(null)
  const [composerH, setComposerH] = useState(null) // 输入区高度（拖动上缘调整，null = 按内容自适应）
  // 渲染层配置（来自 app/app.config.json，经 config:get IPC 获取）：文件树隐藏列表 + 各时长
  const [hideDirs, setHideDirs] = useState(HIDE_DIRS)
  const [hideFiles, setHideFiles] = useState(HIDE_FILES)
  const [timings, setTimings] = useState(DEFAULT_TIMINGS)
  const [wsSwitching, setWsSwitching] = useState(null) // 工作区切换中（= 目标目录，null = 空闲），驱动切换遮罩

  const listRef = useRef(null)
  const chatAreaRef = useRef(null)
  const listStickRef = useRef(true) // 对话区是否贴底：上滑即 false，滚回底部自动恢复
  const lastScrollTopRef = useRef(0) // 上一次 scrollTop：判定「用户是否真的往上滚」（见 onListScroll）
  // 命令卡片展开/收起期间暂停程序化贴底：高度过渡只改变 scrollHeight，不移动 scrollTop。
  const scrollSuppressUntilRef = useRef(0)
  const scrollResumeTimerRef = useRef(null)
  const [showNewHint, setShowNewHint] = useState(false) // 上滑停止跟随期间有新内容时，显示「↓ 新消息」提示
  const currentRef = useRef(currentID)
  currentRef.current = currentID
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const compactingSidRef = useRef(null) // 正在压缩的会话 id：其 idle/error 事件到达时复位 compacting（压缩中切走也会复位，避免永久卡死）
  // 会话级流式消息缓存 { [sessionID]: 渲染结构消息数组 }：事件流增量始终写入缓存（不因切走丢弃），
  // 切回任务仍在跑的会话时用缓存恢复，避免引擎「流式中 GET 快照文本为空」导致正文截断
  const streamCacheRef = useRef({})
  const workspaceRef = useRef(workspace) // 供事件处理器取最新工作区（闭包防过期）
  workspaceRef.current = workspace
  const expandedRef = useRef(expandedDirs) // 供事件处理器取最新展开目录
  expandedRef.current = expandedDirs
  const wsTimer = useRef(null) // 遮罩「已切换到」提示的收起定时器
  const wsPollBusy = useRef(false) // 文件树轮询防重入（上次未完成时跳过本次）

  // 离开 Work 时对话树会卸载；先把当前已到达的流式正文标记为已揭示。
  // 返回时 TextBlock 从该长度继续，而不是从 0 重播整段输出。
  useEffect(() => {
    if (page === 'chat') return
    const sid = currentRef.current
    if (!sid) return
    const cached = streamCacheRef.current[sid]
    const base = cached || messagesRef.current
    if (!base) return
    // 离页期间消息仍在增长：每次增量都把 revealTo 推到当前正文末尾。
    // 这样返回时不会从离开点开始补打，而是直接从最新位置继续。
    const revealed = markStreamedTextRevealed(base)
    if (revealed === base) return
    streamCacheRef.current[sid] = revealed
    setMessages(revealed)
  }, [page, messages])

  // 用户消息点状目录：只用于 Work 主会话；以 user 消息为跳转锚点
  const [outlineActive, setOutlineActive] = useState(null)
  const [outlineHover, setOutlineHover] = useState(null)
  const scrollAnimRef = useRef(null)

  // 500ms 自定义滚动动画：目标位置每帧实时计算，动态内容不会留旧坐标
  const animateScrollTop = useCallback((el, getTarget, onDone) => {
    if (!el) return
    if (scrollAnimRef.current != null) cancelAnimationFrame(scrollAnimRef.current)
    const from = el.scrollTop
    const start = performance.now()
    const step = (now) => {
      const t = Math.min(1, (now - start) / 500)
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      const target = Math.max(0, Math.min(getTarget(), max))
      el.scrollTop = from + (target - from) * eased
      if (t < 1) {
        scrollAnimRef.current = requestAnimationFrame(step)
      } else {
        scrollAnimRef.current = null
        el.scrollTop = Math.max(0, Math.min(getTarget(), el.scrollHeight - el.clientHeight))
        onDone?.()
      }
    }
    scrollAnimRef.current = requestAnimationFrame(step)
  }, [])
  const updateOutlineActive = useCallback(() => {
    if (isChildView) {
      setOutlineActive(null)
      return
    }
    const list = listRef.current
    if (!list) return
    const rows = [...list.querySelectorAll('[data-user-msg]')]
    if (!rows.length) {
      setOutlineActive(null)
      return
    }
    const threshold = list.getBoundingClientRect().top + 72
    let active = rows[0].dataset.userMsg
    for (const row of rows) {
      if (row.getBoundingClientRect().top <= threshold) active = row.dataset.userMsg
      else break
    }
    setOutlineActive((prev) => (prev === active ? prev : active))
  }, [isChildView])

  const outlineItems = useMemo(() => {
    if (isChildView) return []
    return messages
      .map((m, index) => {
        if (m.role !== 'user') return null
        if ((m.parts || []).some((p) => p.type === 'compaction')) return null
        const full = (m.parts || [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text || '')
          .join('\n')
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
          .trim()
        return { id: m.id, index, full: full || '（附件消息）' }
      })
      .filter(Boolean)
  }, [messages, isChildView])

  const jumpToUser = useCallback((id) => {
    const list = listRef.current
    if (!list) return
    const selector = `[data-user-msg="${CSS.escape(String(id))}"]`
    if (!list.querySelector(selector)) return
    listStickRef.current = false
    setShowNewHint(false)
    setOutlineActive(id)
    setOutlineHover(null)
    animateScrollTop(list, () => {
      const target = list.querySelector(selector)
      if (!target) return list.scrollTop
      return list.scrollTop + target.getBoundingClientRect().top - list.getBoundingClientRect().top - 10
    })
  }, [animateScrollTop])

  const showOutlineTip = (item, event) => {
    const list = listRef.current
    if (!list) return
    const r = event.currentTarget.getBoundingClientRect()
    const lr = list.getBoundingClientRect()
    const rawTop = r.top - lr.top + r.height / 2
    const top = Math.max(48, Math.min(lr.height - 48, rawTop))
    setOutlineHover({ id: item.id, full: item.full, top })
  }

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
    // 切换会话 ⇒ 退出子会话下钻视图（用户拍板：自动退回主会话视图，避免"标题行是 A、内容却是 A 的子会话"）
    setChildViewSid(null)
    setChildPopOpen(false)
    setTitleEditing(false) // 丢弃未保存的标题编辑
    setStopping(false)
    // busy 现在按会话集合推导（runningSessions.has(sid)），切换会话无需复位/恢复。
    // 该会话仍在执行就继续显示「执行中」，已结束就自然显示空闲。
    // 切换会话：重置对话区贴底状态并隐藏「↓ 新消息」气泡（避免上个会话的上滑残留）
    listStickRef.current = true
    setShowNewHint(false)
    // 恢复该会话绑定的模型（opencode 将模型持久化在会话 model 字段）
    const s = sessions.find((x) => x.id === sid)
    if (s?.model?.providerID) setModelSel({ providerID: s.model.providerID, modelID: s.model.id })
    // 推理强度：只在切换到另一个会话时回填；session.idle 重载同一会话不覆盖本地档位
    if (effortSidRef.current !== sid) {
      effortSidRef.current = sid
      setEffort(effortFromSession(s?.model?.variant, effortEnabledRef.current))
    }
    try {
      const msgs = await api.messageList(sid)
      const norm = normalize(msgs)
      if (runningRef.current.has(sid) && streamCacheRef.current[sid]) {
        // 该会话任务仍在后台运行：用流式缓存恢复（含切走期间的增量），
        // 避免引擎「流式中 GET 快照文本为空」导致正文截断；token 统计仍取 GET（info 字段不受流式影响）
        // 恢复时刻已累积的文本视为已揭示（revealTo）：直接显示全文，后续增量从该位置继续打字机
        // 口径必须与 MessageView 的 mdText 完全一致（join('\n')）：多 text part 时若用 join('')，
        // revealTo 会少 (parts-1) 个字符 ⇒ 恢复后会重打尾部几个字（设计 §5.9）
        const restored = markStreamedTextRevealed(streamCacheRef.current[sid])
        streamCacheRef.current[sid] = restored // 同步缓存引用，保证后续增量基于同一份数组
        setMessages(restored)
      } else {
        // 任务已结束（或缓存缺失）：以 GET 全量快照为准，并同步缓存基线
        setMessages(norm)
        streamCacheRef.current[sid] = norm
      }
      setCtxTokens(ctxTokenCount(msgs)) // 刷新上下文 token 统计
      // 恢复该会话绑定的模式：优先会话字段，其次最后一条用户消息（opencode 在消息上记录 agent）
      let ag = s?.agent
      if (!ag) {
        const users = (msgs || []).filter((m) => m.info?.role === 'user')
        ag = users.length ? users[users.length - 1].info?.agent : ''
      }
      // 回读放宽（设计 §5.5(b) / 评审 v2-M-1）：名册里存在就沿用（自定义 agent / mode:'all' 也能正确回显），
      // 否则再按老规则回落 build。名册未加载完（空集）时行为与旧实现完全一致。
      const knownAgents = agentIdsRef.current
      setAgent(ag && knownAgents.has(ag) ? ag : ag === 'plan' ? 'plan' : 'build')
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
        // 注意：本函数只用于「启动时同步工作区」与手动刷新；切换工作区走 switchTo()，
        // 那里会单独调用 loadAgents()（历史 bug：曾以为这里覆盖了切换路径，导致切换后列表不更新）
        loadAgents()
        const list = await api.workspaceListDir(ws)
        if (list && !list.error) setWsChildren((c) => ({ ...c, [ws]: list }))
      }
    } catch (e) {
      console.error('load workspace failed', e)
    }
  }

  // 加载智能体列表：引擎注册表（含工作区 .agents 里的自定义智能体）。
  // 失败/引擎未运行时置空 → AgentPicker 回退到内置的两项，保证输入区永远可用。
  //
  // 加载期间只把【选择器本身】切到"加载中"（转圈 + 禁用），不锁整页：
  // 输入框、发送、对话内容都照常可用，只是暂时不能切换智能体
  // （此时列表可能只有兜底两项，允许点选会让用户以为 .agents 没生效）。
  // 首次加载加最小展示时长，避免引擎已就绪时"闪一下转圈"反而更晃眼。
  const loadAgents = async ({ silent = false } = {}) => {
    if (!api.agentList) {
      setAgentsLoading(false)
      return
    }
    const started = Date.now()
    agentsLoadingSince.current = started
    // 启动引导：agentsLoading 初值为 true（界面一出现就显示"正在加载"），
    // 第一轮加载无论是谁发起的（含 silent），都必须负责把它收掉，否则转圈永不消失。
    const bootstrap = agentsBootstrap.current
    agentsBootstrap.current = false
    // silent：后台静默刷新（例如引擎重启后），不显示转圈，避免打断正在操作的用户
    const showSpinner = !silent || bootstrap
    if (showSpinner) setAgentsLoading(true)
    try {
      const r = await api.agentList()
      setAgentList(r && Array.isArray(r.agents) ? r.agents : [])
    } catch (e) {
      console.warn('load agents failed', e)
      setAgentList([])
    } finally {
      // 只有"这一轮"是最新的一轮时才收尾（并发调用时旧的不要关掉新的转圈）
      if (agentsLoadingSince.current !== started) return
      if (showSpinner) {
        const rest = AGENTS_SPINNER_MIN_MS - (Date.now() - started)
        if (rest > 0) await new Promise((r) => setTimeout(r, rest))
        if (agentsLoadingSince.current === started) setAgentsLoading(false)
      }
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

  // 切换到指定工作区（V2 单进程多目录：不重启引擎，仅切换会话作用域并热加载新目录配置）
  // 「打开文件夹」与「所有工作区」共用
  const switchTo = async (dir) => {
    if (!dir || dir === workspace) return
    try {
      if (wsTimer.current) clearTimeout(wsTimer.current)
      setWsSwitching({ dir, done: false })
      const r = await api.workspaceSwitch(dir)
      if (!r.ok) {
        setWsSwitching(null)
        setToast('切换失败: ' + (r.error || '未知错误'))
        return
      }
      const ws = r.status?.workspace || dir
      setWorkspace(ws)
      setCurrentID(null)
      setChildViewSid(null) // 切工作区 ⇒ 退出子会话视图
      setChildPopOpen(false)
      setTitleEditing(false)
      setMessages([])
      setCtxTokens(null) // 切换工作区后无当前会话，清空 token 统计
      setStopping(false)
      // 引擎不再随工作区重启：其它工作区正在执行的任务会继续跑，
      // 但 runningSessions / 流式缓存**保留**（切回该会话时仍能正确显示执行中状态）
      // 切换工作区同样重置对话区贴底状态与「↓ 新消息」气泡
      listStickRef.current = true
      setShowNewHint(false)
      setAddedFiles([])
      setExpandedDirs({})
      setCtxMenu(null)
      refreshSessions()
      // 智能体列表随工作区变化（.agents/agents、.agents/commands 是工作区级的）：
      // 切换后必须重取。主进程的 agents:list 会带新 location 查询并等待注册表收敛
      // （实测约 3~4 秒），期间选择器显示"正在加载 Agent…"。
      // ⚠ 这里不能用 silent：若不显示加载态，旧工作区的智能体仍留在列表里，
      // 用户可能选中一个在新工作区根本不存在的 agent。
      loadAgents()
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
          // 世代号（设计 §5.7 ② / v3-B-1）：只有【进程真的换了】才把未终态的子智能体卡降级为状态未知；
          // 同进程断流重连时世代号不变 ⇒ 不得误标（否则一次网络抖动就会把正在跑的卡片打回未知）
          if (typeof p.generation === 'number') {
            const prevGen = subagentLive.getGeneration()
            subagentLive.setGeneration(p.generation)
            if (prevGen != null && prevGen !== p.generation) subagentLive.markStale('generation-changed')
          }
          // 引擎就绪后刷新状态（engineStart 返回时引擎可能尚未健康）
          api.engineStatus().then((st) => setEngine(st)).catch(() => {})
          loadWorkspace()
          loadModels() // 引擎重启后刷新模型下拉（新 provider 注册完成）
          // 引擎重启后重新扫描智能体注册表（.agents 变更需重启才生效）。
          // silent：这是后台刷新，不显示转圈——避免用户在改设置/切工作区时被反复打断；
          // 首次启动的转圈由 agentsLoading 初值 true 负责（见 loadWorkspace 里的首次调用）。
          loadAgents({ silent: true })
          break
        case 'session.created':
        case 'session.updated':
          refreshSessions()
          break
        case 'message.part.delta': {
          // 子智能体摘要 + 展开态镜像：必须在下面的 early return 之前（非 text 字段也要计数/记活动）
          digestChildEvent(p, 'message.part.delta')
          subagentStream.publish(p.sessionID, { kind: 'delta', props: p })
          // 流式文本增量（{messageID, partID, field, delta}）
          if (p.field !== 'text') return
          const mid = p.messageID
          if (!mid) return
          // 增量先写入会话级缓存（切走期间不丢弃），当前会话再同步渲染
          const sid = p.sessionID
          const cached = streamCacheRef.current[sid]
          if (cached) {
            streamCacheRef.current[sid] = applyDelta(cached, p)
            if (sid === cur) setMessages(streamCacheRef.current[sid])
          } else if (sid === cur) {
            setMessages((ms) => applyDelta(ms, p))
          }
          break
        }
        case 'message.part.updated': {
          const part = p.part
          // 注意：messageID 在 part 内部（如 part.messageID），顶层可能没有
          const mid = part?.messageID || p.messageID
          if (!mid || !part) break
          // 更新先写入会话级缓存（切走期间不丢弃），当前会话再同步渲染
          const sid = p.sessionID
          const isCur = sid === cur
          const cached = streamCacheRef.current[sid]
          if (cached) {
            streamCacheRef.current[sid] = applyPartUpdated(cached, part, mid)
            if (isCur) setMessages(streamCacheRef.current[sid])
          } else if (isCur) {
            setMessages((ms) => applyPartUpdated(ms, part, mid))
          }
          // 写入/编辑类工具执行完成 → 实时刷新左侧文件树（新文件立即可见；仅当前会话）
          if (isCur && part.state?.status === 'completed') refreshWsTree()
          // 子智能体：父侧 part 决定卡片的 phase/身份/结论；子会话自身事件决定活动行与计数
          digestSubagentPart(part, p)
          digestChildEvent(p, 'message.part.updated')
          subagentStream.publish(sid, { kind: 'part', part, mid })
          break
        }
        case 'message.updated': {
          // 消息完成（含 finish）→ 仅最终完成（stop/error）时拉取权威数据；
          // tool-calls 是中间步骤，由事件流增量更新，避免频繁重置消息列表
          const info = p.info
          if (info && info.finish) {
            const f = JSON.stringify(info.finish)
            if (!/tool-calls/.test(f)) {
              // 最终完成：流式缓存失效（不因是否当前会话过滤），后续以 GET 全量快照为准
              delete streamCacheRef.current[p.sessionID]
              if (p.sessionID === cur) loadSession(cur)
            }
          }
          break
        }
        case 'session.status': {
          // 引擎任务运行状态（全局，不随当前会话过滤）：按会话登记/注销「执行中」。
          // 当前会话的 busy 由 runningSessions 推导，因此切回仍在跑的会话会**立刻**恢复执行中，
          // 不再依赖 loadSession 里的单槽恢复（2026-10-21 事故：一次侧栏点击就把 busy 永久清成空闲）。
          const running = p.sessionID && p.status?.type === 'busy'
          if (running) markRunning(p.sessionID)
          else markIdle(p.sessionID)
          break
        }
        case 'session.idle': {
          // 任务真正结束（多 turn 任务以 idle 为准；POST 只返回首个 step）
          // 清理不因是否当前会话过滤：切走期间任务结束也要使缓存/执行中标记失效。
          delete streamCacheRef.current[p.sessionID]
          markIdle(p.sessionID)
          // 压缩会话完成：先于会话匹配复位 compacting——压缩中切换到其他会话时，
          // 压缩会话的 idle 会因 p.sessionID !== cur 被 break 拦截，若此处不复位会永久卡死
          if (compactingSidRef.current === p.sessionID) {
            compactingSidRef.current = null
            setCompacting(false)
          }
          if (p.sessionID !== cur) break
          setStopping(false)
          loadSession(cur)
          break
        }
        case 'session.error': {
          // 任务失败（如 API Key 无效）：把错误标记到当前会话最后一条 assistant 消息，
          // 避免失败回复渲染成「空气泡」；最终错误以 session.idle 后的权威重载为准
          // 清理不因是否当前会话过滤：切走期间任务失败也要使缓存/执行中标记失效。
          delete streamCacheRef.current[p.sessionID]
          markIdle(p.sessionID)
          // 压缩失败也复位（同 idle：不因会话过滤），避免按钮卡在「压缩中…」
          if (compactingSidRef.current === p.sessionID) {
            compactingSidRef.current = null
            setCompacting(false)
          }
          if (p.sessionID !== cur) break
          // 引擎级「变体不可用」：复位当前会话档位，避免下一条继续 no-route。
          // 不自动重发：prompt 已把用户消息写入会话，自动重发会产生两条相同消息（设计 §4.9）。
          const errName = p.error?.name || ''
          const errMsg = String(p.error?.message || '')
          if ((errName === 'provider.no-route' || /Variant unavailable/i.test(errMsg)) && effortRef.current !== 'default') {
            setEffort('default')
            effortRef.current = 'default'
            setToast('所选推理强度在当前引擎不可用，已切回默认，请重新发送')
          }
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
            api.permissionRespond(p.sessionID, p.id, 'once', 'auto')
              .then((ok) => console.log('[perm.asked] respond result:', ok))
              .catch((e) => console.error('[perm.asked] respond failed:', e.message))
          } else if (action === 'deny') {
            console.log('[perm.asked] global deny, auto-rejecting', p.id)
            api.permissionRespond(p.sessionID, p.id, 'reject', 'auto')
              .then((ok) => console.log('[perm.asked] respond result:', ok))
              .catch((e) => console.error('[perm.asked] respond failed:', e.message))
          } else {
            // 入队（按 id 去重）：引擎可能并发发出多个权限请求，逐个展示确认；
            // 若直接覆盖，未响应的请求会永远卡在引擎侧导致任务阻塞
            setPermQueue((q) => (q.some((x) => x.id === p.id) ? q : [...q, p]))
          }
          break
        }
        case 'question.asked': {
          // AI 主动提问（ask 工具）：展示问题/选项弹窗；回答经 bridge 提交（V2 为 form 应答，
          // 事件已由桥归一化为 question.asked，载荷形状与 V1 一致，此处无需感知引擎差异）
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
          // 引擎进程退出后任何进行中的任务必然中断，立即清空「执行中」集合，避免 UI 卡在执行中。
          clearRunning()
          streamCacheRef.current = {} // 引擎退出：所有会话流式缓存失效
          // 子智能体（设计 §5.7 ①）：把该世代【未终态】的摘要标记为过期 ⇒ phase 计算据此降级为「状态未知」。
          // 注意不能靠"改写消息"实现：随后的 loadSession 快照会把 part 写回 running（v3-B-1 第 2 问）
          subagentLive.markStale('engine-exited')
          subagentStream.reset() // 展开态镜像一并回收（设计 §5.7 ①）
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
        // .agents 桥接：阻断 / 自检未收敛 → 必须让用户看见（设计 §5.6，评审 M-2/M-11）
        // 不弹窗、不设 engineError：桥接问题是"功能未生效"而非"引擎故障"，不能挡住正常使用
        case 'engine.bridge.warning': {
          const key = `${p.code || 'unknown'}::${p.workspace || ''}`
          const last = bridgeWarnSeenRef.current.get(key) || 0
          if (Date.now() - last > BRIDGE_WARN_DEDUPE_MS) {
            bridgeWarnSeenRef.current.set(key, Date.now())
            setToast(p.text || '.agents 未生效')
          }
          break
        }
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

  // ── 子智能体运行时注入（设计 §5.7）────────────────────────────────────────
  // 三条都不进 props：timings 与 sessions 都会变化，进 props 会把 memo 化的 MessageView 拖垮
  useEffect(() => {
    subagentLive.setTimings(timings)
    // 节流值也要可调（store 在模块加载期创建，早于 config:get 返回）
    if (timings && typeof timings.subagentLiveMs === 'number') subagentLive.setThrottleMs(timings.subagentLiveMs)
  }, [timings])
  useEffect(() => {
    // 后台完成纠正（T0-③，2026-10-19 实测）：引擎**不会**把 part 的 metadata.status 从 running 改掉，
    // 唯一的完成事实是父会话里那条 `metadata.source='subagent'` 的 synthetic
    // （bridge 已映射成 role:'system' + subagentNotice → 渲染为通知条）。
    // 这里把它写进摘要的 noticeState，judgePhase 据此把「后台运行中」收口成终态，
    // 否则卡片会永远停在后台态。
    for (const m of messages) {
      const notice = m.subagentNotice || (m.parts || []).map((p) => p.subagentNotice).find(Boolean)
      if (!notice || !notice.childID || !notice.state) continue
      // noticeAt：后台任务的耗时要用**通知到达时间**收尾 —— 引擎在后台化那一刻就把 time.end 定住了
      // （实测显示成 2.2s，实际跑了 ~52s）。时间戳由**桥层**塞进 notice.at：
      // normalize() 把 message.time 存成了数字，渲染层取 m.time.created 是拿不到的（踩过一次）。
      subagentLive.digest(notice.childID, { noticeState: notice.state, noticeAt: notice.at || Date.now() })
    }
  }, [messages])
  useEffect(() => {
    // 通知条去重（设计 §5.3 第 8 点）：本会话里存在 subagent tool part 的子会话 ⇒ 通知条折叠成一行。
    // 用 effect 同步而不是 props —— messages 高频变化，进 props 会让 memo 化的 MessageView 全部失效
    subagentLive.setKnownChildren(
      messages
        .flatMap((m) =>
          (m.parts || [])
            .filter((p) => p.type === 'tool' && p.tool === 'subagent')
            .map((p) => childSessionId(p.state || {}))
        )
        .filter(Boolean)
    )
  }, [messages])
  useEffect(() => {
    // 纠偏用：子会话 Session.Info.outcome（succeeded|failed|interrupted）
    subagentLive.setOutcomeResolver((sid) => {
      const s = sessions.find((x) => x.id === sid)
      return (s && s.outcome) || ''
    })
  }, [sessions])
  useEffect(() => {
    // 名册注入（批次 5）：卡片据此显示模型与头像底色（agent 的 model/color 来自 /api/agent）
    subagentLive.setAgentRoster(agentList)
  }, [agentList])
  useEffect(() => {
    // 心跳：让 finalizing 宽限 / outcome 纠偏 / 超时降级 unknown 这些【时间驱动】的判定有机会生效
    subagentLive.startWatch(3000)
    return () => subagentLive.stopWatch()
  }, [])

  // 下拉框：点外部 / Esc 关闭（用户拍板的交互）
  useEffect(() => {
    if (!childPopOpen) return
    const onDown = (e) => {
      const el = e.target
      if (el && el.closest && el.closest('.chat-head-badge-wrap')) return
      setChildPopOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setChildPopOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [childPopOpen])

  // 子会话下钻视图：首次进入 seed 快照，之后由事件镜像驱动。
  // 运行中离开时保留镜像，继续接收增量；否则重新进入会丢失离开期间的流式内容（半截消息）。
  useEffect(() => {
    if (!childViewSid) return
    let alive = true
    let failCount = 0
    let lastSeen = 0
    setChildErr('')
    setChildVisible(TOOL_PAGE)
    window.xwork
      .messageList(childViewSid)
      .then((rows) => {
        if (!alive) return
        const snapshot = normalize(rows)
        const current = subagentStream.get(childViewSid) || []
        subagentStream.seed(
          childViewSid,
          current.length ? mergeChildSnapshot(current, snapshot) : snapshot
        )
      })
      .catch((e) => {
        if (alive) setChildErr('加载子会话失败：' + ((e && e.message) || String(e)))
      })
    // 兜底轮询：仅断流时启用（与 L1 展开态共用 pollDecision 的判定语义）
    const t = subagentLive.timings() || {}
    const timer = setInterval(async () => {
      const live = subagentLive.get(childViewSid)
      const terminal = !!(
        live && (live.phase === PHASE.completed || live.phase === PHASE.failed || live.phase === PHASE.cancelled)
      )
      const lastAt = subagentStream.lastEventAt(childViewSid)
      if (lastAt !== lastSeen) {
        lastSeen = lastAt
        failCount = 0
      }
      const verdict = pollDecision({
        terminal,
        sinceEventMs: Date.now() - lastAt,
        staleMs: t.subagentStaleMs ?? 8000,
        failCount,
        maxFail: t.subagentPollFailMaxCount ?? 3
      })
      if (verdict !== 'poll') return
      try {
        const rows = await window.xwork.messageList(childViewSid)
        failCount = 0
        if (!alive) return
        const snapshot = normalize(rows)
        const current = subagentStream.get(childViewSid) || []
        subagentStream.seed(
          childViewSid,
          current.length ? mergeChildSnapshot(current, snapshot) : snapshot
        )
      } catch {
        failCount++
      }
    }, t.subagentPollMs ?? 1500)
    return () => {
      alive = false
      clearInterval(timer)
      // 仅终态回收；运行中保留镜像，保证切出期间的增量不丢。
      const live = subagentLive.get(childViewSid)
      const terminal = !!(
        live && (live.phase === PHASE.completed || live.phase === PHASE.failed || live.phase === PHASE.cancelled)
      )
      if (terminal) subagentStream.drop(childViewSid)
    }
  }, [childViewSid])

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

  // 冷启动竞态兜底（2026-10-19 自动化发现）：`agents:list` 在引擎就绪前会返回 `{agents:[], source:'engine-down'}`，
  // 而唯一的重载点是 `server.connected` —— 该事件常常在渲染层注册监听【之前】就发出去了。
  // 结果：选择器永久停留在兜底的 Build/Plan 两项，**子智能体名册与工作区自定义 agent 全部消失**
  // （实测冷启动后 15s 仍然为空）。这里在"引擎在跑 + 列表为空 + 不在加载中"时按 2s 重试，最多 10 次。
  useEffect(() => {
    if (!engine.running) return
    if (agentList && agentList.length) {
      agentsRetryRef.current = 0
      return
    }
    if (agentsLoading) return
    if (agentsRetryRef.current >= 10) return
    const timer = setTimeout(() => {
      agentsRetryRef.current += 1
      loadAgents({ silent: true })
    }, 2000)
    return () => clearTimeout(timer)
  }, [engine.running, agentList, agentsLoading])

  // 自动滚动到底部：仅在贴底时跟随最新内容；用户上滑后停止跟随（保持当前位置可阅读），
  // 上滑中且有新内容（viewMessages/busy 变化）时显示「↓ 新消息」提示；滚回底部自动隐藏并恢复跟随。
  // 依赖用 viewMessages 而不是 messages：子会话下钻视图里渲染的是子会话镜像（含进入时的一次 seed）
  useEffect(() => {
    // 命令卡片高度过渡期间不跟随；否则会把卡片上方内容一起推走。
    if (scrollSuppressUntilRef.current > performance.now()) return
    const el = listRef.current
    if (!el) return
    if (listStickRef.current) {
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
      setShowNewHint(false)
    } else {
      setShowNewHint(true)
    }
  }, [viewMessages, busy])

  // 消息数量/会话变化后刷新目录当前点（布局落定后再查询锚点）
  useEffect(() => {
    const timer = setTimeout(updateOutlineActive, 60)
    return () => clearTimeout(timer)
  }, [currentID, messages.length, isChildView, updateOutlineActive])

  // 对话区滚动：距底 <30px 视为贴底（恢复跟随），否则上滑（停止跟随）；
  // 「↓ 新消息」提示仅在「上滑中 + 有新消息/busy 变化」（下方 effect）时出现
  //
  // 判定用「滚动方向」而不是「单次测量的距底距离」：程序化贴底若因高度还没算准（mermaid 异步渲染、
  // 图片加载）而落不到底，距离会 >30px，旧写法会把 listStickRef 误置 false ⇒ 此后永久不跟随。
  // 内容长高本身不会改变 scrollTop，所以"往上滚"才是用户意图。
  const onListScroll = () => {
    const el = listRef.current
    if (!el) return
    const cur = el.scrollTop
    const prev = lastScrollTopRef.current
    lastScrollTopRef.current = cur
    if (el.scrollHeight - cur - el.clientHeight < 30) {
      listStickRef.current = true
      setShowNewHint(false)
    } else if (cur < prev) {
      listStickRef.current = false
    }
    setOutlineHover((h) => (h ? null : h))
    updateOutlineActive()
  }

  // 「↓ 新消息」：500ms 滑到底部，结束后恢复跟随
  const jumpToLatest = () => {
    const el = listRef.current
    if (!el) return
    listStickRef.current = false
    setShowNewHint(false)
    animateScrollTop(
      el,
      () => el.scrollHeight - el.clientHeight,
      () => {
        listStickRef.current = true
        el.scrollTop = el.scrollHeight
        lastScrollTopRef.current = el.scrollTop
      }
    )
  }

  // 贴底跟随：只在贴底时滚到底；供揭示层（head/尾每帧长高）与 mermaid 补渲染后调用。
  // 回调用 useCallback([]) 保持身份稳定，避免 context 变化让所有消息重渲染。
  const nudgeScroll = useCallback(() => {
    const el = listRef.current
    if (!el || !listStickRef.current) return
    if (scrollSuppressUntilRef.current > performance.now()) return
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
  }, [])

  // 用户主动展开/收起命令卡片：暂停程序化贴底。结束后如果仍在底部才恢复跟随；
  // 展开后通常已不在底部，必须保持 false，否则流式下一帧又会把上方内容顶走。
  const pauseScrollFollow = useCallback((ms = 520) => {
    if (scrollResumeTimerRef.current) clearTimeout(scrollResumeTimerRef.current)
    scrollSuppressUntilRef.current = performance.now() + ms
    scrollResumeTimerRef.current = setTimeout(() => {
      scrollResumeTimerRef.current = null
      scrollSuppressUntilRef.current = 0
      const el = listRef.current
      if (!el) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
      listStickRef.current = atBottom
      if (atBottom) {
        lastScrollTopRef.current = el.scrollTop
        setShowNewHint(false)
      }
    }, ms + 20)
  }, [])

  // 卸载时取消滚动动画/恢复计时器，避免操作已销毁的列表
  useEffect(() => () => {
    if (scrollAnimRef.current != null) cancelAnimationFrame(scrollAnimRef.current)
    if (scrollResumeTimerRef.current) clearTimeout(scrollResumeTimerRef.current)
  }, [])

  // 操作提示自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), timings.toastMs)
    return () => clearTimeout(t)
  }, [toast, timings])

  // 将同步 POST 的最终结果落定到消息列表（settleApply 纯函数）。
  // 先更新会话级缓存；仅在仍是当前会话时 setMessages，避免 POST 返回时已切走却误写入当前列表
  const settle = (result, sid) => {
    const cached = streamCacheRef.current[sid]
    if (cached) {
      streamCacheRef.current[sid] = settleApply(cached, result)
      if (sid === currentRef.current) setMessages(streamCacheRef.current[sid])
    } else if (sid === currentRef.current) {
      setMessages((ms) => settleApply(ms, result))
    }
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
        const finish = last?.info?.finish
        // 只有「finish 标记存在且不是 tool-calls」才算完成；
        // finish 缺失 = 消息仍在流式输出中，绝不判完成（交由 session.idle 权威复位），
        // 否则超长任务中 POST 早于任务结束返回时，会把「还在输出」误判为「已完成」导致 busy 提前消失
        if (last?.info?.id === expectedId && finish && !/tool-calls/.test(JSON.stringify(finish))) {
          markIdle(sid)
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
    // 模型必须显式选择（模型组下拉）；无有效模型时不发送。
    // 注意：先校验再清空，避免「未配置模型」时已输入的文本被清空丢失
    if (!modelValid) {
      setToast('请先在设置中配置模型组并选择模型')
      return
    }
    setInput('')
    let sid = currentID
    // 记录发送前最后一条 assistant 消息时间：POST 失败时据此判断引擎是否已受理本次消息（任务是否在推进）
    const assts = messages.filter((m) => m.role === 'assistant')
    const baselineAsstTime = assts.length ? assts[assts.length - 1].time || 0 : 0
    try {
      if (!sid) {
        // 新会话不再携带权限快照：权限由引擎全局配置（opencode.json permission）统一判断，
        // 修改权限设置并重启引擎后对所有会话生效；历史会话的兜底处理见 permission.asked
        // 不传标题：由 opencode 引擎自动生成（首条消息后异步生成，经 session.updated 事件刷新列表展示）
        const created = await api.sessionCreate('')
        sid = created.id
        setCurrentID(sid)
        refreshSessions()
      }
      setMessages((ms) => {
        const next = [...ms, { id: 'local-' + Date.now(), role: 'user', parts: [{ type: 'text', text: finalText }] }]
        streamCacheRef.current[sid] = next // 流式缓存基线（含本次用户消息），后续增量在此累积
        return next
      })
      // 「本会话正在执行」登记：发送即入集合，idle/error（或引擎未受理）时移除。
      // （另一个来源是 session.status 事件；两者共同保证切走再切回仍能恢复执行中状态）
      markRunning(sid)
      // 同步等待首个 step 完成；期间实时过程（流式文本/工具/权限/后续 turn）由全局事件流推送
      // 推理强度随模型一起下发（default/功能关闭时不写 variant）；登记会话，避免 idle 重载时用旧列表反向覆盖
      effortSidRef.current = sid
      const result = await api.messageSend(
        sid,
        finalText,
        { ...modelSel, variant: effortVariantOf(effort, effortEnabled) },
        agent
      )
      // 智能体切换失败不再静默（设计 §5.5(b) / 评审 v2-B-4）：主进程把失败信号带回，这里给用户 toast
      if (result && result.agentSwitchFailed) {
        setToast(`智能体「${result.agentSwitchFailed.agent}」不可用，已按引擎默认发送`)
      }
      settle(result, sid)
      checkDone(sid, result.info.id)
      // 引擎切变体只发 session.model.selected（bridge 不下发）→ 主动刷新列表，保证切走再切回时档位正确
      refreshSessions()
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
        delete streamCacheRef.current[sid] // 引擎未受理：流式缓存基线作废
        // 引擎未受理 ⇒ 撤销「执行中」标记，否则切回该会话会被误显示为执行中
        markIdle(sid)
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
    const { sessionID, id } = perm
    try {
      await api.permissionRespond(sessionID, id, response, 'user')
    } catch (e) {
      console.error('permission respond failed', e)
    }
    // 按 id 移除而非简单弹出队首：即使响应期间又来了新请求 / 响应失败，
    // 也只清掉本次已处理的这一条，不会误清队列里其他等待确认的请求
    setPermQueue((q) => q.filter((x) => x.id !== id))
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

  // 复制文本（useCallback 稳定引用：MessageView 已 memo，避免每次渲染触发子组件重渲染）
  const copyText = useCallback(async (md) => {
    try {
      await navigator.clipboard.writeText(md)
      setToast('已复制到剪贴板')
    } catch (e) {
      setToast('复制失败: ' + e.message)
    }
  }, [])

  // 代码块复制：marked 生成按钮，事件委托统一处理（对话/任务历史/详情/子智能体都生效）
  useEffect(() => {
    const onClick = async (event) => {
      const btn = event.target?.closest?.('.code-copy')
      if (!btn) return
      const code = btn.closest('.code-block')?.querySelector('pre code')
      if (!code) return
      event.preventDefault()
      event.stopPropagation()
      const label = btn.querySelector('.code-copy-label')
      const oldLabel = label?.textContent || '复制'
      const raw = code.textContent || ''
      clearTimeout(btn._copyTimer)
      try {
        if (window.xwork && typeof window.xwork.copyText === 'function') {
          await window.xwork.copyText(raw)
        } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(raw)
        } else {
          throw new Error('剪贴板不可用')
        }
        btn.classList.remove('failed')
        btn.classList.add('copied')
        if (label) label.textContent = '已复制'
      } catch (e) {
        btn.classList.add('failed')
        if (label) label.textContent = '复制失败'
        setToast('复制代码失败: ' + ((e && e.message) || e))
      }
      btn._copyTimer = setTimeout(() => {
        btn.classList.remove('copied', 'failed')
        if (label) label.textContent = oldLabel
      }, 1400)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // 启动时加载已保存的界面主题（旧 preload 无 getTheme 时保持默认亮色）
  useEffect(() => {
    if (typeof api.getTheme !== 'function') return
    api
      .getTheme()
      .then((t) => {
        if (t) setTheme(t)
      })
      .catch(() => {})
  }, [])

  // 主题应用到根元素（CSS 变量随 data-theme 切换）；通知 Mermaid 图表按新主题重渲染
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.dispatchEvent(new CustomEvent(MERMAID_THEME_EVENT))
  }, [theme])

  // 启动时加载已保存的流式揭示档位（旧 preload 无 getStreamReveal 时保持默认「浮现」）
  useEffect(() => {
    if (typeof api.getStreamReveal !== 'function') return
    api
      .getStreamReveal()
      .then((v) => {
        if (v === 'emerge' || v === 'typewriter') setStreamReveal(v)
      })
      .catch(() => {})
  }, [])

  // Mermaid 图表全局后处理：DOM 中出现 .md-mermaid 占位符即调度渲染
  // （子树 childList 覆盖消息/详情新增，class 变化覆盖流式打字结束的时刻；rAF 合帧节流）
  useEffect(() => {
    let scheduled = false
    // 只有 Mermaid 区域的变化才需要后处理和补贴底；工具卡片展开/收起的普通 DOM 变化直接忽略。
    const touchesMermaid = (m) => {
      const target = m.target?.nodeType === 1 ? m.target : m.target?.parentElement
      if (target?.closest?.('.md-mermaid')) return true
      if (m.type === 'attributes' && target?.classList?.contains('md-body')) return true
      for (const node of m.addedNodes || []) {
        if (node.nodeType !== 1) continue
        if (node.matches?.('.md-mermaid') || node.querySelector?.('.md-mermaid')) return true
      }
      return false
    }
    const schedule = (records) => {
      if (records && !Array.from(records).some(touchesMermaid)) return
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        scanMermaid(document.body)
        nudgeScroll() // 仅 Mermaid 变化后补贴底；贴底跟随期间也会被暂停
      })
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    schedule()
    window.addEventListener(MERMAID_THEME_EVENT, rerenderMermaidTheme)
    return () => {
      observer.disconnect()
      window.removeEventListener(MERMAID_THEME_EVENT, rerenderMermaidTheme)
    }
  }, [])

  // 切换界面主题：即时生效并持久化（不重启引擎）
  const applyTheme = (t) => {
    if (t === theme) return
    setTheme(t)
    if (typeof api.applyTheme === 'function') {
      api.applyTheme(t).catch(() => setToast('主题保存失败'))
    }
  }
  // 切换流式揭示档位（浮现 / 打字机）：即时生效并持久化。
  // 经 context 下发 ⇒ 穿透 MessageView 的 memo，正在流式的消息立刻换档（进度承接，不重打）
  const applyStreamReveal = (v) => {
    if (v === streamReveal) return
    setStreamReveal(v)
    setSettingsData((d) => (d ? { ...d, streamReveal: v } : d))
    if (typeof api.applyStreamReveal === 'function') {
      api.applyStreamReveal(v).catch(() => setToast('流式效果保存失败'))
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

  // 回退确认（useCallback 稳定引用：MessageView 已 memo）。事前不再预估影响清单
  // （bash 等无法精确预测，见 undo功能设计.md §6.2），实际影响由主进程 undo 完成后按快照对比收集（§6.3）
  const openUndoConfirm = useCallback((m) => {
    setUndoDraft({
      messageID: m.id,
      // 回退成功后把该消息原样填回输入框（用户可能需要编辑后重发）
      userText: (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text || '').join('\n')
    })
  }, [])

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

  // 推理强度开关/默认档：即时保存（主进程只写 effort，不重载引擎）
  const applyEffort = (patch) => {
    api
      .saveEffort(patch)
      .then((next) => {
        setSettingsData((d) => (d ? { ...d, effort: next } : d))
        // 空会话（尚未创建/绑定）跟随新默认档；已有会话保持自己的档位
        if (!currentRef.current) {
          effortSidRef.current = null
          setEffort(next.default || 'default')
          effortRef.current = next.default || 'default'
        }
      })
      .catch(() => setToast('推理强度设置保存失败'))
  }

  // 加载设置快照（含模型组）；启动与打开设置时调用
  // quiet=true：启动期引擎可能尚未就绪，失败属预期，静默等 server.connected 重试
  const loadModels = async (quiet = false) => {
    try {
      const data = await api.getSettings()
      setSettingsData(data)
      // 同步权限配置到 ref（自动应答兜底实时读取）
      permCfgRef.current = (data && data.permission) || PERMISSION_PRESETS.严格
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
        compactingSidRef.current = currentID // 记录压缩会话：其 idle/error 事件到达时复位（压缩中切走也会复位）
        try {
          const r = await api.compactSession(currentID, modelSel)
          if (!r.ok) throw new Error(r.error || '压缩失败')
          setToast('压缩中，完成后自动刷新…')
        } catch (e) {
          setToast('压缩失败: ' + e.message)
          compactingSidRef.current = null
          setCompacting(false)
        }
      }
    })
  }

  // 打开设置：切到整页设置并刷新数据（设置页常驻挂载，切走再回来保留未保存草稿）
  const openSettings = async () => {
    setPage('settings')
    await loadModels()
    // 数据就绪后再首次挂载，避免挂载时用启动期的旧快照初始化表单
    setSettingsVisited(true)
    // 加载有效应用配置（默认值 + 用户覆盖层），供「配置」页表单展示
    api.getConfig().then(setAppConfig).catch(() => {})
  }

  // 设置页「取消」：回 Work，并弃掉未保存草稿（递增 key 重新挂载设置面板）
  const closeSettings = () => {
    setPage('chat')
    setSettingsResetKey((k) => k + 1)
  }

  // 保存「配置」页表单：写入用户覆盖层，刷新渲染层即时生效字段；窗口尺寸重启应用后生效
  const saveAppConfig = async (vals) => {
    try {
      const r = await api.saveConfig(vals)
      if (!r.ok) throw new Error(r.error || '保存失败')
      const fresh = await api.getConfig()
      setAppConfig(fresh)
      applyRendererConfig(fresh) // 隐藏列表/时长立即生效（文件树与轮询无需重启）
      setToast('配置已保存（窗口尺寸需重启应用后生效）')
    } catch (e) {
      setToast('保存配置失败: ' + e.message)
    }
  }

  // 打开 SKILL HUB：切到整页并拉取技能列表（主进程经 IPC 请求本地技能服务，无 CORS 限制）
  const openSkillHub = async () => {
    setPage('hub')
    setSkillLoading(true)
    setSkillError('')
    refreshInstalled() // 进入页面时同步已安装状态（解压目录以磁盘实际为准）
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

  // 左侧栏统一入口：Hub / 设置进入时加载数据，Work / 任务直接切页
  const goPage = (next) => {
    if (next === 'hub') return openSkillHub()
    if (next === 'settings') return openSettings()
    setPage(next)
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
        setToast(`「${s.name}」已安装，引擎会在数秒内自动识别（无需重启）`)
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

  // 重启引擎：保留为显式手动操作（V2 下技能会被自动热发现，通常无需重启），经主进程 stop → 强制新进程
  const restartEngine = async () => {
    try {
      const r = await api.engineRestart()
      setToast(r.ok ? '引擎已重启' : '引擎重启失败: ' + (r.error || '未知错误'))
    } catch (e) {
      setToast('引擎重启失败: ' + e.message)
    }
  }

  // 拖拽调整左边栏宽度：拖拽期间只更新 dragW，松手一次性提交到 sidebarW
  const startResize = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const baseW = sidebarW
    let latestW = null
    const onMove = (ev) => {
      latestW = Math.min(480, Math.max(160, baseW + ev.clientX - startX))
      setDragW(latestW)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing', 'resizing-left')
      if (latestW !== null) setSidebarW(latestW)
      setDragW(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('resizing', 'resizing-left')
  }

  const saveChatColW = (w) => {
    try {
      localStorage.setItem('xwork-chat-col-width', String(w))
    } catch {}
  }

  // 双侧抓手：左右同时扩展/收缩，宽度变化 = 鼠标位移 × 2
  const startChatResize = (side, e) => {
    e.preventDefault()
    e.stopPropagation()
    const area = chatAreaRef.current
    if (!area) return
    const max = Math.max(CHAT_COL_MIN, Math.min(CHAT_COL_MAX, area.clientWidth - CHAT_COL_GUTTER))
    const base = Math.min(chatColW, max)
    const startX = e.clientX
    let latest = base
    const onMove = (ev) => {
      const delta = side === 'right' ? ev.clientX - startX : startX - ev.clientX
      const next = Math.round(Math.min(max, Math.max(CHAT_COL_MIN, base + delta * 2)))
      latest = next
      setChatColW(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing')
      saveChatColW(latest)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('resizing')
  }

  const resetChatColW = () => {
    setChatColW(CHAT_COL_DEFAULT)
    saveChatColW(CHAT_COL_DEFAULT)
  }

  // 拖拽调整输入区高度：向上拉变高（消息区自动腾出空间），最小高度读 CSS
  // （必须同时容纳圆角输入框与下方快捷键提示），最大不超过窗口一半
  const startResizeV = (e) => {
    e.preventDefault()
    const startY = e.clientY
    const composerEl = document.querySelector('.composer')
    const startH = composerEl?.offsetHeight ?? 134
    const minH = Math.max(100, parseFloat(getComputedStyle(composerEl).minHeight) || 134)
    const onMove = (ev) => {
      const h = Math.min(window.innerHeight * 0.5, Math.max(minH, startH + (startY - ev.clientY)))
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

  // 保存设置（主进程加密存储 + 写配置；restart=true 时优先热重载生效、失败自动回退重启引擎；note 可覆盖提示文案）
  const saveSettings = async (form, restart = true, note = '') => {
    try {
      const r = await api.saveSettings(form, restart)
      if (r && r.ok === false) {
        setToast(r.error || '保存失败')
        // 保存失败时主进程可能已把联网搜索落为 false；重新拉取设置，
        // 让权限页立即显示“禁止”，而不是保留旧的“允许”档位。
        await loadModels()
        return
      }
      const applied = r && r.applied
      const fallback = note || (restart ? (applied === 'hot' ? '设置已保存，已热更新生效（无需重启）' : '设置已保存，引擎已重启生效') : '设置已保存，重启引擎后生效')
      setToast(fallback)
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
    setChildViewSid(null)
    setChildPopOpen(false)
    setTitleEditing(false)
    setMessages([])
    setCtxTokens(null) // 新会话无上下文，清空上一会话残留的 token 统计
    // 不清空 runningSessions：其它会话可能在后台继续跑（切回时仍要显示执行中）
    setStopping(false)
    // 新建会话：重置对话区贴底状态并隐藏「↓ 新消息」气泡
    listStickRef.current = true
    setShowNewHint(false)
    setGreeting(pickGreeting())
    setAgent('build') // 新对话默认 build 模式
    // 新会话用设置里的默认档；清空会话回填标记，下次切换会话重新按引擎绑定回填
    effortSidRef.current = null
    setEffort(settingsData?.effort?.default || 'default')
    // 默认最常用模型（须仍存在于模型组中有效），无记录或已失效则置空让用户选择
    await applyFrequentModel()
  }

  // 打开程序时（空会话）默认选择最常用模型并回到 build 模式；有会话时由 loadSession 恢复，不覆盖
  // 只在「会话切换 / 模型组变化」时重跑：effort 开关的即时保存不应重置用户已选的模型
  useEffect(() => {
    if (currentID || !settingsData) return
    applyFrequentModel()
    setAgent('build')
    effortSidRef.current = null
    setEffort(settingsData?.effort?.default || 'default')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentID, settingsData?.modelGroups])

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
          // 删除前的子会话快照（设计 §5.4(a)「孤儿处理」/ 评审 v1-M-6）：
          // 引擎是否级联删除子会话是未闭环项（T0-⑥），所以这里主动清理，并把 404 当作"已级联"忽略。
          const children = (childIndex.get(sid) || []).map((x) => x.id)
          await api.sessionDelete(sid)
          for (const cid of children) {
            try {
              await api.sessionDelete(cid)
            } catch {
              /* 引擎可能已级联删除 ⇒ 404 忽略（不打断流程） */
            }
          }
          if (children.length) {
            // 复拉一次会话列表，断言子会话确实消失（让"无孤儿"变成可判定事实，而不是依赖 T0-⑥ 的结论）
            try {
              const list = await api.sessionList()
              const leftover = children.filter((cid) => (list || []).some((x) => x.id === cid))
              if (leftover.length) console.warn('[subagent] 删除父会话后仍有子会话残留:', leftover)
            } catch {
              /* 复拉失败不影响删除结果 */
            }
          }
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

  // 标题栏重命名保存（双击标题进入编辑；Enter/失焦保存，Esc 取消）
  const saveTitleEdit = async () => {
    const sid = currentID
    const t = editingTitle.trim()
    const old = sessions.find((s) => s.id === sid)?.title
    setTitleEditing(false)
    if (!sid || !t || t === old) return
    try {
      await api.sessionRename(sid, t)
      // 乐观更新：标题栏与左侧列表立即可见（refreshSessions 之后以引擎返回为准）
      setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, title: t } : s)))
      refreshSessions()
    } catch (e) {
      setToast('重命名失败: ' + e.message)
    }
  }

  // 会话列表排序：置顶区（按置顶顺序，不动）在前；普通区按「最新回复时间」降序，回复过的排上面。
  // 子会话不进列表（不变量 I2）：列表与置顶区只以「根会话」为集合；
  // 但 sessions state 保持【全量】—— loadSession / 模型回读 / 重命名都依赖它（设计 §5.4(a)）。
  const byUpdatedDesc = (a, b) => (b.time?.updated || b.time?.created || 0) - (a.time?.updated || a.time?.created || 0)
  const childIndex = useMemo(() => buildChildIndex(sessions), [sessions])
  const childIds = useMemo(() => childSessionIds(sessions), [sessions])

  // 当前主会话旗下的子智能体会话清单（标题行徽标 + 下拉框的数据源）
  // 两个来源合并去重（用户拍板：以当前已加载信息为准 + 会话列表 parentID 索引补全）：
  //   ① sessions 的 parentID 索引 —— 历史会话（消息已分页出去）也能列出
  //   ② 当前 messages 里 subagent part 的 metadata.sessionID —— 实时，且带 agent/description 可做标题兜底
  const childSessions = useMemo(() => {
    if (!currentID) return []
    const byId = new Map()
    // ① 会话列表的 parentID 索引（childIndex: Map<parentID, SessionInfo[]>）
    for (const row of childIndex.get(currentID) || []) {
      if (row && row.id) byId.set(row.id, { sid: row.id, agent: '', desc: '' })
    }
    for (const m of messages) {
      for (const p of m.parts || []) {
        if (p.type !== 'tool' || p.tool !== 'subagent') continue
        const st = p.state || {}
        const sid = childSessionId(st)
        if (!sid) continue
        const input = st.input || {}
        const prev = byId.get(sid) || { sid, agent: '', desc: '' }
        // 状态用与卡片同一个判定（running/background/finalizing/completed/failed/cancelled/unknown）
        byId.set(sid, {
          sid,
          agent: input.agent || prev.agent,
          desc: input.description || prev.desc,
          phase: judgePhase({
            partState: st,
            live: subagentLive.get(sid),
            generation: subagentLive.getGeneration(),
            outcome: subagentLive.outcomeOf(sid),
            graceMs: (subagentLive.timings() || {}).subagentOutcomeGraceMs,
            unknownAfterMs: (subagentLive.timings() || {}).subagentUnknownAfterMs
          })
        })
      }
    }
    const out = []
    for (const item of byId.values()) {
      const row = sessions.find((x) => x.id === item.sid) || {}
      out.push({ ...item, title: row.title || '', agent: item.agent || row.agent || '' })
    }
    return out.sort((a, b) => childSessionLabel(a).localeCompare(childSessionLabel(b), 'zh'))
  }, [currentID, childIndex, messages, sessions])

  // 下钻视图的标题（依赖 childSessions，故留在它之后；isChildView/parentTitle/viewMessages
  // 等"渲染期就要用"的派生值已上移到 state 声明处，避免 TDZ）
  const childViewItem = isChildView ? childSessions.find((x) => x.sid === childViewSid) || null : null
  const childViewTitle = childViewItem ? childSessionLabel(childViewItem) : childViewSid ? shortSid(childViewSid) : ''
  // ★ 唯一索引源（评审 v1-B-3）：显示用置顶序 = 原始 pinnedOrder 剔除子会话 id。
  // 渲染与【全部】拖拽索引运算（dragIdx / finalCount / items / dropPos 比较 / onDrop）都必须基于它，
  // 否则"数组顺序 ≠ 视觉顺序"，会出现指示线落错项、拖放后顺序与视觉不符。
  const pinnedVisible = useMemo(() => visiblePinnedOrder(pinnedOrder, childIds), [pinnedOrder, childIds])
  const pinnedList = pinnedVisible.map((id) => sessions.find((s) => s.id === id)).filter(Boolean)
  const normalList = sessions.filter((s) => !childIds.has(s.id) && !pinnedOrder.includes(s.id)).sort(byUpdatedDesc)
  const orderedSessions = [...pinnedList, ...normalList]
  const visibleSessions = workspace
    ? orderedSessions.filter((s) => normDir(s.directory) === normDir(workspace))
    : orderedSessions

  // 拖拽排序语义（与 onScrollDragOver 坐标计算一致）：插入位置基于「剔除拖拽项后的可见置顶列表」
  const dragIdx = dragIdRef.current != null ? pinnedVisible.indexOf(dragIdRef.current) : -1
  const finalCount = pinnedVisible.filter((id, i) => i !== dragIdx && pinItemRefs.current.get(id)).length

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
    const items = pinnedVisible
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
        const vis = visiblePinnedOrder(prev, childIds)
        if (!vis.includes(dragging)) return prev
        // 在【可见置顶序】里插入（dropPos 与它同语义），再映回原数组：
        // 子会话 id 保持原位，且**不改写 localStorage**（只重排可见项，见设计 v3-S-6）
        return mergePinnedOrder(prev, moveWithinVisible(vis, dragging, dropPos), childIds)
      })
    }
    dragIdRef.current = null
    setDropPos(null)
  }
  const onDragEnd = () => {
    dragIdRef.current = null
    setDropPos(null)
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
              <span className="ws-arrow">
                {exp ? <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" /> : <ChevronRight size={12} strokeWidth={1.8} aria-hidden="true" />}
              </span>
              <span className="ws-ic">
                {exp ? <FolderOpen size={13} strokeWidth={1.8} aria-hidden="true" /> : <Folder size={13} strokeWidth={1.8} aria-hidden="true" />}
              </span>
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
            {added ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Plus size={13} strokeWidth={2} aria-hidden="true" />}
          </button>
        </div>
      )
    })
  }

  // 当前正在进行的步骤（用于面板顶部状态）；useMemo 避免每次渲染都倒序遍历全部消息
  const currentStep = useMemo(() => {
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
  }, [messages, busy])

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

  // 会话头副标题：当前模式 + 工作区（真实数据，不照搬预览里的演示文案）
  const agentLabel =
    agent === 'plan'
      ? 'Plan'
      : agent === 'build'
        ? 'Build'
        : (agentList || []).find((a) => a.id === agent)?.label || agent

  // 下拉值 → 模型对象（格式 providerID/modelID）
  const applyModelSel = (key) => {
    if (!key) return setModelSel(null)
    const i = key.lastIndexOf('/')
    setModelSel({ providerID: key.slice(0, i), modelID: key.slice(i + 1) })
  }

  return (
    // 揭示档位经 context 下发：穿透 MessageView 的 memo，切换即时生效（§5.6 / D9）
    <RevealModeContext.Provider value={streamReveal}>
    <ScrollFollowControlContext.Provider value={pauseScrollFollow}>
    <ScrollFollowContext.Provider value={nudgeScroll}>
    <div className="app">
      {/* 最左侧窄导航栏：Work / 定时任务 / Hub / 设置（设置固定在栏底） */}
      <aside className="nav-rail">
        <nav className="nav-rail-items" aria-label="主导航">
          <button
            className={`nav-rail-btn${page === 'chat' ? ' active' : ''}`}
            onClick={() => goPage('chat')}
            title="Work — 对话与工作区"
            aria-current={page === 'chat' ? 'page' : undefined}
          >
            <MessageSquarePlus aria-hidden="true" />
            <span>Work</span>
          </button>
          <button
            className={`nav-rail-btn${page === 'tasks' ? ' active' : ''}`}
            onClick={() => goPage('tasks')}
            title="定时任务"
            aria-current={page === 'tasks' ? 'page' : undefined}
          >
            <RotateCwClock aria-hidden="true" />
            <span>定时任务</span>
          </button>
          <button
            className={`nav-rail-btn${page === 'hub' ? ' active' : ''}`}
            onClick={() => goPage('hub')}
            title="Hub — 技能中心"
            aria-current={page === 'hub' ? 'page' : undefined}
          >
            <Puzzle aria-hidden="true" />
            <span>Hub</span>
          </button>
        </nav>
        <div className="nav-rail-bottom">
          <button
            className={`nav-rail-btn${page === 'settings' ? ' active' : ''}`}
            onClick={() => goPage('settings')}
            title="设置"
            aria-current={page === 'settings' ? 'page' : undefined}
          >
            <Settings aria-hidden="true" />
            <span>设置</span>
          </button>
          <div className="nav-rail-sep" />
          <button
            className="nav-rail-mini"
            onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          >
            {theme === 'dark' ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
          </button>
        </div>
      </aside>

      <div className="app-stage">
        {/* 自绘标题栏：无边框窗口的拖拽区 + 窗口控制按钮 */}
        <header className="topbar titlebar" onDoubleClick={() => api.windowMaximize()}>
          <div className="brand">
            XWork
            {appInfo?.version ? <span className="brand-ver">{appInfo.version}</span> : null}
          </div>
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
          <div className="win-controls">
            <button className="wc-btn" title="最小化" onClick={() => api.windowMinimize()}>
              <Minus size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button className="wc-btn" title="最大化 / 还原" onClick={() => api.windowMaximize()}>
              <Square size={10} strokeWidth={1.6} aria-hidden="true" />
            </button>
            <button className="wc-btn wc-close" title="关闭" onClick={() => api.windowClose()}>
              <X size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="body">
        {page === 'chat' ? (
        <>
        <aside className="sidebar" style={{ width: dragW ?? sidebarW }}>
          <div
            className="resize-handle"
            title="拖动调整宽度"
            onMouseDown={(e) => startResize('left', e)}
          />
          <button className="new-btn" onClick={newChat}>
            <MessageSquarePlus size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>新对话</span>
          </button>
          <div className="side-tabs">
            <button
              className={`side-tab ${sideTab === 'chat' ? 'active' : ''}`}
              onClick={() => setSideTab('chat')}
            >
              <MessagesSquare size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>对话</span>
            </button>
            <button
              className={`side-tab ${sideTab === 'files' ? 'active' : ''}`}
              onClick={() => setSideTab('files')}
            >
              <Folder size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>工作区</span>
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
                  <FolderOpen size={12} strokeWidth={1.8} aria-hidden="true" />
                  <span>{workspace ? workspace.split(/[\\/]/).pop() : '未选择工作区'}</span>
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
                // 该项在「剔除拖拽项后的可见置顶列表」中的位置；dropPos 与之同语义
                //（必须用 pinnedVisible 而不是 pinnedOrder —— 后者可能含子会话 id，索引不同源会错位）
                const origIdx = pinnedVisible.indexOf(s.id)
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
                      onClick={() => {
                        // 点当前会话不再重载：重载会把流式缓存换成 GET 快照。
                        // 长任务下正文可能短暂回退（执行中状态已由 runningSessions 推导，无需重载恢复）。
                        if (s.id === currentID) return
                        loadSession(s.id)
                      }}
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
                      {pinnedOrder.includes(s.id) && (
                        <span className="pin-badge"><Pin size={11} strokeWidth={1.8} aria-hidden="true" /></span>
                      )}
                      {s.title || s.slug || '未命名'}
                    </div>
                  )}
                  <div className="session-meta">
                    {/* 左侧簇：运行中标识 / 回复时间 + 🤖n 徽标（徽标紧贴前缀，不受 space-between 影响）*/}
                    <span className="session-meta-left">
                      {(() => {
                        // 多会话并发：该会话在执行中就显示「● 运行中 · mm:ss」，否则显示最近回复时间。
                        // 同时可能有多个会话处于该状态（同一工作区并行执行），各自独立计时。
                        const startedAt = runningSessions.get(s.id)
                        if (startedAt == null) {
                          return <span title="最新回复时间">{fmtDateTime(s.time?.updated || s.time?.created)}</span>
                        }
                        return (
                          <span className="session-run" title="该会话正在执行（同一工作区可并行多个会话）">
                            <span className="run-dot" />
                            运行中{startedAt ? ' · ' + fmtRunElapsed(nowTs - startedAt) : ''}
                          </span>
                        )
                      })()}
                      {(() => {
                        // 父会话行的子智能体计数徽标（I2：子会话不占列表条目，但可下钻）
                        // v1 决策 D3：不可点击，仅 title 提示；下钻走 L1 卡片的「展开」按钮（tooltip 写全称「展开子智能体过程」）
                        const n = childBadgeCount(childIndex, s.id)
                        return n > 0 ? (
                          <span className="subagent-badge" title={`${n} 个子智能体会话`}>
                            <Bot size={11} strokeWidth={1.8} aria-hidden="true" />{n}
                          </span>
                        ) : null
                      })()}
                    </span>
                    <button
                      className={`more-btn ${menu && menu.sid === s.id ? 'menu-open' : ''}`}
                      title="更多操作"
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = e.currentTarget.getBoundingClientRect()
                        setMenu({ sid: s.id, x: rect.right - 104, y: rect.bottom + 4 })
                      }}
                    >
                      <MoreHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
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
                  <FolderOpen size={12} strokeWidth={1.8} aria-hidden="true" />
                  <span>{workspace ? workspace.split(/[\\/]/).pop() : '未打开工作区'}</span>
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
                  <span>
                    {wsAllOpen ? <FolderOpen size={13} strokeWidth={1.8} aria-hidden="true" /> : <Folder size={13} strokeWidth={1.8} aria-hidden="true" />}
                    所有工作区
                  </span>
                  <span className="caret"><ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" /></span>
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

        {/* padding-left 为左边栏预留空间（提交值 sidebarW，拖拽中不更新 → 拖拽期间聊天区不重排） */}
        <main
          className={`main${isChildView ? ' child-view' : ''}`}
          style={{ paddingLeft: sidebarW, '--chat-col-w': `${chatColW}px` }}
        >
          {/* 会话标题行（固定，不随消息滚动；2026-10-19 用户需求）
              主会话视图：[主会话标题] [🤖n 可点 → 子会话下拉]
              子会话视图：[‹ 主会话标题（点返回）] [🤖子会话标题（仍可点 → 切换）] */}
          {currentID && (
            <div className="chat-head">
              <div className="chat-head-main">
                <div className="chat-head-line">
              {/* 两种状态用同一元素、同一内边距 ⇒ 切到子会话时标题**不会位移**（用户反馈：
                  之前的「‹」箭头 + button 的额外 padding 让整行文字跳了一下，故彻底去掉箭头）。
                  主视图：双击标题重命名；子视图：单击标题返回主会话（hover 高亮 + tooltip 说明）。 */}
              {titleEditing && !isChildView ? (
                <input
                  className="chat-head-input"
                  value={editingTitle}
                  autoFocus
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={saveTitleEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      saveTitleEdit()
                    }
                    if (e.key === 'Escape') {
                      // 取消：清空草稿再退出编辑（input 卸载时可能触发 blur ⇒ saveTitleEdit 读到空值会直接 return，
                      // 否则按 Esc 反而会把草稿保存下去）
                      setEditingTitle('')
                      setTitleEditing(false)
                    }
                  }}
                />
              ) : (
                <button
                  className={`chat-head-title${isChildView ? ' back' : ''}`}
                  title={isChildView ? '返回主会话' : '双击重命名会话'}
                  onClick={
                    isChildView
                      ? () => {
                          setChildViewSid(null)
                          setChildPopOpen(false)
                        }
                      : undefined
                  }
                  onDoubleClick={
                    isChildView
                      ? undefined
                      : () => {
                          setEditingTitle(parentTitle)
                          setTitleEditing(true)
                        }
                  }
                >
                  <span className="chat-head-text">{parentTitle}</span>
                </button>
              )}
              {childSessions.length > 0 && (
                <div className="chat-head-badge-wrap">
                  <button
                    className={`chat-head-badge${isChildView ? ' active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setChildPopOpen((v) => !v)
                    }}
                    title={isChildView ? '切换子智能体会话' : `${childSessions.length} 个子智能体会话`}
                  >
                    <Bot size={13} strokeWidth={1.8} aria-hidden="true" />
                    {isChildView ? childViewTitle : childSessions.length}
                  </button>
                  {childPopOpen && (
                    <div className="chat-head-pop">
                      {childSessions.map((c) => (
                        <div
                          key={c.sid}
                          className={`chat-head-item${c.sid === childViewSid ? ' active' : ''}`}
                          onClick={() => {
                            setChildViewSid(c.sid)
                            setChildPopOpen(false)
                          }}
                          title={childSessionLabel(c)}
                        >
                          <div className="chat-head-item-title">{childSessionLabel(c)}</div>
                          <div className="chat-head-item-meta">
                            <span className={`tool-status ${statusClassOf(c.phase || PHASE.unknown)}`}>
                              {phaseLabel(c.phase || PHASE.unknown)}
                            </span>
                            {c.agent ? <span className="chat-head-item-agent">{c.agent}</span> : null}
                            <span className="chat-head-item-sid">{shortSid(c.sid)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
                </div>
                <div className="chat-head-meta">
                  <span className="chat-head-meta-dot" />
                  <span className="chat-head-meta-mode">{agentLabel}</span>
                  <span className="chat-head-meta-sep">·</span>
                  <span className="chat-head-meta-ws" title={workspace || '未选择工作区'}>
                    {workspace || '未选择工作区'}
                  </span>
                </div>
              </div>
            </div>
          )}
          <div className="list-area" ref={chatAreaRef}>
            <div className="message-list" ref={listRef} onScroll={onListScroll}>
              {!currentID && !busy && (
                <div className="greeting">
                  <div className="greet-title">
                    <greeting.Icon size={20} strokeWidth={1.8} aria-hidden="true" />
                    <span>{greeting.title}</span>
                  </div>
                  <div className="greet-sub">{greeting.sub}</div>
                </div>
              )}
              {/* 子会话视图：只读 + 分批加载更早（20 条/批，用户拍板） */}
              {isChildView && childErr ? <div className="empty-hint">{childErr}</div> : null}
              {isChildView && !childErr && viewMessages.length === 0 ? (
                <div className="empty-hint">正在加载子会话…</div>
              ) : null}
              {isChildView && viewMessages.length > childVisible ? (
                <button className="load-more" onClick={() => setChildVisible((v) => v + TOOL_PAGE)}>
                  加载更早的 {viewMessages.length - childVisible} 条
                </button>
              ) : null}
              {(isChildView ? viewMessages.slice(-childVisible) : viewMessages).map((m, mi, arr) => (
                <MessageView
                  key={m.id}
                  m={m}
                  showName={mi === 0 || arr[mi - 1].role !== 'assistant'}
                  onCopy={copyText}
                  onUndo={openUndoConfirm}
                  canUndo={!isChildView && m.role === 'user' && hasToolChangeAfter(messages, mi)}
                  gitAvailable={gitState.available}
                  busy={busy}
                  readOnly={isChildView}
                  parentSid={isChildView ? childViewSid : currentID}
                />
              ))}
              {!isChildView && busy && (
                <div className="busy-hint">
                  {/* 统一由 busyHintText 生成：中文动作名；子智能体额外显示在等谁、在做什么
                      （旧文案直接拼英文工具名，会出现「正在subagent」这种半截中文） */}
                  {busyHintText(currentStep, stopping)}
                </div>
              )}
            </div>
            {!isChildView && (
              <div className="chat-col-resizers">
                <button
                  type="button"
                  className="chat-col-resizer left"
                  title="拖动调整聊天内容宽度；双击恢复默认"
                  aria-label="拖动调整聊天内容宽度（左侧）"
                  onMouseDown={(e) => startChatResize('left', e)}
                  onDoubleClick={resetChatColW}
                />
                <button
                  type="button"
                  className="chat-col-resizer right"
                  title="拖动调整聊天内容宽度；双击恢复默认"
                  aria-label="拖动调整聊天内容宽度（右侧）"
                  onMouseDown={(e) => startChatResize('right', e)}
                  onDoubleClick={resetChatColW}
                />
              </div>
            )}
            {!isChildView && outlineItems.length > 0 && (
              <nav
                className="chat-outline"
                aria-label="用户消息目录"
                onScroll={() => setOutlineHover((h) => (h ? null : h))}
              >
                {outlineItems.map((item, i) => (
                  <button
                    key={item.id || item.index}
                    type="button"
                    className={'chat-outline-dot' + (outlineActive === item.id ? ' active' : '')}
                    title={item.full}
                    aria-label={`跳转到第 ${i + 1} 条用户消息：${item.full.slice(0, 80)}`}
                    onClick={() => jumpToUser(item.id)}
                    onMouseEnter={(e) => showOutlineTip(item, e)}
                    onMouseLeave={() => setOutlineHover((h) => (h && h.id === item.id ? null : h))}
                    onFocus={(e) => showOutlineTip(item, e)}
                    onBlur={() => setOutlineHover((h) => (h && h.id === item.id ? null : h))}
                  />
                ))}
              </nav>
            )}
            {outlineHover && (
              <div className="chat-outline-tip-float" style={{ top: outlineHover.top }} aria-hidden="true">
                {outlineHover.full}
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
            <div className="composer-main">
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
                placeholder={'继续追问，或描述下一步…\nEnter 发送 · Shift + Enter 换行'}
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
                <div className="composer-left">
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
                </div>
                <div className="composer-right">
                  <AgentPicker value={agent} onPick={setAgent} options={agentList} loading={agentsLoading} />
                  <ModelPicker
                    models={availableModels}
                    value={modelValid ? modelSel : null}
                    onPick={applyModelSel}
                  />
                  {/* 推理强度：会话级，贯穿到下一次 send；设置关闭时整个下拉不渲染，剩余两个下拉右移 */}
                  {effortEnabled && (
                    <EffortPicker
                      value={effort}
                      onPick={(v) => {
                        setEffort(v)
                        effortRef.current = v
                      }}
                      disabled={!modelValid || !engine.running}
                      reason={!engine.running ? '引擎未连接' : !modelValid ? '请先选择模型' : ''}
                    />
                  )}
                  {/* 发送 → 中止：同一个按钮 + 同一个 svg，形状逐帧变形（不换元素，动画不闪）*/}
                  <button
                    className={`send-btn${busy ? ' stop' : ''}`}
                    disabled={busy ? stopping : !input.trim()}
                    onClick={busy ? stop : send}
                    title={busy ? (stopping ? '正在停止…' : '停止任务') : '发送'}
                    aria-label={busy ? '停止任务' : '发送'}
                  >
                    <SendStopIcon active={busy} />
                  </button>
                </div>
              </div>
            </div>
            </div>
          </div>

          {/* 工作区切换遮罩：覆盖引擎重启等待期；完成后中央改为「已切换到」提示，短暂停留后收起 */}
          {wsSwitching && (
            <div className={`ws-switch-mask ${wsSwitching.leaving ? 'leaving' : ''}`}>
              <div className="ws-switch-box">
                {wsSwitching.done ? (
                  <span className="ws-done-icon"><CheckCircle2 size={18} strokeWidth={2} aria-hidden="true" /></span>
                ) : (
                  <span className="ws-spinner" />
                )}
                <span className="ws-switch-text">
                  <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" />
                  <span>
                    {wsSwitching.done
                      ? `已切换到 ${wsSwitching.dir.split(/[\\/]/).pop()}`
                      : `正在切换到 ${wsSwitching.dir.split(/[\\/]/).pop()}…`}
                  </span>
                </span>
              </div>
            </div>
          )}
        </main>
        </>
        ) : page === 'tasks' ? (
          <TasksPage notify={setToast} setConfirm={setConfirm} settingsData={settingsData} workspace={workspace} />
        ) : page === 'hub' ? (
          <section className="skill-hub-page">
            <div className="page-head">
              <div>
                <div className="page-eyebrow">能力扩展</div>
                <h1 className="page-title">Hub</h1>
                <p className="page-sub">安装技能包，扩展 XWork 的执行能力。安装后引擎会自动识别，无需重启应用。</p>
              </div>
              <div className="page-actions">
                <button className="page-btn" onClick={openSkillHub} disabled={skillLoading}>
                  刷新
                </button>
                <button className="page-btn primary" onClick={restartEngine}>
                  重启引擎
                </button>
              </div>
            </div>
            <div className="hub-status-row">
              <span className={`hub-service${skillError ? ' bad' : ''}`}>
                <span className="hub-service-dot" />
                {skillLoading ? '技能加载中…' : skillError ? '技能服务未连接' : '技能服务已连接'}
              </span>
              <span className="hub-installed-count">
                已安装 {skills.filter((s) => skillInstalled[s.slug]).length} / {skills.length}
              </span>
            </div>
            <div className="skill-hub-scroll">
              <div className="skill-hub-inner">
                {skillLoading ? (
                  <div className="skill-hub-state">技能加载中…</div>
                ) : skillError ? (
                  <div className="skill-hub-state">
                    <div className="skill-hub-error">{skillError}</div>
                    <button className="primary" onClick={openSkillHub}>
                      重试
                    </button>
                  </div>
                ) : skills.length === 0 ? (
                  <div className="skill-hub-state">暂无可用技能</div>
                ) : (
                  <div className="skill-list">
                    {[...skills]
                      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
                      .map((s) => (
                        <div className="skill-card" key={s.id} data-skill-id={s.id}>
                          <div className="skill-icon">
                            {s.icon && !/\p{Extended_Pictographic}/u.test(String(s.icon)) ? s.icon : <Puzzle size={26} strokeWidth={1.8} aria-hidden="true" />}
                          </div>
                          <div className="skill-card-main">
                            <div className="skill-card-head">
                              <div className="skill-name-row">
                                <span className="skill-name">{s.name}</span>
                                {skillInstalled[s.slug] ? <span className="skill-installed-badge">已安装</span> : null}
                              </div>
                              <span className="skill-slug">/{s.slug}</span>
                            </div>
                            <div className="skill-desc">{s.description}</div>
                          </div>
                          <div className="skill-card-foot">
                            <span className="skill-meta">{s.file_count ?? 0} 个文件</span>
                            {skillInstalled[s.slug] ? (
                              <button className="skill-install installed" onClick={() => uninstallSkill(s)}>
                                卸载
                              </button>
                            ) : (
                              <button className="skill-install" disabled={skillBusy === s.id} onClick={() => installSkill(s)}>
                                {skillBusy === s.id ? '安装中…' : '安装'}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {/* 设置页首次进入后常驻挂载：从 rail 切走时仅隐藏，保留未保存草稿；点「取消」时用 key 重挂载丢弃草稿 */}
        {settingsVisited && settingsData ? (
          <div className={`view-pane${page === 'settings' ? ' active' : ''}`}>
            <SettingsPanel
              key={settingsResetKey}
              data={settingsData}
              active={page === 'settings'}
              busy={busy}
              theme={theme}
              streamReveal={streamReveal}
              appInfo={appInfo}
              appConfig={appConfig}
              onThemeChange={applyTheme}
              onStreamRevealChange={applyStreamReveal}
              onCloseActionChange={applyCloseAction}
              onNotifyTaskChange={applyNotifyTask}
              onEffortChange={applyEffort}
              onClose={closeSettings}
              onSave={saveSettings}
              onSaveConfig={saveAppConfig}
            />
          </div>
        ) : page === 'settings' ? (
          <div className="page-loading">
            <span>正在加载设置…</span>
            <button className="page-btn" onClick={openSettings}>
              重试
            </button>
          </div>
        ) : null}
      </div>
      </div>

      {/* 文件右键菜单：打开 / 打开所在文件夹 / 复制路径 */}
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div className="ctx-title" title={ctxMenu.abs}>
            {ctxMenu.type === 'dir' ? <Folder size={14} strokeWidth={1.8} aria-hidden="true" /> : fileIcon(ctxMenu.name)} {ctxMenu.name}
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
            ) : perm.patterns && perm.patterns.length > 0 ? (
              <div className="perm-cmd">
                {[...new Set(perm.patterns)].map((s, i) => (
                  <code key={i}>{s}</code>
                ))}
              </div>
            ) : perm.resources && perm.resources.length > 0 ? (
              // V2：引擎在 permission.asked 中给出 resources（如待执行的命令、待写入的路径）
              <div className="perm-cmd">
                {[...new Set(perm.resources)].map((s, i) => (
                  <code key={i}>{s}</code>
                ))}
              </div>
            ) : null}
            <div className="perm-btns">
              <button onClick={() => respondPerm('reject')}>拒绝</button>
              <button onClick={() => respondPerm('once')}>允许一次</button>
              <button
                className="primary"
                onClick={() => respondPerm('always')}
                title={perm.save && perm.save.length ? '将保存规则：' + perm.save.join('、') : undefined}
              >
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
                  const meta = UNDO_IMPACT_META[f.type] || { Icon: FileText, note: '' }
                  return (
                    <div className="undo-impact-item" key={i}>
                      <span className="undo-impact-icon"><meta.Icon size={14} strokeWidth={1.8} aria-hidden="true" /></span>
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

      {toast && <div className="toast">{toast}</div>}
    </div>
    </ScrollFollowContext.Provider>
    </ScrollFollowControlContext.Provider>
    </RevealModeContext.Provider>
  )
}

// 创建向导表单默认值
const EMPTY_TASK_DRAFT = {
  name: '',
  workspace: '',
  prompt: '',
  model: null,
  agent: 'build', // 定时任务固定 build 模式
  cron: '0 9 * * *',
  timeout: 30,
  retries: 2,
  confirmed: false
}

// 定时任务管理页：任务列表卡片 + 创建/编辑向导 + cron 构造器
const TASK_STATUS_TEXT = { completed: '已完成', failed: '执行失败', timeout: '执行超时' }
// 执行耗时格式化：毫秒 → '45s' / '2m 30s'
function fmtTaskDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
}
// 任务卡图标：按名称做轻量视觉分类（仅装饰，不参与业务判断）
function taskIcon(task) {
  const name = String((task && task.name) || '')
  const p = { size: 18, strokeWidth: 1.8, 'aria-hidden': true }
  if (/报告|数据|统计/.test(name)) return <TrendingUp {...p} />
  if (/清理|临时|缓存/.test(name)) return <Sparkles {...p} />
  if (/同步|文档|博客|发布/.test(name)) return <Download {...p} />
  if (/摘要|变更|日志/.test(name)) return <History {...p} />
  return <Clock {...p} />
}
// 任务时间短格式：今天/明天/昨天 HH:mm，其余 M-D HH:mm
function fmtNextRun(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts)
  const now = new Date()
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(now)) / 86400000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diff === 0) return `今天 ${hm}`
  if (diff === 1) return `明天 ${hm}`
  if (diff === -1) return `昨天 ${hm}`
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}
function fmtRunTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  const d = new Date(ts)
  const now = new Date()
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(now)) / 86400000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diff === 0) return `今天 ${hm}`
  if (diff === 1) return `明天 ${hm}`
  if (diff === -1) return `昨天 ${hm}`
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}
function TaskStatIcon({ kind }) {
  const Icon = kind === 'enabled' ? CheckCircle2 : kind === 'week' ? TrendingUp : kind === 'success' ? ShieldCheck : Clock3
  return <Icon aria-hidden="true" />
}
function TasksPage({ notify, setConfirm, settingsData, workspace }) {
  const [createOpen, setCreateOpen] = useState(false) // 创建/编辑向导弹窗
  const [cronOpen, setCronOpen] = useState(false) // cron 构造器弹窗
  const [draft, setDraft] = useState({ ...EMPTY_TASK_DRAFT }) // 向导表单草稿
  const [editId, setEditId] = useState(null) // 编辑中的任务 id（null = 创建）
  const [tasks, setTasks] = useState([]) // 任务列表
  const [overview, setOverview] = useState(null) // 任务页聚合统计（主进程一次计算）
  const [filter, setFilter] = useState('all') // 全部 / 已启用 / 已停用
  const [loading, setLoading] = useState(true)
  const [workspaces, setWorkspaces] = useState([]) // 工作区列表（复用 workspace:list）
  const [expandedId, setExpandedId] = useState(null) // 展开执行记录的任务 id（null = 全部收起）
  const [histories, setHistories] = useState({}) // 历史数据：任务 id → 执行记录数组（每次展开/轮询拉最新，不做永久缓存）
  const [historyDetail, setHistoryDetail] = useState(null) // 执行记录详情弹窗 {task, item}（null = 关闭）
  const expandedRef = useRef(null) // 展开任务 id 的 ref 副本（轮询闭包读取最新值）
  const promptRef = useRef(null) // prompt 输入框引用（拖拽调整高度用）
  const dragRef = useRef(null) // 拖拽起始数据
  // 拉取任务列表
  const refreshTasks = useCallback(async () => {
    try {
      const overviewPromise =
        typeof window.xwork.taskOverview === 'function'
          ? window.xwork.taskOverview().catch(() => null)
          : Promise.resolve(null)
      const [list, ov] = await Promise.all([window.xwork.taskList(), overviewPromise])
      setTasks(Array.isArray(list) ? list : [])
      if (ov) setOverview(ov)
    } catch {
      /* 主进程不可用时保持现状 */
    } finally {
      setLoading(false)
    }
    // 执行记录展开期间同步刷新该任务历史：执行完成产生新记录后，展开列表自动追加（无需手动重新展开）
    const exp = expandedRef.current
    if (exp) {
      try {
        const h = await window.xwork.taskHistory(exp)
        setHistories((m) => ({ ...m, [exp]: Array.isArray(h) ? h : [] }))
      } catch {
        /* 拉取失败保持现有数据 */
      }
    }
  }, [])
  // 进入页面拉取列表 + 每 5 秒轮询（任务状态/结果实时刷新）
  useEffect(() => {
    refreshTasks()
    const timer = setInterval(refreshTasks, 5000)
    return () => clearInterval(timer)
  }, [refreshTasks])
  // 展开任务 id 同步到 ref（供无依赖的 refreshTasks 闭包读取）
  useEffect(() => {
    expandedRef.current = expandedId
  }, [expandedId])
  // 拖拽手柄调整 prompt 输入区高度（手柄在模型栏右下角）
  const startResize = (e) => {
    e.preventDefault()
    const ta = promptRef.current
    if (!ta) return
    dragRef.current = { startY: e.clientY, startH: ta.offsetHeight }
    document.body.classList.add('resizing-task')
    const onMove = (ev) => {
      const d = dragRef.current
      if (!d) return
      const h = Math.max(60, Math.min(window.innerHeight * 0.6, d.startH + (ev.clientY - d.startY)))
      ta.style.height = h + 'px'
    }
    const onUp = () => {
      dragRef.current = null
      document.body.classList.remove('resizing-task')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
  // 打开创建向导：重置表单并拉取最新工作区列表；默认选中当前工作区（无匹配则第一个，都无则留空）
  const openCreate = async () => {
    setEditId(null)
    setCreateOpen(true)
    let list = []
    try {
      list = await window.xwork.workspaceList()
    } catch {
      list = []
    }
    const arr = Array.isArray(list) ? list : []
    setWorkspaces(arr)
    const defWs = arr.some((w) => w.dir === workspace) ? workspace : arr[0]?.dir || ''
    setDraft({ ...EMPTY_TASK_DRAFT, workspace: defWs })
  }
  // 打开编辑向导：任务字段预填（timeoutMs → 分钟）
  const openEdit = async (task) => {
    setEditId(task.id)
    setDraft({
      name: task.name,
      workspace: task.workspace,
      prompt: task.prompt,
      model: task.model,
      agent: task.agent || 'build',
      cron: task.schedule || '0 9 * * *',
      timeout: Math.round((task.timeoutMs || 1800000) / 60000),
      retries: task.retries ?? 2,
      confirmed: true // 已存在的任务视为已确认
    })
    setCreateOpen(true)
    try {
      const list = await window.xwork.workspaceList()
      setWorkspaces(Array.isArray(list) ? list : [])
    } catch {
      setWorkspaces([])
    }
  }
  // 提交创建/编辑（先渲染层校验必填项，再调主进程）
  const submitTask = async () => {
    if (!draft.name.trim()) return notify('请填写任务名称')
    if (!draft.workspace) return notify('请选择任务工作区')
    if (!draft.prompt.trim()) return notify('请填写执行内容（prompt）')
    if (!draft.model) return notify('请选择模型')
    const payload = {
      name: draft.name.trim(),
      workspace: draft.workspace,
      prompt: draft.prompt,
      model: draft.model,
      schedule: draft.cron,
      timeoutMs: (Number(draft.timeout) || 30) * 60000,
      retries: Number.isInteger(draft.retries) ? draft.retries : 2
    }
    try {
      if (editId) {
        await window.xwork.taskUpdate(editId, payload)
        notify('任务已更新')
      } else {
        await window.xwork.taskCreate(payload)
        notify('任务已创建')
      }
      setCreateOpen(false)
      refreshTasks()
    } catch (e) {
      notify('保存失败：' + (e && e.message ? e.message : e))
    }
  }
  // 启停切换
  const toggleEnabled = async (task) => {
    try {
      await window.xwork.taskUpdate(task.id, { enabled: !task.enabled })
      refreshTasks()
    } catch (e) {
      notify('操作失败：' + (e && e.message ? e.message : e))
    }
  }
  // 立即执行：点击即本地锁定卡片（禁用编辑/删除/再次执行 + 显示「执行中」），不等 IPC 返回
  // （tasks:run-now 主进程会阻塞到任务执行完成，返回的 ok 表示「执行成功完成」而非「已开始」，
  //   失败/超时在 r.result 中；执行期间 UI 反馈靠本地 _running + 5 秒轮询维持）
  const runNow = async (task) => {
    if (task._running) return // 防重复点击
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, _running: true } : x)))
    try {
      const r = await window.xwork.taskRunNow(task.id)
      if (r && r.ok) notify('任务执行完成')
      else if (r && r.reason === 'busy') notify('已有任务在执行中，请稍候')
      else if (r && r.result && r.result.status) notify(`任务${TASK_STATUS_TEXT[r.result.status] || r.result.status}`)
      else notify('任务启动失败')
    } catch (e) {
      notify('启动失败：' + (e && e.message ? e.message : e))
    } finally {
      refreshTasks() // 执行结束刷新（_running 由主进程 isCurrent 判断恢复为 false）
    }
  }
  // 删除任务（复用全局确认框，风格与删除工作区一致）
  const deleteTask = (task) => {
    setConfirm({
      title: '删除任务',
      message: `确定删除定时任务「${task.name}」？将同时清理其会话记录，此操作不可恢复。`,
      danger: true,
      confirmLabel: '删除',
      onConfirm: async () => {
        try {
          await window.xwork.taskRemove(task.id)
          notify('任务已删除')
          refreshTasks()
        } catch (e) {
          notify('删除失败：' + (e && e.message ? e.message : e))
        }
      }
    })
  }
  // 展开/收起执行记录：每次展开都拉取最新（不做永久缓存，避免与按钮计数不一致）
  const toggleHistory = async (task) => {
    if (expandedId === task.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(task.id)
    try {
      const h = await window.xwork.taskHistory(task.id)
      setHistories((m) => ({ ...m, [task.id]: Array.isArray(h) ? h : [] }))
    } catch {
      setHistories((m) => ({ ...m, [task.id]: [] }))
    }
  }
  // 可用模型列表（聊天框同源计算）：模型组 → providerID/modelID
  const models = []
  for (const g of settingsData?.modelGroups || []) {
    for (const m of g.models) models.push({ providerID: g.id, modelID: m, label: g.name + ' / ' + m })
  }
  // 工作区下拉：编辑时任务工作区若已不在列表，补一项避免值丢失
  const wsOptions = workspaces.slice()
  if (draft.workspace && !wsOptions.some((w) => w.dir === draft.workspace)) {
    wsOptions.unshift({ dir: draft.workspace, name: draft.workspace })
  }
  const enabledCount = tasks.filter((t) => t.enabled).length
  const disabledCount = tasks.length - enabledCount
  const filteredTasks = tasks.filter((t) =>
    filter === 'enabled' ? t.enabled : filter === 'disabled' ? !t.enabled : true
  )
  const nextByTask = overview?.nextByTask || {}
  const recent = overview?.recent || []
  const stats = overview || {
    total: tasks.length,
    enabled: enabledCount,
    disabled: disabledCount,
    todayPending: null,
    nextAt: null,
    nextName: null,
    weekRuns: null,
    weekCompleted: 0,
    weekFailed: 0,
    successRate: null
  }
  return (
    <div className="tasks-page">
      <div className="tasks-head">
        <div className="tasks-title">
          <div className="page-eyebrow">自动化</div>
          <span className="tasks-title-main">定时任务</span>
          <span className="tasks-title-sub">在指定工作区按时间计划自动执行 Agent 任务，完成后系统通知反馈</span>
          <span className="tasks-title-sub">请勿关闭电脑或退出客户端，否则任务将无法正常执行</span>
        </div>
        <div className="page-actions">
          <button className="page-btn primary" onClick={openCreate}>
            新建任务
          </button>
        </div>
      </div>
      <div className="tasks-body">
        {loading ? (
          <div className="tasks-loading">加载中…</div>
        ) : (
          <>
            <div className="tasks-stats">
              <div className="task-stat">
                <div className="task-stat-label"><TaskStatIcon kind="enabled" />启用中</div>
                <div className="task-stat-value">{stats.enabled}<small> / {stats.total}</small></div>
                <div className="task-stat-note">共 {stats.total} 个定时任务</div>
              </div>
              <div className="task-stat">
                <div className="task-stat-label"><TaskStatIcon kind="today" />今日待执行</div>
                <div className="task-stat-value">{stats.todayPending === null ? '—' : stats.todayPending}</div>
                <div className="task-stat-note">
                  {!overview
                    ? '统计暂不可用'
                    : stats.nextAt
                      ? `下一次 ${fmtNextRun(stats.nextAt)}${stats.nextName ? ' · ' + stats.nextName : ''}`
                      : '今天暂无计划'}
                </div>
              </div>
              <div className="task-stat">
                <div className="task-stat-label"><TaskStatIcon kind="week" />近 7 天执行</div>
                <div className="task-stat-value">{stats.weekRuns === null ? '—' : stats.weekRuns}</div>
                <div className="task-stat-note">
                  {!overview
                    ? '统计暂不可用'
                    : stats.weekRuns
                      ? `成功 ${stats.weekCompleted} · 失败 ${stats.weekFailed}`
                      : '近 7 天暂无执行'}
                </div>
              </div>
              <div className="task-stat">
                <div className="task-stat-label"><TaskStatIcon kind="success" />成功率</div>
                <div className="task-stat-value">
                  {stats.successRate === null ? '—' : stats.successRate}
                  {stats.successRate !== null && <small>%</small>}
                </div>
                <div className="task-stat-note">{stats.weekRuns ? '近 7 天' : '暂无执行数据'}</div>
              </div>
            </div>

            <div className="tasks-layout">
              <div className="tasks-main">
                {tasks.length === 0 ? (
                  <div className="tasks-empty">
                    <div className="tasks-empty-icon"><CalendarClock size={40} strokeWidth={1.5} aria-hidden="true" /></div>
                    <div className="tasks-empty-title">暂无定时任务</div>
                    <div className="tasks-empty-sub">
                      创建后可设定：任务工作区、执行内容（prompt）、模型、执行频率（每天 / 每周 / 每 N 小时）
                    </div>
                  </div>
                ) : (
                  <>
                <div className="tasks-toolbar">
                  <div className="task-filters" role="tablist" aria-label="任务筛选">
                    {[
                      ['all', '全部', tasks.length],
                      ['enabled', '已启用', enabledCount],
                      ['disabled', '已停用', disabledCount]
                    ].map(([key, label, count]) => (
                      <button
                        key={key}
                        className={filter === key ? 'active' : ''}
                        role="tab"
                        aria-selected={filter === key}
                        onClick={() => setFilter(key)}
                      >
                        {label} <span>{count}</span>
                      </button>
                    ))}
                  </div>
                  <span className="tasks-filter-count">{filteredTasks.length} 个任务</span>
                </div>
                <div className="tasks-list">
                  {filteredTasks.length === 0 ? (
                    <div className="tasks-filter-empty">
                      <div>该筛选下暂无任务</div>
                      <button onClick={() => setFilter('all')}>查看全部任务</button>
                    </div>
                  ) : (
                    filteredTasks.map((t) => (
              <div key={t.id} className={'task-card' + (t._running ? ' running' : '')}>
                <div className="task-card-head">
                  <div className="task-card-icon" aria-hidden="true">
                    {taskIcon(t)}
                  </div>
                  <span className="task-card-name" title={t.prompt}>
                    {t.name || '（未命名任务）'}
                  </span>
                  {t._running && <span className="task-card-badge running"><Loader2 className="icon-spin" size={12} strokeWidth={1.8} aria-hidden="true" />执行中…</span>}
                  <div className="tb-spacer" />
                  <label className="task-toggle" title={t.enabled ? '点击停用' : '点击启用'}>
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      disabled={t._running}
                      onChange={() => toggleEnabled(t)}
                    />
                    <span className="task-toggle-track" />
                  </label>
                </div>
                <div className="task-card-meta">
                  <span title={'Cron: ' + t.schedule}>
                    <Clock3 size={12} strokeWidth={1.8} aria-hidden="true" /> {t._nextText}
                  </span>
                  {t.enabled ? (
                    t.schedule === '@startup' ? (
                      <span className="task-next">应用启动时</span>
                    ) : nextByTask[t.id] ? (
                      <span className="task-next">下次 {fmtNextRun(nextByTask[t.id])}</span>
                    ) : null
                  ) : (
                    <span className="task-next muted">已停用</span>
                  )}
                  <span className="task-card-ws" title={t.workspace}>
                    <Folder size={12} strokeWidth={1.8} aria-hidden="true" /> {t.workspace}
                  </span>
                </div>
                <div className="task-card-result">
                  {t.lastResult ? (
                    <>
                      <span className={'task-status st-' + t.lastResult.status}>
                        {TASK_STATUS_TEXT[t.lastResult.status] || t.lastResult.status}
                      </span>
                      <span className="task-summary" title={t.lastResult.summary}>
                        {t.lastResult.summary
                          ? t.lastResult.summary.slice(0, 100) +
                            (t.lastResult.summary.length > 100 ? '…' : '')
                          : ''}
                      </span>
                      <span className="task-dur">{fmtTaskDur(t.lastResult.durationMs)}</span>
                    </>
                  ) : (
                    <span className="task-summary dim">尚未执行</span>
                  )}
                </div>
                <div className="task-card-ops">
                  <button disabled={t._running} onClick={() => runNow(t)}>
                    <Play size={13} strokeWidth={1.8} aria-hidden="true" /> 立即执行
                  </button>
                  <button disabled={t._running} onClick={() => openEdit(t)}>
                    <Pencil size={13} strokeWidth={1.8} aria-hidden="true" /> 编辑
                  </button>
                  <button disabled={t._running} onClick={() => deleteTask(t)}>
                    <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" /> 删除
                  </button>
                  <button
                    className={'task-history-toggle' + (expandedId === t.id ? ' open' : '')}
                    onClick={() => toggleHistory(t)}
                    title="展开/收起执行记录"
                  >
                    <History size={13} strokeWidth={1.8} aria-hidden="true" /> 执行记录{t._historyCount > 0 ? `（${t._historyCount}）` : ''}
                  </button>
                </div>
                {expandedId === t.id && (
                  <div className="task-history">
                    {histories[t.id] && histories[t.id].length > 0 ? (
                      <div className="task-history-list">
                        {histories[t.id].map((h, i) => (
                          <div key={h.runAt + '-' + i} className="task-history-item">
                            <div className="task-history-line">
                              <span className={'task-status st-' + h.status}>
                                {TASK_STATUS_TEXT[h.status] || h.status}
                              </span>
                              <span className="task-history-time">{fmtDateTime(h.runAt)}</span>
                              <span className="task-dur">{fmtTaskDur(h.durationMs)}</span>
                              {h.autoAnswered && <span className="task-history-tag">已默认应答</span>}
                              {h.attempts > 1 && (
                                <span className="task-history-tag">重试 {h.attempts - 1} 次</span>
                              )}
                            </div>
                            <div className="task-history-summary-row">
                              <div
                                className="md-body task-history-summary"
                                dangerouslySetInnerHTML={{
                                  __html: marked.parse(
                                    h.summary
                                      ? h.summary.slice(0, 100) + (h.summary.length > 100 ? '…' : '')
                                      : '（无摘要）'
                                  )
                                }}
                              />
                              <button
                                className="task-history-detail"
                                onClick={() => setHistoryDetail({ task: t, item: h })}
                              >
                                详情
                              </button>
                            </div>
                            {h.error && h.error !== h.summary && (
                              <div className="task-history-error">{h.error}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="task-history-empty">暂无执行记录</div>
                    )}
                  </div>
                )}
              </div>
                    ))
                  )}
                </div>
                  </>
                )}
              </div>
              <aside className="tasks-recent" aria-label="近期执行">
                <div className="tasks-recent-head">
                  <span className="tasks-recent-title">近期执行</span>
                  <span className="tasks-recent-sub">{recent.length ? `最近 ${recent.length} 条` : '暂无记录'}</span>
                </div>
                {recent.length ? (
                  <div className="tasks-timeline">
                    {recent.map((r, i) => {
                      const task = tasks.find((x) => x.id === r.taskId)
                      const ok = r.status === 'completed'
                      const cls = ok ? 'ok' : r.status === 'timeout' ? 'warn' : 'err'
                      return (
                        <button
                          key={`${r.taskId}-${r.runAt}-${i}`}
                          className="tasks-tl"
                          title={r.summary || ''}
                          disabled={!task}
                          onClick={() => task && setHistoryDetail({ task, item: r })}
                        >
                          <span className={`tasks-tl-dot ${cls}`} />
                          <span className="tasks-tl-main">
                            <span className="tasks-tl-name">{r.taskName || task?.name || '未知任务'}</span>
                            <span className="tasks-tl-meta">
                              {fmtRunTime(r.runAt)}
                              {fmtTaskDur(r.durationMs) ? ` · ${fmtTaskDur(r.durationMs)}` : ''}
                            </span>
                          </span>
                          <span className={`tasks-tl-tag ${cls}`}>
                            {TASK_STATUS_TEXT[r.status] || r.status}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className="tasks-recent-empty">暂无执行记录</div>
                )}
                <div className="tasks-recent-note">完整记录见各任务卡</div>
              </aside>
            </div>
          </>
        )}
      </div>

      {/* 执行记录详情弹窗（展示 summary 全文，Markdown 渲染） */}
      {historyDetail && (
        <div className="perm-mask z-top">
          <div className="history-detail-card">
            <div className="history-detail-head">
              <div className="history-detail-title">执行详情</div>
              <button className="history-detail-close" onClick={() => setHistoryDetail(null)}>
                <X size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
            <div className="history-detail-sub">
              {historyDetail.task.name} · {fmtDateTime(historyDetail.item.runAt)}
            </div>
            <div className="history-detail-meta">
              <span className={'task-status st-' + historyDetail.item.status}>
                {TASK_STATUS_TEXT[historyDetail.item.status] || historyDetail.item.status}
              </span>
              <span className="task-dur">{fmtTaskDur(historyDetail.item.durationMs)}</span>
              {historyDetail.item.autoAnswered && (
                <span className="task-history-tag">已默认应答</span>
              )}
              {historyDetail.item.attempts > 1 && (
                <span className="task-history-tag">重试 {historyDetail.item.attempts - 1} 次</span>
              )}
            </div>
            <div
              className="history-detail-body md-body"
              dangerouslySetInnerHTML={{
                __html: marked.parse(historyDetail.item.summary || '（无摘要）')
              }}
            />
            {historyDetail.item.error && (
              <div className="history-detail-error">{historyDetail.item.error}</div>
            )}
          </div>
        </div>
      )}

      {/* 创建/编辑任务向导（点击遮罩不关闭，仅通过按钮关闭） */}
      {createOpen && (
        <div className="perm-mask">
          <div className="perm-card task-create-card" onClick={(e) => e.stopPropagation()}>
            <div className="perm-title">{editId ? '编辑定时任务' : '创建定时任务'}</div>
            <div className="tc-body">
              <div className="tc-group">
                <div className="tc-label">任务名称</div>
                <input
                  className="set-input"
                  placeholder="例如：每日变更摘要"
                  value={draft.name}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </div>

              <div className="tc-group">
                <div className="tc-label">任务工作区</div>
                <WorkspacePicker
                  className="ws-picker"
                  workspaces={wsOptions}
                  value={draft.workspace}
                  onPick={(dir) => set({ workspace: dir })}
                  onAdd={async () => {
                    try {
                      const list = await window.xwork.workspaceList()
                      setWorkspaces(Array.isArray(list) ? list : [])
                    } catch {
                      /* 列表刷新失败时静默，不影响已选中的新工作区 */
                    }
                  }}
                />
              </div>

              <div className="tc-group">
                <div className="tc-label">执行内容（prompt）</div>
                <div className="tc-prompt-box">
                  <textarea
                    ref={promptRef}
                    className="set-input tc-prompt"
                    rows={4}
                    placeholder="例如：读取 CHANGELOG.md 生成昨日变更摘要，输出到 daily.md"
                    value={draft.prompt}
                    onChange={(e) => set({ prompt: e.target.value })}
                  />
                  <div className="tc-prompt-bar">
                    <ModelPicker
                      models={models}
                      value={draft.model}
                      onPick={(key) => {
                        const i = key.lastIndexOf('/')
                        const keep = draft.model?.variant
                        // 新建任务首次选模型时继承全局默认档；编辑任务保持原值
                        const inherit =
                          !editId && !keep && settingsData?.effort?.enabled && settingsData?.effort?.default !== 'default'
                            ? settingsData.effort.default
                            : undefined
                        set({
                          model: {
                            providerID: key.slice(0, i),
                            modelID: key.slice(i + 1),
                            ...(keep ? { variant: keep } : inherit ? { variant: inherit } : {})
                          }
                        })
                      }}
                    />
                    {settingsData?.effort?.enabled !== false && (
                      <EffortPicker
                        value={draft.model?.variant || 'default'}
                        disabled={!draft.model}
                        reason="请先选择模型"
                        onPick={(v) =>
                          set({
                            model: {
                              ...(draft.model || {}),
                              variant: v === 'default' ? undefined : v
                            }
                          })
                        }
                      />
                    )}
                  </div>
                  <div className="tc-resize-bar" title="拖拽调整输入区高度" onMouseDown={startResize} />
                </div>
              </div>

              <div className="tc-group">
                <div className="tc-label">执行频率（Cron）</div>
                <div className="tc-row">
                  {/* 构造按钮置行首（始终可点，经构造器修改）；cron 以构造器同款圆角分框展示，不提供直接改文本 */}
                  <button type="button" className="tc-build" onClick={() => setCronOpen(true)}>
                    <Timer size={13} strokeWidth={1.8} aria-hidden="true" /> 构造
                  </button>
                  <span className="cb-parts tc-cron">
                    {(() => {
                      const parts = draft.cron.trim() ? draft.cron.trim().split(/\s+/) : []
                      // 标准 5 字段逐个分框；非标准（如 @startup）整体一个框；空值显示占位
                      const show = parts.length === 5 ? parts : [draft.cron.trim() || '未设置']
                      return show.map((p, i) => (
                        <span className="cb-part" key={i}>
                          {p}
                        </span>
                      ))
                    })()}
                  </span>
                </div>
              </div>

              <div className="tc-group">
                <div className="tc-label">超时 / 重试</div>
                <div className="tc-row">
                  <label className="tc-inline">
                    执行超时（分钟）
                    <input
                      type="number"
                      min={1}
                      value={draft.timeout}
                      onChange={(e) => set({ timeout: Number(e.target.value) })}
                    />
                  </label>
                  <label className="tc-inline">
                    失败重试（次）
                    <input
                      type="number"
                      min={0}
                      value={draft.retries}
                      onChange={(e) => set({ retries: Number(e.target.value) })}
                    />
                  </label>
                </div>
              </div>

              <div className="tc-group tc-risk">
                <label className="tc-risk-label">
                  <input
                    type="checkbox"
                    checked={draft.confirmed}
                    onChange={(e) => set({ confirmed: e.target.checked })}
                  />
                  <span>
                    我已了解：任务将无人值守自动执行（权限为允许档），AI 可能修改工作区文件；最小化到托盘时任务仍照常执行
                  </span>
                </label>
              </div>
            </div>
            <div className="perm-btns">
              <button onClick={() => setCreateOpen(false)}>取消</button>
              <button className="primary" disabled={!draft.confirmed} onClick={submitTask}>
                {editId ? '保存修改' : '创建任务'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* cron 构造器（简化版） */}
      {cronOpen && (
        <CronBuilder
          initial={draft.cron}
          onApply={(c) => {
            set({ cron: c })
            setCronOpen(false)
          }}
          onClose={() => setCronOpen(false)}
        />
      )}
    </div>
  )
}

// cron 字段定义：分/时/日 为「每分钟/每隔N/指定」三选一单选；月/周 为勾选框（全选=每月/每周，部分=指定）
const MONTH_OPTS = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}月` }))
// 周勾选框：周一起首、周日末尾（cron 值仍 0=周日，仅展示顺序调整）
const WEEK_OPTS = [
  { value: 1, label: '一', title: '周一' },
  { value: 2, label: '二', title: '周二' },
  { value: 3, label: '三', title: '周三' },
  { value: 4, label: '四', title: '周四' },
  { value: 5, label: '五', title: '周五' },
  { value: 6, label: '六', title: '周六' },
  { value: 0, label: '日', title: '周日' }
]
const CRON_FIELDS = [
  { key: 'min', label: '分钟', min: 0, max: 59, list: true },
  { key: 'hour', label: '小时', min: 0, max: 23, list: true },
  { key: 'day', label: '日', min: 1, max: 31, list: true },
  { key: 'month', label: '月', min: 1, max: 12, checks: true, opts: MONTH_OPTS },
  { key: 'week', label: '周', min: 0, max: 6, checks: true, opts: WEEK_OPTS }
]

// 把 cron 字符串解析为字段表：all（*）/ step（*/N）/ list（逗号列表）；月/周 仅 all/list（勾选框）
function parseCronToFields(cron) {
  const parts = (cron || '0 9 * * *').trim().split(/\s+/)
  const out = {}
  CRON_FIELDS.forEach((f, i) => {
    const v = parts[i]
    const step = v && /^\*\/(\d+)$/.exec(v)
    if (f.checks) {
      // 月/周：* 或 */N 展开（兼容已有 */N 手工输入）→ 全选为 all，否则为 list
      const vals = step ? (() => { const arr = []; for (let x = f.min; x <= f.max; x += Number(step[1])) arr.push(x); return arr })()
        : v === undefined || v === '*' ? f.opts.map((o) => o.value) : null
      if (vals) out[f.key] = vals.length === f.opts.length ? { mode: 'all' } : { mode: 'list', values: vals.join(',') }
      else out[f.key] = { mode: 'list', values: v }
      return
    }
    out[f.key] = step
      ? { mode: 'step', step: Math.min(Math.max(Number(step[1]), 1), f.max) }
      : v === undefined || v === '*'
        ? { mode: 'all' }
        : { mode: 'list', values: v }
  })
  return out
}

// 由字段表生成 cron 字符串
function buildCronFromFields(f) {
  return CRON_FIELDS.map((x) => {
    const v = f[x.key]
    if (v.mode === 'all') return '*'
    if (v.mode === 'step') return v.step > 1 ? `*/${v.step}` : '*'
    return v.values.trim() || '*'
  }).join(' ')
}

// 时间点格式化（构造器预览）：今天/明天 HH:mm，其余 M月D日 HH:mm
function formatRunTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

// cron 构造器弹窗：分/时/日 为「每分钟/每隔N/指定」单选（必选其一），指定后接逗号列表输入框；月/周 为勾选框（全选=每月/每周，部分=指定）；点击遮罩不关闭，仅通过按钮关闭
function CronBuilder({ initial, onApply, onClose }) {
  const [fields, setFields] = useState(() => parseCronToFields(initial))
  // @startup 等特殊计划无法用 5 字段构造器表达：未改动字段时原样保留，
  // 一旦用户修改任一字段即切换为普通构造模式（以默认每天 9:00 为起点），避免拼出非法表达式
  const [rawOverride, setRawOverride] = useState(initial === '@startup' ? '@startup' : null)
  const setF = (key, val) =>
    setFields((d) => {
      const base = rawOverride ? parseCronToFields('0 9 * * *') : d
      setRawOverride(null)
      return { ...base, [key]: val }
    })
  const cron = rawOverride ?? buildCronFromFields(fields)
  const [runs, setRuns] = useState([])
  // cron 变化后（防抖）计算接下来 5 次运行时间点（底部预览）
  useEffect(() => {
    let alive = true
    const timer = setTimeout(async () => {
      try {
        const r = await window.xwork.taskNextRuns(cron, 5)
        if (alive) setRuns(Array.isArray(r) ? r : [])
      } catch {
        if (alive) setRuns([])
      }
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [cron])
  // 月/周 勾选框切换：全选 → all（每月/每周），部分/0 个 → list（逗号列表）
  const toggleCheck = (key, val, checked) => {
    const v = fields[key]
    const f = CRON_FIELDS.find((x) => x.key === key)
    const cur = new Set(v.mode === 'all' ? f.opts.map((x) => x.value) : (v.values ? v.values.split(',').map(Number) : []))
    if (checked) cur.add(val)
    else cur.delete(val)
    const sorted = [...cur].sort((a, b) => a - b)
    setF(key, sorted.length === f.opts.length ? { mode: 'all' } : { mode: 'list', values: sorted.join(',') })
  }
  return (
    <div className="perm-mask">
      <div className="perm-card cron-builder-card" onClick={(e) => e.stopPropagation()}>
        <div className="perm-title"><Timer size={15} strokeWidth={1.8} aria-hidden="true" /> Cron 构造器</div>
        <div className="cb-fields">
          {CRON_FIELDS.map((f) => {
            const v = fields[f.key]
            return f.list ? (
              <div className="cb-row" key={f.key}>
                <span className="cb-label">{f.label}</span>
                <div className="cb-modes">
                  <label className="cb-radio">
                    <input type="radio" name={f.key} checked={v.mode === 'all'} onChange={() => setF(f.key, { mode: 'all' })} />
                    每{f.label}
                  </label>
                  <label className="cb-radio">
                    <input type="radio" name={f.key} checked={v.mode === 'step'} onChange={() => setF(f.key, { mode: 'step', step: 1 })} />
                    每隔
                    <input
                      type="number"
                      min={1}
                      max={f.max}
                      value={v.mode === 'step' ? v.step : 1}
                      disabled={v.mode !== 'step'}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setF(f.key, { mode: 'step', step: Math.max(1, Math.min(Math.round(Number(e.target.value) || 1), f.max)) })}
                    />
                    {f.label}
                  </label>
                  <div className="cb-line">
                    <label className="cb-radio">
                      <input type="radio" name={f.key} checked={v.mode === 'list'} onChange={() => setF(f.key, { mode: 'list', values: '' })} />
                      指定
                    </label>
                    {v.mode === 'list' && (
                      <input
                        className="cb-values"
                        type="text"
                        placeholder={`${f.min}-${f.max}的数字,逗号分隔`}
                        value={v.values}
                        onChange={(e) => setF(f.key, { mode: 'list', values: e.target.value.replace(/，/g, ',') })}
                      />
                    )}
                  </div>
                </div>
              </div>
            ) : f.checks ? (
              <div className="cb-row" key={f.key}>
                <span className="cb-label">{f.label}</span>
                <div className="cb-checks">
                  {f.opts.map((o) => {
                    const sel = v.mode === 'all' ? f.opts.map((x) => x.value) : (v.values ? v.values.split(',').map(Number) : [])
                    return (
                      <label className="cb-check" key={o.value} title={o.title}>
                        <input
                          type="checkbox"
                          checked={sel.includes(o.value)}
                          onChange={(e) => toggleCheck(f.key, o.value, e.target.checked)}
                        />
                        {o.label}
                      </label>
                    )
                  })}
                </div>
              </div>
            ) : null
          })}
        </div>
        <div className="cb-preview">
          <span className="cb-preview-label">表达式：</span>
          <span className="cb-parts">
            {cron.split(' ').map((p, i) => (
              <span className="cb-part" key={i}>
                {p}
              </span>
            ))}
          </span>
        </div>
        <div className="cb-next">
          <div className="cb-next-title">接下来5次运行时间点</div>
          {runs.length ? (
            <div className="cb-next-list">
              {runs.map((t) => (
                <span className="cb-next-item" key={t}>
                  {formatRunTime(t)}
                </span>
              ))}
            </div>
          ) : (
            <div className="cb-next-empty">无法计算（表达式无效）</div>
          )}
        </div>
        <div className="perm-btns">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => onApply(cron)}>
            应用
          </button>
        </div>
      </div>
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
        <div className="set-label">组名（如 DeepSeek / Kimi，可自定义）</div>
        <input
          className="set-input"
          placeholder="DeepSeek"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </div>
      <div className="set-group">
        <div className="set-label">Base URL（OpenAI 兼容，不要带 /chat/completions 后缀）</div>
        <input
          className="set-input"
          placeholder="https://api.deepseek.com"
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
          placeholder={'deepseek-v4-flash\ndeepseek-v4-pro'}
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
  onSubmit,
  onCopy
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
    // 编辑态下表单内容高度变化（拖拽模型 ID 输入框右下角抓手拉高）时同步容器高度，
    // 否则容器 overflow:hidden 会把拉高后超出部分裁掉导致内容不可见
    if (!editing) return
    const ro = new ResizeObserver(() => {
      el.style.height = form.offsetHeight + 'px'
      prevH.current = form.offsetHeight
    })
    ro.observe(form)
    return () => ro.disconnect()
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
          <button
            type="button"
            className="mg-name"
            onClick={(e) => onCopy(g.id, e.currentTarget)}
            title="点击复制组 ID（agent.md 的 model: 前半段）"
          >
            {g.name}
          </button>
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
        <div className="mg-refs">
          {g.models.map((m) => (
            <div className="mg-ref-row" key={m}>
              <button type="button" className="mg-ref" onClick={(e) => onCopy(m, e.currentTarget)} title="点击复制模型 ID">
                {m}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── 统计页组件 ────────────────────────────────────────────────────────────────
function statsErrorText(reason, message) {
  if (reason === 'engine_off') return '执行引擎未连接，统计需要引擎启动后读取本地会话库'
  if (reason === 'unsupported') return '当前引擎版本不支持完整统计'
  if (reason === 'timeout') return '统计查询超时'
  return message || '统计加载失败'
}

const STATS_TOOL_META = {
  bash: { label: 'Shell', Icon: Terminal },
  shell: { label: 'Shell', Icon: Terminal },
  read: { label: '读取文件', Icon: FileText },
  edit: { label: '编辑文件', Icon: Pencil },
  write: { label: '编辑文件', Icon: Pencil },
  grep: { label: '搜索内容', Icon: Search },
  glob: { label: '查找文件', Icon: Search },
  websearch: { label: '联网搜索', Icon: Globe },
  webfetch: { label: '抓取网页', Icon: Globe },
  subagent: { label: '子智能体', Icon: Bot },
  task: { label: '子智能体', Icon: Bot },
  todowrite: { label: '任务清单', Icon: ListChecks },
  question: { label: '提问', Icon: MessagesSquare }
}

function StatsRangeSwitch({ value, onChange, disabled }) {
  return (
    <div className="stats-range" role="group" aria-label="统计时间范围">
      {RANGE_OPTIONS.map((r) => (
        <button
          key={r.key}
          type="button"
          className={`stats-range-btn${value === r.key ? ' active' : ''}`}
          aria-pressed={value === r.key}
          disabled={disabled}
          onClick={() => onChange(r.key)}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

// 统计数字缓动：区间变化时从旧值滚到新值（与静态预览一致）；首次渲染、减少动态时直接落值
const animateToken = (v) => fmtTokenCompact(v)
const animateInt = (v) => fmtInt(Math.round(v))
const animateDays = (v) => String(Math.round(v))

function AnimatedNumber({ value, format, className }) {
  const ref = useRef(null)
  const prevRef = useRef(null)
  const rafRef = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const next = Number(value) || 0
    const prev = prevRef.current
    prevRef.current = next
    cancelAnimationFrame(rafRef.current)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prev === null || reduce || Math.abs(next - prev) < 0.01) {
      el.textContent = format(next)
      return
    }
    const start = performance.now()
    const tick = (now) => {
      const p = Math.min(1, (now - start) / 420)
      const eased = 1 - Math.pow(1 - p, 3)
      el.textContent = format(prev + (next - prev) * eased)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
      else el.textContent = format(next)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [value, format])
  return <span ref={ref} className={className} />
}

function StatsHero({ stats, heatmap }) {
  const total = tokenTotal(stats.tokens)
  const current = heatmap ? currentStreak(heatmap.activity) : 0
  const longest = heatmap ? heatmap.streak : 0
  const label = current > 0 ? '连续使用' : '最长连续'
  const streakValue = heatmap ? (current > 0 ? current : longest) : null
  const avg = stats.prompts > 0 ? stats.steps / stats.prompts : null
  const callsAvg = stats.prompts > 0 ? stats.tools.totals.calls / stats.prompts : null
  const success = stats.tools.totals.succeeded + stats.tools.totals.failed > 0
    ? (stats.tools.totals.succeeded / (stats.tools.totals.succeeded + stats.tools.totals.failed)) * 100
    : null
  return (
    <div className="stats-hero">
      <div className="stats-hero-cell">
        <div className="stats-hero-label"><Database size={13} strokeWidth={1.8} />总 Tokens</div>
        <div className="stats-hero-value"><AnimatedNumber value={total} format={animateToken} /></div>
        <div className="stats-hero-note">
          {fmtTokenCompact(stats.tokens.input)} 输入 · {fmtTokenCompact(stats.tokens.output)} 输出 · {fmtTokenCompact(stats.tokens.reasoning)} 推理 · {fmtTokenCompact(stats.tokens.cacheRead)} 缓存
          {stats.tokens.cacheWrite > 0 ? ` · 写入 ${fmtTokenCompact(stats.tokens.cacheWrite)}` : ''}
        </div>
      </div>
      <div className="stats-hero-cell">
        <div className="stats-hero-label"><Zap size={13} strokeWidth={1.8} />AI 请求</div>
        <div className="stats-hero-value"><AnimatedNumber value={stats.steps} format={animateInt} /></div>
        <div className="stats-hero-note">{avg === null ? '—' : `平均每条指令 ${avg.toFixed(1)} 轮`}</div>
      </div>
      <div className="stats-hero-cell">
        <div className="stats-hero-label"><Wrench size={13} strokeWidth={1.8} />工具调用</div>
        <div className="stats-hero-value">{stats.tools.mode === 'none' ? '—' : <AnimatedNumber value={stats.tools.totals.calls} format={animateInt} />}</div>
        <div className="stats-hero-note">
          {stats.tools.mode === 'none' || success === null ? '—' : `成功率 ${success.toFixed(1)}%`}
          {callsAvg === null ? '' : ` · 平均每条指令 ${callsAvg.toFixed(1)} 次`}
        </div>
      </div>
      <div className="stats-hero-cell">
        <div className="stats-hero-label"><Flame size={13} strokeWidth={1.8} /><span>{label}</span></div>
        <div className="stats-hero-value">{streakValue === null ? '—' : <><AnimatedNumber value={streakValue} format={animateDays} /><span className="stats-hero-suffix"> 天</span></>}</div>
        <div className="stats-hero-note">
          {heatmap ? `最近 52 周活跃 ${heatmap.activeDays} 天 · 最长 ${longest} 天` : '热力数据不可用'}
        </div>
      </div>
    </div>
  )
}

function StatsBasicHero({ stats }) {
  return (
    <div className="stats-hero stats-hero-basic">
      <div className="stats-hero-cell">
        <div className="stats-hero-label"><Database size={13} strokeWidth={1.8} />总 Tokens</div>
        <div className="stats-hero-value">{fmtTokenCompact(tokenTotal(stats.tokens))}</div>
        <div className="stats-hero-note">基础统计 · 会话生命周期 token</div>
      </div>
      <div className="stats-hero-cell">
        <div className="stats-hero-label"><MessagesSquare size={13} strokeWidth={1.8} />会话</div>
        <div className="stats-hero-value">{fmtInt(stats.sessions)}</div>
        <div className="stats-hero-note">当前会话库 · 含空会话</div>
      </div>
      <div className="stats-hero-cell">
        <div className="stats-hero-label"><Bot size={13} strokeWidth={1.8} />子智能体</div>
        <div className="stats-hero-value">{fmtInt(stats.subagents)}</div>
        <div className="stats-hero-note">当前会话库可见范围</div>
      </div>
    </div>
  )
}

function TokenMixBar({ tokens }) {
  const total = tokenTotal(tokens)
  const segments = tokenSegments(tokens)
  if (!total) return null
  const chars = total * 0.7
  const equiv = [`≈ ${fmtCharsWan(chars)}`, bookEquiv(chars)].filter(Boolean).join(' · ')
  return (
    <div className="stats-mix">
      <div className="stats-mix-bar" aria-hidden="true">
        {segments.map((s) => (
          <span key={s.key} className={`stats-mix-seg seg-${s.key}`} style={{ width: `${s.pct}%` }} />
        ))}
      </div>
      <div className="stats-mix-legend">
        {segments.map((s) => (
          <span key={s.key}><i className={`seg-${s.key}`} />{s.label} <b>{fmtTokenCompact(s.value)}</b></span>
        ))}
      </div>
      <div className="stats-equiv"><Sparkles size={12} strokeWidth={1.8} />{equiv}</div>
    </div>
  )
}

function UsageHeatmap({ heatmap, loading }) {
  if (!heatmap) {
    return (
      <section className="stats-panel stats-heat-panel">
        <div className="stats-panel-head"><div><div className="stats-panel-title">使用热力</div><div className="stats-panel-sub">最近 52 周</div></div></div>
        <div className="stats-empty-inline">{loading ? '热力加载中…' : '热力数据暂不可用'}</div>
      </section>
    )
  }
  const { weeks, cells, months } = buildHeatmap(heatmap.activity)
  const label = `最近 52 周热力图，${heatmap.activeDays} 天活跃，最长连续 ${heatmap.streak} 天`
  return (
    <section className="stats-panel stats-heat-panel">
      <div className="stats-panel-head">
        <div>
          <div className="stats-panel-title">使用热力</div>
          <div className="stats-panel-sub">过去 52 周 · 颜色越深，当天模型回合越多</div>
        </div>
        <div className="stats-heat-legend" aria-hidden="true">
          少
          <i className="heat-l1" /><i className="heat-l2" /><i className="heat-l3" /><i className="heat-l4" />
          多
        </div>
      </div>
      <div className="stats-heat-wrap">
        <div className="stats-heat">
          <div className="stats-heat-months" style={{ gridTemplateColumns: `repeat(${weeks}, 14px)` }}>
            {months.map((m) => (
              <span key={m.start} style={{ gridColumn: `${m.start + 1} / span ${m.span}` }}>{m.label}</span>
            ))}
          </div>
          <div className="stats-heat-body">
            <div className="stats-heat-days" aria-hidden="true">
              <span>一</span><span /><span>三</span><span /><span>五</span><span /><span />
            </div>
            <div
              className="stats-heat-weeks"
              role="img"
              tabIndex={0}
              aria-label={label}
              style={{ gridTemplateColumns: `repeat(${weeks}, 14px)` }}
            >
              {cells.map((c) => (
                <span
                  key={c.date}
                  className={`stats-heat-cell${c.future ? ' future' : ''} heat-l${c.level}`}
                  title={c.future ? '' : `${c.date} · ${c.steps} 步`}
                  aria-hidden="true"
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="stats-heat-summary">
        <span>最近 52 周（全部记录）</span><span className="sep">·</span>
        <span><b>{fmtInt(heatmap.activeDays)}</b> 天活跃</span><span className="sep">·</span>
        <span>最长连续 <b>{fmtInt(heatmap.streak)} 天</b></span>
      </div>
    </section>
  )
}

function ToolLeaderboard({ tools }) {
  if (!tools || tools.mode === 'none') return null
  const totals = tools.totals
  if (tools.mode === 'summary') {
    return (
      <section className="stats-panel">
        <div className="stats-panel-head"><div><div className="stats-panel-title">工具榜</div><div className="stats-panel-sub">当前引擎仅返回工具汇总</div></div></div>
        <div className="stats-summary-row"><span>调用 <b>{fmtInt(totals.calls)}</b></span><span>成功 <b>{fmtInt(totals.succeeded)}</b></span><span>失败 <b>{fmtInt(totals.failed)}</b></span></div>
      </section>
    )
  }
  const { rows, rest } = topTools(tools, 6)
  const max = rows.reduce((a, x) => Math.max(a, x.calls), 1)
  return (
    <section className="stats-panel">
      <div className="stats-panel-head">
        <div><div className="stats-panel-title">工具榜</div><div className="stats-panel-sub">按调用次数排序 · 含子智能体</div></div>
        <div className="stats-panel-sub">{fmtInt(totals.calls)} 次</div>
      </div>
      <div className="stats-tool-head" aria-hidden="true"><span>工具</span><span>调用</span><span>成功率</span><span>P50</span></div>
      <div className="stats-tool-list">
        {rows.map((t, i) => {
          const meta = STATS_TOOL_META[t.name] || { label: t.name, Icon: Wrench }
          const Icon = meta.Icon
          const denom = t.succeeded + t.failed
          const rate = denom > 0 ? (t.succeeded / denom) * 100 : null
          return (
            <div className={`stats-tool-row${i === 0 ? ' top' : ''}`} key={t.name}>
              <div className="stats-tool-main">
                <span className="stats-tool-ico"><Icon size={13} strokeWidth={1.8} /></span>
                <span className="stats-tool-name"><b>{meta.label}</b><small>{t.name}</small></span>
              </div>
              <div className="stats-tool-calls">{fmtInt(t.calls)}</div>
              <div className="stats-tool-rate">{rate === null ? '—' : <span className={`stats-rate ${rate >= 96 ? 'ok' : 'warn'}`}>{rate.toFixed(1)}%</span>}</div>
              <div className="stats-tool-p50">{fmtDuration(t.durationP50)}</div>
              <div className="stats-tool-track"><i style={{ width: `${Math.max(2, (t.calls / max) * 100)}%` }} /></div>
            </div>
          )
        })}
      </div>
      <div className="stats-panel-foot">
        <span>横条 = 相对调用量 · 成功率 = 成功 /（成功 + 失败）· P50 为中位数耗时</span>
        {rest > 0 && <span>其他 {fmtInt(rest)} 次</span>}
      </div>
    </section>
  )
}

function ModelLeaderboard({ models, modelsTotal }) {
  if (!models || models.length === 0) return null
  const top = models.slice(0, 3)
  const used = top.reduce((a, m) => a + m.steps, 0)
  const restSteps = Math.max(0, (modelsTotal?.steps || used) - used)
  const shares = percentShares([...top.map((m) => m.steps), restSteps])
  const totalSteps = modelsTotal?.steps || top.reduce((a, m) => a + m.steps, 0)
  return (
    <section className="stats-panel stats-model-panel">
      <div className="stats-panel-head">
        <div><div className="stats-panel-title">模型劳模榜</div><div className="stats-panel-sub">按模型调用次数 · 含子智能体</div></div>
      </div>
      <div className="stats-model-stack" aria-hidden="true">
        {shares.map((pct, i) => (
          <span key={i} className={`stats-model-seg model-seg-${i % 3}`} style={{ width: `${pct}%` }} />
        ))}
      </div>
      <div className="stats-model-rows">
        {top.map((m, i) => (
          <div className="stats-model-row" key={m.providerID + '/' + m.id}>
            <div className="stats-model-name">
              <span className={`stats-model-dot model-seg-${i % 3}`} />
              <b>{m.id}</b>
              {i === 0 && <span className="stats-model-fav">最勤劳</span>}
            </div>
            <div className="stats-model-meta">
              <b>{Math.round(shares[i])}%</b>
              <small>{fmtInt(m.steps)} 次 · {fmtTokenCompact(m.tokens)}</small>
            </div>
          </div>
        ))}
        {restSteps > 0 && (
          <div className="stats-model-row">
            <div className="stats-model-name"><span className="stats-model-dot model-seg-2" /><b>其他</b></div>
            <div className="stats-model-meta"><b>{Math.round(shares[top.length])}%</b><small>{fmtInt(restSteps)} 次</small></div>
          </div>
        )}
      </div>
      <div className="stats-model-foot">模型调用合计 {fmtInt(totalSteps)} 次 · 含子智能体</div>
    </section>
  )
}

function StatsFacts({ stats, rangeLabel }) {
  const busiest = (stats.activity || []).reduce((best, x) => (!best || x.steps > best.steps ? x : best), null)
  const avg = stats.prompts > 0 ? stats.steps / stats.prompts : null
  const cache = cacheHitRate(stats.tokens)
  return (
    <div className="stats-facts">
      <div className="stats-fact">
        <div className="stats-fact-icon"><CalendarClock size={14} strokeWidth={1.8} /></div>
        <div><b>{busiest ? fmtDateMD(busiest.date) : '—'}</b><span>最忙的一天</span><small>{busiest ? `当天 ${fmtInt(busiest.steps)} 步 · ${rangeLabel}` : '暂无记录'}</small></div>
      </div>
      <div className="stats-fact">
        <div className="stats-fact-icon"><MessagesSquare size={14} strokeWidth={1.8} /></div>
        <div><b>{avg === null ? '—' : `${avg.toFixed(1)} 轮`}</b><span>平均每条指令</span><small>含子智能体回合</small></div>
      </div>
      <div className="stats-fact">
        <div className="stats-fact-icon"><Database size={14} strokeWidth={1.8} /></div>
        <div><b>{cache === null ? '—' : fmtPct(cache)}</b><span>缓存命中率</span><small>一半上下文靠记忆，不是重新读</small></div>
      </div>
      <div className="stats-fact">
        <div className="stats-fact-icon"><Bot size={14} strokeWidth={1.8} /></div>
        <div><b>{fmtInt(stats.subagents)} 个</b><span>子智能体</span><small>你叫来的小弟，干活也算它们一份</small></div>
      </div>
    </div>
  )
}

function StatsRelationship({ counters }) {
  if (!counters) return null
  const items = [
    ['undo', '后悔药', '回退次数'],
    ['abort', '急刹车', '手动中止'],
    ['permissionDeny', '拒绝 AI', '权限拒绝'],
    ['compact', '失忆', '压缩会话'],
    ['taskRuns', '任务执行', '含立即执行']
  ]
  if (items.every(([k]) => !(counters[k] > 0))) return null
  return (
    <section className="stats-relationship">
      <div className="stats-rel-copy"><h3>你和 AI 的相处</h3><p>自安装以来 · 本地计数，不随上方范围变化</p></div>
      <div className="stats-rel-chips">
        {items.map(([key, label, hint]) => (
          <div className="stats-rel-chip" key={key} title={hint}><b>{fmtInt(counters[key])}</b><span>{label}</span></div>
        ))}
      </div>
    </section>
  )
}

function StatsSkeleton() {
  return (
    <div className="stats-skeleton" aria-hidden="true">
      <div className="stats-skeleton-hero">{Array.from({ length: 4 }).map((_, i) => <i key={i} />)}</div>
      <div className="stats-skeleton-block" />
      <div className="stats-skeleton-panels"><i /><i /></div>
    </div>
  )
}

function StatsPanel({ data, heatmap, heatLoading, counters, loading, refreshing, error, partial, range, onRangeChange, onRefresh }) {
  const rangeLabel = RANGE_OPTIONS.find((x) => x.key === range)?.label || ''
  if (loading && !data) return <StatsSkeleton />
  if (!data) {
    return (
      <div className="stats-state">
        <div className="stats-state-icon"><TrendingUp size={28} strokeWidth={1.5} /></div>
        <div className="stats-state-title">{error ? '统计加载失败' : '正在加载统计'}</div>
        <div className="stats-state-sub">{error || '读取当前引擎会话库…'}</div>
        <button className="stats-state-btn" onClick={onRefresh}>重试</button>
        <StatsRelationship counters={counters} />
      </div>
    )
  }

  const stats = data.stats
  const total = tokenTotal(stats.tokens)
  const basic = data.mode === 'basic'
  const empty = !basic && total === 0 && stats.steps === 0 && stats.prompts === 0
  const persona = pickPersona(stats.tools)

  return (
    <div className={`stats-content${refreshing ? ' refreshing' : ''}`}>
      <div className="stats-toolbar">
        <div>
          <div className="stats-eyebrow">INSIGHTS</div>
          <div className="stats-title-row">
            <h2>AI 工位成绩单</h2>
            {persona && <span className="stats-persona"><Terminal size={11} strokeWidth={1.8} />{persona.name}</span>}
          </div>
          <p className="stats-sub">你和它一起干了多少活，以及你平时怎么用它。{persona ? persona.desc : ''}</p>
        </div>
        <StatsRangeSwitch value={range} onChange={onRangeChange} disabled={basic} />
      </div>

      {basic && (
        <div className="stats-banner">
          当前引擎版本不支持完整统计 · 当前会话库（可能不完整）{data.basicTruncated ? '（较旧记录可能被截断）' : ''}
        </div>
      )}
      {partial && <div className="stats-banner">部分数据暂不可用，已显示可用部分</div>}
      {error && <div className="stats-banner danger">{error}（显示上次数据）</div>}

      {basic ? (
        <>
          <div className="stats-hero-panel"><StatsBasicHero stats={stats} /></div>
          <StatsRelationship counters={counters} />
        </>
      ) : empty ? (
        <div className="stats-state">
          <div className="stats-state-icon"><TrendingUp size={28} strokeWidth={1.5} /></div>
          <div className="stats-state-title">{range === 'all' ? '还没有可统计的会话' : `${rangeLabel}没有记录`}</div>
          <div className="stats-state-sub">{range === 'all' ? '去 Work 里聊两句，这里就会有数据。' : '试试「今年」或「全部」，看看更早的记录。'}</div>
          <StatsRelationship counters={counters} />
        </div>
      ) : (
        <>
          <div className="stats-hero-panel">
            <StatsHero stats={stats} heatmap={heatmap} />
            <TokenMixBar tokens={stats.tokens} />
            <div className="stats-scope">
              <span><b>{fmtInt(stats.sessions)}</b> 个会话</span><span className="sep">·</span>
              <span><b>{fmtInt(stats.subagents)}</b> 个子智能体</span><span className="sep">·</span>
              <span><b>{fmtInt(stats.prompts)}</b> 句话</span><span className="sep">·</span>
              <span><b>{fmtInt(stats.activeDays)}</b> 个活跃日</span>
            </div>
          </div>

          <UsageHeatmap heatmap={heatmap} loading={heatLoading} />

          <div className="stats-split">
            <ToolLeaderboard tools={stats.tools} />
            <ModelLeaderboard models={stats.models} modelsTotal={stats.modelsTotal} />
          </div>

          <StatsFacts stats={stats} rangeLabel={rangeLabel} />
          <StatsRelationship counters={counters} />
        </>
      )}
    </div>
  )
}

function StatsFooter({ updatedAt, loading, onRefresh }) {
  const time = updatedAt ? new Date(updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
  return (
    <div className="stats-footer-inner">
      <div className="stats-footer-note"><ShieldCheck size={12} strokeWidth={1.8} />数据只存本地 · 当前引擎会话库（不含定时任务）</div>
      <div className="stats-footer-right">
        <span>{time ? `更新于 ${time}` : '—'}</span>
        <button type="button" className="stats-refresh" disabled={loading} onClick={onRefresh}>
          <RotateCcw size={12} strokeWidth={1.8} className={loading ? 'icon-spin' : ''} />刷新
        </button>
      </div>
    </div>
  )
}

// 设置面板：总览式（左侧导航 + 右侧内容），含「模型设置」「界面设置」「权限设置」「关于」
function SettingsPanel({ data, active, busy, theme, streamReveal, appInfo, appConfig, onThemeChange, onStreamRevealChange, onCloseActionChange, onNotifyTaskChange, onEffortChange, onClose, onSave, onSaveConfig }) {
  const [tab, setTab] = useState('model') // model | appearance | permission | config | stats | about
  const [statsRange, setStatsRange] = useState('year')
  const [statsData, setStatsData] = useState(null)
  const [statsHeatmap, setStatsHeatmap] = useState(null)
  const [statsHeatmapLoading, setStatsHeatmapLoading] = useState(false)
  const [statsCounters, setStatsCounters] = useState({ undo: 0, abort: 0, permissionDeny: 0, compact: 0, taskRuns: 0 })
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsRefreshing, setStatsRefreshing] = useState(false)
  const [statsError, setStatsError] = useState('')
  const [statsPartial, setStatsPartial] = useState(false)
  const [statsUpdatedAt, setStatsUpdatedAt] = useState(0)
  const statsCacheRef = useRef(new Map())
  const statsInflightRef = useRef(new Map())
  const statsHeatInflightRef = useRef(null)
  const statsRangeRef = useRef('year')
  const statsInitRef = useRef(false)
  const statsNextTickRef = useRef(0)
  const [form, setForm] = useState(data)
  // effort 是即时保存的：只同步这一项，避免保存 effort 时把本地未提交的模型组编辑重置掉
  useEffect(() => setForm((f) => ({ ...f, effort: data.effort })), [data.effort])
  // 保存失败后主进程会返回最新的 websearch.valid；同步到草稿，权限行立即反映强制禁用
  useEffect(() => {
    if (!data.websearch) return
    setForm((f) => ({ ...f, websearch: { ...data.websearch } }))
  }, [data.websearch])
  // 「配置」页表单草稿：由有效配置（默认值 + 用户覆盖层）异步到达后填充；多行字段以文本承载便于编辑
  const [configForm, setConfigForm] = useState(null)
  useEffect(() => {
    if (!appConfig) return
    setConfigForm({
      skillApiBase: appConfig.skillApiBase || '',
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
  // ---- 统计页：首屏加载一次；此后仅手动刷新或整点/半点自动更新；切区间不刷新 ----
  const applyStatsRange = (rangeKey, d) => {
    statsCacheRef.current.set(rangeKey, d)
    if (rangeKey !== statsRangeRef.current) return
    setStatsData(d)
    setStatsUpdatedAt(d.fetchedAt || Date.now())
    if (d.counters) setStatsCounters(d.counters)
    setStatsError('')
    if (d.mode === 'basic') setStatsPartial(false)
  }

  const fetchStatsRange = (rangeKey, { force = false } = {}) => {
    if (!force) {
      const cached = statsCacheRef.current.get(rangeKey)
      if (cached) return Promise.resolve(cached)
    }
    const pending = statsInflightRef.current.get(rangeKey)
    if (pending) return pending
    const p = (async () => {
      try {
        const r = await window.xwork.sessionStats({ range: rangeKey })
        if (!r || !r.ok) {
          if (r && r.counters && rangeKey === statsRangeRef.current) setStatsCounters(r.counters)
          if (rangeKey === statsRangeRef.current) setStatsError(statsErrorText(r && r.reason, r && r.message))
          return null
        }
        applyStatsRange(rangeKey, r.data)
        return r.data
      } catch (e) {
        if (rangeKey === statsRangeRef.current) setStatsError(e.message || '统计加载失败')
        return null
      } finally {
        statsInflightRef.current.delete(rangeKey)
      }
    })()
    statsInflightRef.current.set(rangeKey, p)
    return p
  }

  const loadStatsHeatmap = () => {
    if (statsHeatInflightRef.current) return statsHeatInflightRef.current
    setStatsHeatmapLoading(true)
    const p = (async () => {
      try {
        const r = await window.xwork.sessionHeatmap()
        if (r && r.ok && r.data && r.data.heatmap) {
          setStatsHeatmap(r.data.heatmap)
          setStatsPartial(false)
          if (r.data.counters) setStatsCounters(r.data.counters)
        } else {
          setStatsPartial(true)
        }
      } catch {
        setStatsPartial(true)
      } finally {
        setStatsHeatmapLoading(false)
        statsHeatInflightRef.current = null
      }
    })()
    statsHeatInflightRef.current = p
    return p
  }

  // 手动刷新：当前区间 + 热力图先刷新，随后静默刷新已缓存的其他区间
  // 自动刷新（整点/半点）：只刷新当前区间 + 热力图，避免后台反复扫大库
  const refreshStats = async ({ auto = false } = {}) => {
    if (!auto) setStatsRefreshing(true)
    setStatsError('')
    const current = statsRangeRef.current
    await Promise.all([fetchStatsRange(current, { force: true }), loadStatsHeatmap()])
    if (!auto) setStatsRefreshing(false)
    if (auto) return
    for (const opt of RANGE_OPTIONS) {
      if (opt.key !== current && statsCacheRef.current.has(opt.key)) await fetchStatsRange(opt.key, { force: true })
    }
  }

  // 首次进入统计页：拉当前区间 + 热力图；随后后台预取其余区间，切换时直接命中缓存
  useEffect(() => {
    if (!active || tab !== 'stats' || statsInitRef.current) return
    statsInitRef.current = true
    loadStatsHeatmap()
    setTimeout(() => {
      ;(async () => {
        for (const opt of RANGE_OPTIONS) {
          if (opt.key === statsRangeRef.current) continue
          await fetchStatsRange(opt.key)
        }
      })()
    }, 600)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab])

  // 切区间：优先用缓存（不请求）；仅当该区间从未加载成功时才做首次加载
  useEffect(() => {
    if (!active || tab !== 'stats') return
    statsRangeRef.current = statsRange
    const cached = statsCacheRef.current.get(statsRange)
    if (cached) {
      setStatsData(cached)
      setStatsUpdatedAt(cached.fetchedAt || Date.now())
      if (cached.counters) setStatsCounters(cached.counters)
      setStatsError('')
      setStatsLoading(false)
      return
    }
    let alive = true
    setStatsData(null)
    setStatsError('')
    setStatsLoading(true)
    fetchStatsRange(statsRange).then(() => {
      if (alive) setStatsLoading(false)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab, statsRange])

  // 自动刷新：只在统计页打开时挂定时器；离开期间跨过刷新点，回到统计页补一次
  useEffect(() => {
    if (!active || tab !== 'stats') return
    let timerId = 0
    const arm = () => {
      clearTimeout(timerId)
      const now = Date.now()
      const next = nextHalfHourAt(now)
      statsNextTickRef.current = next
      timerId = setTimeout(() => {
        refreshStats({ auto: true })
        arm()
      }, Math.max(500, next - now + 50))
    }
    if (statsInitRef.current && statsNextTickRef.current > 0 && Date.now() >= statsNextTickRef.current) {
      refreshStats({ auto: true })
    }
    arm()
    return () => clearTimeout(timerId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab])

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
      error: result.error || '',
      text: result.text || ''
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
  // 点击组名 / 模型 ID 复制：反馈复用测试气泡（同一套位置与配色，不再额外占卡片版面）
  const copyInCard = async (text, anchor) => {
    try {
      await navigator.clipboard.writeText(text)
      showBubble(anchor, { ok: true, text: '已复制 ' + text })
    } catch (err) {
      showBubble(anchor, { ok: false, error: '复制失败：' + err.message })
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
    // 模型页「保存」仅持久化（应用走右侧「保存并生效」）；权限页「保存」即时热更新生效（无需重启）
    // 不传 note：由主进程返回的 applied（hot/restart/none）决定准确提示，避免"声称热更新、实际重启"
    if (tab === 'model') onSave(form, false, '模型设置已保存（点「保存并生效」即时应用）')
    else if (tab === 'permission') onSave(form, true)
    else if (tab === 'config') {
      if (!configForm) return
      // 多行字段按行拆分还原为数组；数值字段原样传递（主进程 sanitize 做类型/范围校验）
      onSaveConfig({
        skillApiBase: configForm.skillApiBase,
        window: configForm.window,
        hideDirs: configForm.hideDirsText.split('\n').map((x) => x.trim()).filter(Boolean),
        hideFiles: configForm.hideFilesText.split('\n').map((x) => x.trim()).filter(Boolean)
      })
    }
    // 界面设置 / 关于均为即时生效，没有需要落盘的表单
    else return
  }

  return (
    <div className="settings-page">
      <div className="page-head settings-page-head">
        <div>
          <div className="page-eyebrow">偏好</div>
          <h1 className="page-title">设置</h1>
          <p className="page-sub">模型、界面、权限、运行配置与用量统计。修改后即时生效；统计只读，不改任何配置。</p>
        </div>
        {tab === 'stats' && (
          <div className="stats-head-meta"><ShieldCheck size={12} strokeWidth={1.8} />本地运行 · 数据不上传</div>
        )}
      </div>
      <div className="settings-page-main">
        {/* 左侧导航：设置分类 */}
        <div className="settings-nav">
          <div className="settings-nav-title">设置</div>
          <button className={`settings-nav-item ${tab === 'model' ? 'active' : ''}`} onClick={() => setTab('model')}>
            <Settings size={14} strokeWidth={1.8} aria-hidden="true" /> 模型设置
          </button>
          <button className={`settings-nav-item ${tab === 'appearance' ? 'active' : ''}`} onClick={() => setTab('appearance')}>
            <Palette size={14} strokeWidth={1.8} aria-hidden="true" /> 界面设置
          </button>
          <button className={`settings-nav-item ${tab === 'permission' ? 'active' : ''}`} onClick={() => setTab('permission')}>
            <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" /> 权限设置
          </button>
          <button className={`settings-nav-item ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>
            <FileText size={14} strokeWidth={1.8} aria-hidden="true" /> 配置
          </button>
          <button className={`settings-nav-item ${tab === 'stats' ? 'active' : ''}`} onClick={() => setTab('stats')}>
            <TrendingUp size={14} strokeWidth={1.8} aria-hidden="true" /> 统计
          </button>
          <button className={`settings-nav-item ${tab === 'about' ? 'active' : ''}`} onClick={() => setTab('about')}>
            <Info size={14} strokeWidth={1.8} aria-hidden="true" /> 关于
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
                {/* 每个模型组：表单与卡片同挂载，编辑⇄收起平滑动画；正常态两列 */}
                <div className="mg-grid">
                  {(form.modelGroups || []).map((g, gi) => (
                    <GroupCard
                      key={g.id}
                      g={g}
                      editing={editing === gi}
                      draft={draft}
                      setDraft={setDraft}
                      test={cardTest[g.id]}
                      onTest={(e) => runCardTest(g, e)}
                      onCopy={copyInCard}
                      formTest={formTest}
                      onFormTest={runFormTest}
                      onEdit={() => startEdit(gi)}
                      onRemove={() => removeGroup(gi)}
                      onCancel={cancelForm}
                      onSubmit={confirmEdit}
                    />
                  ))}
                </div>
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

              <div className="set-hint">
                给某个智能体固定模型：点组名复制组 ID、点模型 ID 复制模型 ID，拼成「组 ID/模型 ID」写进该智能体 .md 的 model: 字段；改完需重启引擎。
              </div>

              <div className="set-hint">模型设置保存后即时热更新生效（个别情况自动回退为重启引擎）；任务执行中不可保存。</div>

              {/* 推理强度：纯发送期参数，即时保存（只写 effort，不重载引擎） */}
              <div className="set-group">
                <div className="set-title">推理强度（effort）</div>
                <div className="set-desc">
                  在输入区模型下拉右侧显示 effort 档位（Default / Low / Medium / High）；默认档不发送任何额外字段。切换档位不重启引擎、不改配置文件。
                </div>
                <label className="set-toggle">
                  <input
                    type="checkbox"
                    checked={data.effort?.enabled !== false}
                    onChange={(e) => onEffortChange({ enabled: e.target.checked })}
                  />
                  <span className="set-toggle-track" />
                  <span className="set-toggle-label">{data.effort?.enabled !== false ? '开启' : '关闭'}</span>
                </label>
                <div className="set-label" style={{ marginTop: 12 }}>
                  新会话默认档
                </div>
                <SettingsEffortSelect
                  value={data.effort?.default || 'default'}
                  disabled={data.effort?.enabled === false}
                  onChange={(v) => onEffortChange({ default: v })}
                />
                <div className="set-hint">
                  仅影响新会话，已有会话保留自己的档位。若模型不支持该参数，切回默认即可；默认档与改造前完全一致。
                </div>
              </div>
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
                <div className="set-hint">Hub 技能列表与下载接口的地址。</div>
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
                保存后即时生效（文件树隐藏列表）；窗口尺寸需重启应用后生效。
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

              {/* 联网搜索：DeepSeek 兼容 Search API（独立于模型组 Key） */}
              <div className="set-group">
                <div className="set-label">联网搜索</div>
                <div className="set-hint">
                  配置后，AI 的 websearch 工具将固定使用此 DeepSeek 兼容搜索 API，不启用其它搜索 provider。保存时会测试 Key；未配置或验证失败将完全禁用联网搜索。Key 加密保存，保存后自动重启引擎生效。
                </div>
                <div className="set-label" style={{ marginTop: 10 }}>搜索 API 地址</div>
                <input
                  className="set-input"
                  type="text"
                  placeholder="https://api.deepseek.com/v1/tools/search"
                  value={form.websearch?.apiBase || ''}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      websearch: { ...(f.websearch || {}), apiBase: e.target.value }
                    }))
                  }
                />
                <div className="set-label" style={{ marginTop: 8 }}>搜索 API Key</div>
                <input
                  className="set-input"
                  type="password"
                  autoComplete="off"
                  placeholder={form.websearch?.apiKey ? '已保存（留空修改；清空后保存即删除）' : '输入 DeepSeek API Key'}
                  value={form.websearch?.apiKey || ''}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      websearch: { ...(f.websearch || {}), apiKey: e.target.value }
                    }))
                  }
                />
              </div>

              {/* 操作清单：每项三档（允许 / 询问 / 禁止） */}
              <div className="perm-list">
                {PERMISSION_ITEMS.map((it) => {
                  // 联网搜索只有 Key 验证通过才可配置权限；未配置/验证失败时强制显示禁止。
                  const searchBlocked = it.key === 'websearch' && form.websearch?.valid !== true
                  return (
                    <div className={'perm-item' + (searchBlocked ? ' disabled' : '')} key={it.key}>
                      <div className="perm-item-info">
                        <div className="perm-item-name">{it.label}</div>
                        <div className="perm-item-desc">
                          {searchBlocked ? '未配置或 Key 验证失败，已强制禁用' : it.desc}
                        </div>
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
                              checked={searchBlocked ? act === 'deny' : (form.permission && form.permission[it.key]) === act}
                              disabled={searchBlocked}
                              onChange={() => setPermItem(it.key, act)}
                            />
                            <span data-action={act}>{label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="set-hint">
                权限配置保存后即时热更新生效（无需重启引擎）：新会话按全局规则执行，进行中的任务不受影响；
                <br />
                注意：历史会话中曾被设为「禁止」的操作类型仍会直接拒绝，需新建会话才彻底放开。
              </div>
            </>
          ) : tab === 'stats' ? (
            <StatsPanel
              data={statsData}
              heatmap={statsHeatmap}
              heatLoading={statsHeatmapLoading}
              counters={statsCounters}
              loading={statsLoading}
              refreshing={statsRefreshing}
              error={statsError}
              partial={statsPartial}
              range={statsRange}
              onRangeChange={setStatsRange}
              onRefresh={() => refreshStats()}
            />
          ) : tab === 'about' ? (
            <>
              <div className="perm-title">关于</div>

              {/* 基础版本信息：应用名 + 右侧检查更新入口（进设置第一眼可见） */}
              <div className="set-group">
                <div className="about-head">
                  <img className="about-logo" src={ABOUT_LOGO} alt="XWork" />
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
                  <span><FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" /></span>
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
                <div className="theme-grid">
                  <button
                    className={`theme-card${theme === 'light' ? ' active' : ''}`}
                    onClick={() => onThemeChange('light')}
                  >
                    <span className="theme-preview">
                      <span className="theme-preview-bar"><i /><i /><i /></span>
                      <span className="theme-preview-body">
                        <span className="theme-preview-side" />
                        <span className="theme-preview-main">
                          <span className="theme-preview-line" />
                          <span className="theme-preview-line short" />
                        </span>
                      </span>
                    </span>
                    <span className="theme-label">亮色 <span className="theme-tick"><Check size={12} strokeWidth={2.2} aria-hidden="true" /></span></span>
                  </button>
                  <button
                    className={`theme-card${theme === 'dark' ? ' active' : ''}`}
                    onClick={() => onThemeChange('dark')}
                  >
                    <span className="theme-preview dark">
                      <span className="theme-preview-bar"><i /><i /><i /></span>
                      <span className="theme-preview-body">
                        <span className="theme-preview-side" />
                        <span className="theme-preview-main">
                          <span className="theme-preview-line" />
                          <span className="theme-preview-line short" />
                        </span>
                      </span>
                    </span>
                    <span className="theme-label">暗色 <span className="theme-tick"><Check size={12} strokeWidth={2.2} aria-hidden="true" /></span></span>
                  </button>
                </div>
              </div>

              <div className="set-group">
                <div className="set-title">流式文字效果</div>
                <div className="set-desc">
                  AI 输出时新文字的呈现方式，切换即时生效（正在输出的回复也会立刻换档），无需重启。
                </div>
                <label className="set-radio">
                  <input
                    type="radio"
                    name="streamReveal"
                    checked={(streamReveal || 'emerge') === 'emerge'}
                    onChange={() => onStreamRevealChange('emerge')}
                  />
                  <Sparkles size={14} strokeWidth={1.8} aria-hidden="true" /> 浮现（模糊 → 清晰）
                </label>
                <label className="set-radio">
                  <input
                    type="radio"
                    name="streamReveal"
                    checked={streamReveal === 'typewriter'}
                    onChange={() => onStreamRevealChange('typewriter')}
                  />
                  <Keyboard size={14} strokeWidth={1.8} aria-hidden="true" /> 打字机（逐字直出）
                </label>
              </div>

              <div className="set-group">
                <div className="set-title">关闭窗口时</div>
                <div className="set-desc">「最小化到托盘」时，关闭窗口不会退出程序，AI 任务在后台继续运行；点击托盘图标恢复窗口，右键托盘菜单可退出。</div>
                <label className="set-radio">
                  <input type="radio" name="closeAction" checked={(data.closeAction || 'quit') === 'quit'} onChange={() => onCloseActionChange('quit')} />
                  <XCircle size={14} strokeWidth={1.8} aria-hidden="true" /> 关闭程序
                </label>
                <label className="set-radio">
                  <input type="radio" name="closeAction" checked={(data.closeAction || 'quit') === 'tray'} onChange={() => onCloseActionChange('tray')} />
                  <Flag size={14} strokeWidth={1.8} aria-hidden="true" /> 最小化到系统托盘
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
        </div>
      </div>

      {/* 底部操作栏：横跨整页，内容与设置版心对齐 */}
      <div className="settings-footer">
        {tab === 'stats' ? (
          <StatsFooter
            updatedAt={statsUpdatedAt}
            loading={statsLoading || statsRefreshing}
            onRefresh={() => refreshStats()}
          />
        ) : (
          <div className="settings-footer-inner">
            <button onClick={onClose}>取消</button>
            <button onClick={handleSave}>保存</button>
            {tab === 'model' && (
              <button className="primary" disabled={busy} onClick={() => onSave(form, true)}>
                保存并生效
              </button>
            )}
          </div>
        )}
      </div>

      {/* 测试连接结果漂浮气泡：跟随测试按钮弹出；成功自动消失，失败手动关闭 */}
      {bubble && (
        <div
          className={`test-bubble ${bubble.status}${bubble.leaving ? ' leaving' : ''}`}
          style={{ top: bubble.top, bottom: bubble.bottom, right: bubble.right }}
          role="status"
        >
          <span>
            {bubble.status === 'ok' ? (
              <CheckCircle2 size={13} strokeWidth={2} aria-hidden="true" />
            ) : (
              <XCircle size={13} strokeWidth={2} aria-hidden="true" />
            )}
            {bubble.status === 'ok' ? bubble.text || '连接正常' : bubble.error || '连接失败'}
          </span>
          {bubble.status === 'fail' && (
            <button className="test-bubble-close" onClick={() => setBubble(null)} title="关闭">
              <X size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// 兜底的模式选项：引擎未运行 / 列表读取失败 / 首次加载完成前使用。
// 标签与描述必须和 BUILTIN_AGENT_ZH 里的 build / plan 完全一致，否则下拉框会在
// "引擎就绪前后"显示两种不同写法（先回退项、后真实列表），看起来像闪变。
// 注意 id 必须是引擎内置的真实 id（build / plan），否则选中后引擎无法路由。
const AGENT_OPTIONS_FALLBACK = [
  { id: 'build', label: 'Build - 执行', desc: '默认智能体：按配置的权限直接改文件、跑命令，干活的默认选择' },
  { id: 'plan', label: 'Plan - 规划', desc: '只读智能体：只探索代码、给出方案，不改任何文件、不执行命令' }
]

// 智能体列表加载时，选择器上的转圈至少显示这么久，避免"闪一下"反而更晃眼
const AGENTS_SPINNER_MIN_MS = 400

// 引擎内置智能体的中文名与中文描述。
// 为什么需要：引擎 /api/agent 返回的 name/description 全是英文（如 "The default agent. Executes
// tools based on configured permissions."），在中文界面里既难认也难选。
// 命名格式沿用界面既有习惯「英文 - 中文」：Build - 执行。id 保持不变（引擎按 id 路由，改了会失效）。
// 未登记的内置项（引擎升级后新增）自动回退为引擎原文，不会因为缺条目而显示空白。
// desc 约定：① 越短越好（下拉项只有两行，超长会被 ellipsis 截断，实测约 31 字为限）。
// ② 措辞按「任何任务都能对上号」写 —— XWork 也用于文档、报表、资料整理，避免代码 / TDD /
//    部署门禁这类专有说法（用户明确要求）。仅 build/plan 会出现在主模式列表，其余（general /
//    explore / 5 个流水线子智能体）只出现在「子智能体（只读）」名册里。
const BUILTIN_AGENT_ZH = {
  build: { zh: '执行', desc: '默认智能体：按配置的权限直接改文件、跑命令，干活的默认选择' },
  plan: { zh: '规划', desc: '只读智能体：只探索代码、给出方案，不改任何文件、不执行命令' },
  general: { zh: '通用', desc: '通用智能体：多步骤调研与执行，适合开放式任务' },
  explore: { zh: '探索', desc: '快速摸清目录或项目：有什么、关键内容在哪' },
  'code-reviewer': { zh: '代码审查', desc: '审查改动：结构、规范与可维护性，给出通过或需修改的结论' },
  'feature-implementer': { zh: '功能实现', desc: '把需求落成具体结果：范围最小、随做随验' },
  'deploy-agent': { zh: '部署', desc: '执行交付流程：校验、打包、发布与发布后确认' },
  'report-agent': { zh: '报告', desc: '汇总过程与证据，产出最终报告' },
  'test-creator': { zh: '测试', desc: '为改动补验证：先复现问题，再确认已修好' }
}

// 模式选择器：与模型选择器同款交互（按钮 + 向上弹出的选项列表），位于模型选择器左侧
// options：来自引擎注册表（主进程 agents:list），含工作区 .agents 里发现的自定义智能体；
//          为 null/空时回退到内置两项，保证输入区始终可用。
// loading：列表加载中（引擎启动后注册表要 2~4 秒才收敛）。此时按钮显示转圈并禁用，
//          只锁选择器本身；输入框、发送、对话内容都不受影响（不锁整页）。
function AgentPicker({ value, onPick, options, loading }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const popRef = useRef(null)
  // 加载中强制收起已展开的菜单（列表即将替换，留着会显示过期条目）
  useEffect(() => {
    if (loading) setOpen(false)
  }, [loading])
  // 每次打开都回到顶部：条目多时可滚动，若停留在上次的滚动位置会看不到第一项
  useEffect(() => {
    if (open && popRef.current) popRef.current.scrollTop = 0
  }, [open])
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

  // 组装选项：**主模式（可切换）+ 只读子智能体名册**（设计 §5.5(b)(c) / M-1 / v2-B-4）
  //   · 主模式 = `mode !== 'subagent'`（含 primary 与 all）；`hidden` 已在主进程整形层过滤（本层不重复过滤）
  //   · 只读名册 = `mode !== 'primary'`（含 subagent 与 all）—— 两侧都覆盖 'all'，不会出现"两个清单都进不去"
  //   · 硬前置：`agents-list.js` 的整形必须先把 mode 保留为原值（否则 'all' 到这里已变成 'subagent'）
  const items = useMemo(() => {
    const src = Array.isArray(options) && options.length ? options : null
    if (!src) return AGENT_OPTIONS_FALLBACK
    const mapOne = (a) => {
      if (a.source === 'custom') {
        // 工作区自定义：保留用户自己写的 name/description 原文，只标注来源
        return {
          id: a.id,
          label: `${a.name}（.agents）`,
          desc: a.description || (a.mode === 'primary' ? '主智能体' : '子智能体'),
          group: 'custom'
        }
      }
      // 引擎内置：改用中文名（英文 - 中文）与中文描述；未登记的 id 回退引擎原文
      const zh = BUILTIN_AGENT_ZH[a.id]
      return {
        id: a.id,
        label: zh ? `${a.name} - ${zh.zh}` : a.name,
        desc: zh ? zh.desc : a.description || (a.mode === 'primary' ? '主智能体' : '子智能体'),
        group: 'builtin'
      }
    }
    const customMains = src.filter((a) => a.mode !== 'subagent' && a.source === 'custom').map(mapOne)
    const builtinMains = src.filter((a) => a.mode !== 'subagent' && a.source !== 'custom').map(mapOne)
    // 只读名册里同样把内置子智能体本地化：名称「英文名 - 中文名」（与主模式一致）。
    // 描述换成一句简短中文（引擎原文是整段英文说明，单行 ellipsis 下只能看到半句）。
    // 工作区自定义项保持用户原文（含「（工作区 .agents）」来源标注），未登记的内置 id 回退引擎原文。
    const roster = src
      .filter((a) => a.mode !== 'primary')
      .map((a) => {
        const zh = a.source === 'custom' ? null : BUILTIN_AGENT_ZH[a.id]
        const model = a.model && a.model.modelID ? ` · ${a.model.modelID}` : ''
        return {
          key: 'ro:' + a.id, // 与主模式项可能同 id（mode:'all'）⇒ key 必须区分，否则 React 重复 key
          id: a.id,
          label: (zh ? `${a.name} - ${zh.zh}` : a.name) + model,
          desc: zh
            ? zh.desc
            : `${a.description || '子智能体'}${a.source === 'custom' ? '（工作区 .agents）' : '（引擎内置）'}`,
          group: 'roster',
          readOnly: true
        }
      })
    const out = []
    const both = customMains.length > 0 && builtinMains.length > 0
    out.push({ group: 'header', label: both || customMains.length ? '工作区 .agents' : '主模式（引擎内置）' })
    for (const x of customMains) out.push(x)
    if (both) out.push({ group: 'header', label: '引擎内置' })
    for (const x of builtinMains) out.push(x)
    if (roster.length) {
      out.push({ group: 'header', label: '子智能体（只读）' })
      for (const x of roster) out.push(x)
      out.push({ group: 'hint', label: '子智能体由 AI 在需要时自动派发' })
    }
    return out
  }, [options])

  // 当前值可能不在列表里（例如引擎未运行被回退、或该智能体文件被删除）——仍要照原样显示，
  // 否则按钮会默默变回 Build，让用户误以为自己选中的智能体已生效。
  // 只取 label / desc 两个字符串（不构造对象），避免打包器裁剪掉未使用字段造成歧义。
  const curItem = items.find((a) => a.id === value)
  const curLabel = curItem ? curItem.label : value || 'Build - 执行'
  const curDesc = curItem ? curItem.desc : '（该智能体不在当前列表中）'

  return (
    <div className="model-picker" ref={ref}>
      <button
        className={`model-pick-btn ${loading ? 'is-loading' : ''}`}
        onClick={() => !loading && setOpen(!open)}
        disabled={loading}
        title={
          loading
            ? '正在加载智能体列表…（引擎启动后需要几秒扫描工作区 .agents）'
            : `本次对话的智能体：${curLabel}${curDesc ? ' — ' + curDesc : ''}（带「.agents」标注的来自工作区 .agents/agents）`
        }
      >
        {loading ? (
          <>
            <span className="mp-spinner" />
            <span className="mp-label">正在加载 Agent…</span>
          </>
        ) : (
          <>
            <span className="mp-label">{curLabel}</span>
            <span className="mp-arrow">
          {open ? <ChevronUp size={10} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={10} strokeWidth={2} aria-hidden="true" />}
        </span>
          </>
        )}
      </button>
      {open && !loading && (
        <div className="model-pop" ref={popRef}>
          {items.map((a, i) => {
            if (a.group === 'header') {
              // 分组标题（工作区 .agents / 引擎内置 / 子智能体（只读））—— key 用下标，标题本身无 id
              return (
                <div className="mp-opt-group" key={'g' + i}>
                  {a.label}
                </div>
              )
            }
            if (a.group === 'hint') {
              // 固定小字说明（如「子智能体由 AI 在需要时自动派发」）
              return (
                <div className="mp-opt-hint" key={'h' + i}>
                  {a.label}
                </div>
              )
            }
            if (a.readOnly) {
              // 只读名册项：不可切换（设计 §5.5(c)），只展示名称/模型/描述
              return (
                <div className="mp-opt-ro" key={a.key || a.id} title="子智能体由 AI 在需要时自动派发，不可直接选择">
                  <div className="mp-opt-title">{a.label}</div>
                  {a.desc && <div className="mp-opt-desc">{a.desc}</div>}
                </div>
              )
            }
            return (
              <button
                key={a.key || a.id}
                className={`model-opt ${value === a.id ? 'active' : ''}`}
                onClick={() => {
                  onPick(a.id)
                  setOpen(false)
                }}
              >
                <div className="mp-opt-title">{a.label}</div>
                {a.desc && <div className="mp-opt-desc">{a.desc}</div>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 模型选择器：按钮 + 向上弹出的选项列表（位于输入框右下角发送按钮左侧）
function ModelPicker({ models, value, onPick }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const [pos, setPos] = useState(null) // 菜单 fixed 定位（相对按钮）
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
  // 菜单经 portal 渲染到 body（弹窗容器裁剪不到），按按钮位置固定定位、向上弹出
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const btn = ref.current?.querySelector('.model-pick-btn')
      if (!btn) return
      const r = btn.getBoundingClientRect()
      setPos({
        right: Math.max(8, window.innerWidth - r.right),
        bottom: Math.max(8, window.innerHeight - r.top + 8)
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
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
        <span className="mp-arrow">
          {open ? <ChevronUp size={10} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={10} strokeWidth={2} aria-hidden="true" />}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div className="model-pop" style={{ position: 'fixed', right: pos.right, bottom: pos.bottom }}>
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
          </div>,
          document.body
        )}
    </div>
  )
}

// 推理强度选择器：交互与 ModelPicker 完全一致（自定义菜单 + portal + 向上弹出），仅文案/选项不同
function EffortPicker({ value, onPick, disabled, reason }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
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
  // 禁用时收起菜单（例如切会话后功能被关闭）
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  // 菜单经 portal 渲染到 body（弹窗容器裁剪不到），按按钮位置固定定位、向上弹出
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const btn = ref.current?.querySelector('.model-pick-btn')
      if (!btn) return
      const r = btn.getBoundingClientRect()
      setPos({
        right: Math.max(8, window.innerWidth - r.right),
        bottom: Math.max(8, window.innerHeight - r.top + 8)
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])
  const current = EFFORT_OPTIONS.find((o) => o.value === value) || EFFORT_OPTIONS[0]
  return (
    <div className="model-picker effort-picker" ref={ref}>
      <button
        className="model-pick-btn"
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen(!open)
        }}
        title={disabled ? reason || '推理强度不可用' : current.hint}
      >
        <span className="mp-label">{disabled ? '—' : current.label}</span>
        <span className="mp-arrow">
          {open ? <ChevronUp size={10} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={10} strokeWidth={2} aria-hidden="true" />}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div className="model-pop effort-pop" style={{ position: 'fixed', right: pos.right, bottom: pos.bottom }}>
            {EFFORT_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`model-opt ${o.value === value ? 'active' : ''}`}
                title={o.hint}
                onClick={() => {
                  onPick(o.value)
                  setOpen(false)
                }}
              >
                {o.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}

// 设置页「新会话默认档」下拉：复用模型下拉的按钮/菜单视觉，全宽、向下弹出
function SettingsEffortSelect({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
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
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const btn = ref.current?.querySelector('.model-pick-btn')
      if (!btn) return
      const r = btn.getBoundingClientRect()
      // 设置页底部空间不足时向上展开，避免菜单落到窗口外
      const openAbove = r.top > 180 && r.bottom + 180 > window.innerHeight
      setPos({
        left: r.left,
        width: r.width,
        top: openAbove ? 'auto' : r.bottom + 6,
        bottom: openAbove ? Math.max(8, window.innerHeight - r.top + 6) : 'auto'
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])
  const current = EFFORT_OPTIONS.find((o) => o.value === value) || EFFORT_OPTIONS[0]
  return (
    <div className="model-picker settings-effort-picker" ref={ref}>
      <button
        className="model-pick-btn settings-select-btn"
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen(!open)
        }}
        title="新会话默认推理强度"
      >
        <span className="mp-label">{current.label}</span>
        <span className="mp-arrow">
          {open ? <ChevronUp size={10} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={10} strokeWidth={2} aria-hidden="true" />}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="model-pop settings-select-pop"
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              bottom: pos.bottom,
              width: pos.width,
              right: 'auto'
            }}
          >
            {EFFORT_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`model-opt ${o.value === value ? 'active' : ''}`}
                title={o.hint}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                <span className="mp-opt-title">{o.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}

// 工作区选择下拉：交互/动画与「选择模型」一致（自定义菜单 + portal + 弹出动画）
// 差异：支持自定义宽度（className），菜单向右下弹出（左对齐于按钮、位于按钮下方、宽度跟随按钮）
function WorkspacePicker({ workspaces, value, onPick, onAdd, className }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
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
  // 菜单经 portal 渲染到 body，fixed 定位：左对齐按钮、按钮下方弹出（空间不足时翻转到上方），宽度跟随按钮
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const btn = ref.current?.querySelector('.model-pick-btn')
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const menuH = 260
      const top = r.bottom + 4 + menuH > window.innerHeight - 8 ? Math.max(8, r.top - menuH - 4) : r.bottom + 4
      setPos({
        left: Math.max(8, r.left),
        top,
        width: Math.max(r.width, 220)
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])
  const current = workspaces.find((w) => w.dir === value)
  // 顶部固定「选择新的工作区」：系统文件夹选择 → 登记注册表 → 通知父组件刷新列表并选中
  const pickNewWorkspace = async () => {
    if (busy) return
    setBusy(true)
    try {
      const dir = await window.xwork.workspacePick()
      if (!dir) return
      const res = await window.xwork.workspaceRegister(dir)
      if (res?.ok === false) {
        console.warn('[ws] register failed:', res?.error)
        return
      }
      onAdd?.(dir)
      onPick(dir)
    } catch (e) {
      console.warn('[ws] pick new workspace failed:', e.message)
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }
  return (
    <div className={'model-picker ' + (className || '')} ref={ref}>
      <button className="model-pick-btn" onClick={() => setOpen(!open)} title="任务执行的工作区">
        <span className="mp-label">{current ? current.name + '（' + current.dir + '）' : '选择工作区'}</span>
        <span className="mp-arrow">
          {open ? <ChevronUp size={10} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={10} strokeWidth={2} aria-hidden="true" />}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="model-pop"
            style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, bottom: 'auto', right: 'auto' }}
          >
            <button
              className="model-opt model-opt-new"
              onClick={pickNewWorkspace}
              title="打开文件夹选择界面，选择一个全新的文件夹作为任务工作区"
            >
              <span className="mp-new-icon">＋</span>选择新的工作区
            </button>
            {workspaces.length === 0 ? (
              <div className="model-pop-empty">暂无可用工作区</div>
            ) : (
              workspaces.map((w) => (
                <button
                  key={w.dir}
                  className={`model-opt ${current && current.dir === w.dir ? 'active' : ''}`}
                  onClick={() => {
                    onPick(w.dir)
                    setOpen(false)
                  }}
                >
                  {w.name}（{w.dir}）
                </button>
              ))
            )}
          </div>,
          document.body
        )}
    </div>
  )
}

// 工具调用卡片（任务执行面板）
// memo：part 为消息 part 引用（delta 只替换变化的 part），未变化的工具卡不重渲染
// 输入/输出默认截断展示（超过 LIMIT 字显示前段 + "展开全文"按钮），展开后直接渲染完整值，
// 因此工具执行中展开可实时看到最新输出（每次 part 状态更新本组件会重渲染取到最新 output）
// 工具调用的输入/输出明细 —— 对话列表的 <ToolChip> 使用这一份，
// 避免两处实现漂移（800 字截断 + 展开全文 + 执行中占位 + 失败时的错误文案）。
const ToolIOView = memo(function ToolIOView({ part }) {
  const [expIn, setExpIn] = useState(false)
  const [expOut, setExpOut] = useState(false)
  const st = part.state?.status || 'pending'
  const input = part.state?.input
  const output = part.state?.output ?? part.state?.metadata?.output ?? ''
  const err = part.state?.error
  const errText = err ? (typeof err === 'string' ? err : err.message || '') : ''
  const LIMIT = 800
  const toStr = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  const needExpand = (v) => toStr(v).length > LIMIT
  const fmt = (v, full) => {
    const s = toStr(v)
    return full || s.length <= LIMIT ? s : s.slice(0, LIMIT) + '\n…（已截断）'
  }
  return (
    <div className="tool-body">
      {input ? (
        <div className="tool-field">
          <div className="field-label">输入</div>
          <pre>{fmt(input, expIn)}</pre>
          {needExpand(input) && (
            <button className="tool-expand" onClick={() => setExpIn(!expIn)}>
              {expIn ? '收起' : '展开全文'}
            </button>
          )}
        </div>
      ) : null}
      {output ? (
        <div className="tool-field">
          <div className="field-label">输出</div>
          <pre>{fmt(output, expOut)}</pre>
          {needExpand(output) && (
            <button className="tool-expand" onClick={() => setExpOut(!expOut)}>
              {expOut ? '收起' : '展开全文'}
            </button>
          )}
        </div>
      ) : st === 'running' ? (
        <div className="tool-field">
          <div className="field-label">输出</div>
          <div className="running-dots">执行中…</div>
        </div>
      ) : null}
      {errText ? (
        <div className="tool-field">
          <div className="field-label">错误</div>
          <pre className="tool-err">{errText}</pre>
        </div>
      ) : null}
    </div>
  )
})

// 对话列表里的工具调用：`[工具] read · 完成` 芯片，点击展开输入/输出（用户 2026-10-19 要求）。
// 展开/收起动画与「思考过程」「子智能体卡片」同款：grid 行 0fr→1fr（0.28s），
// 收起时延迟 300ms 卸载内容，否则 1fr→0fr 会因内容被立刻移除而"啪"地消失。
const ToolChip = memo(function ToolChip({ part }) {
  const [open, setOpen] = useState(false)
  const [renderBody, setRenderBody] = useState(false)
  const pauseScrollFollow = useContext(ScrollFollowControlContext)
  useEffect(() => {
    if (open) {
      setRenderBody(true)
      return
    }
    const timer = setTimeout(() => setRenderBody(false), 300)
    return () => clearTimeout(timer)
  }, [open])
  const st = part.state?.status || ''
  const input = part.state?.input || {}
  const time = part.state?.time || {}
  const target =
    input.filePath || input.path || input.command || input.pattern || input.query || input.description || ''
  const dur = fmtDur(time.start, time._tEnd || time.end)
  const icon =
    part.tool === 'bash' || part.tool === 'shell' ? (
      <Terminal size={13} strokeWidth={1.8} aria-hidden="true" />
    ) : part.tool === 'write' || part.tool === 'edit' ? (
      <Pencil size={13} strokeWidth={1.8} aria-hidden="true" />
    ) : part.tool === 'read' ? (
      <FileText size={13} strokeWidth={1.8} aria-hidden="true" />
    ) : part.tool === 'grep' || part.tool === 'glob' ? (
      <Search size={13} strokeWidth={1.8} aria-hidden="true" />
    ) : part.tool === 'todowrite' ? (
      <ListChecks size={13} strokeWidth={1.8} aria-hidden="true" />
    ) : (
      <Wrench size={13} strokeWidth={1.8} aria-hidden="true" />
    )
  const mark =
    st === 'completed' ? (
      <Check size={12} strokeWidth={2} aria-hidden="true" />
    ) : st === 'error' ? (
      <X size={12} strokeWidth={2} aria-hidden="true" />
    ) : st === 'running' ? (
      <Loader2 className="icon-spin" size={12} strokeWidth={2} aria-hidden="true" />
    ) : null
  return (
    <div className="tool-row-wrap">
      <button
        className={`tool-row ${st}${open ? ' open' : ''}`}
        onClick={() => {
          // 高度过渡必须只改变布局，不触发贴底滚动；否则上方内容会被顶走并在收起时跳回。
          pauseScrollFollow?.()
          setOpen((o) => !o)
        }}
        title={open ? '收起输入/输出' : '查看输入/输出'}
      >
        <span className="tool-ic">{icon}</span>
        <span className="tool-name">{part.tool}</span>
        {target ? (
          <span className="tool-target" title={String(target)}>
            {target}
          </span>
        ) : null}
        {dur ? <span className="tool-time">{dur}</span> : null}
        <span className={`tool-check ${st}`}>{mark}</span>
      </button>
      <div className={`tool-chip-expand${open ? ' open' : ''}`}>
        <div className="tool-chip-expand-inner">{renderBody ? <ToolIOView part={part} /> : null}</div>
      </div>
    </div>
  )
})

// AI 思考过程：可折叠区块，展开/收起带高度过渡动画（grid 0fr→1fr，纯 CSS 无需测量高度）
// 流式进行中强制展开（与 <details open={streaming}> 行为一致），结束后按用户选择
// 思考文本内部独立滚动：贴底时跟随最新思考内容，上滑后停止跟随，滚回底部恢复
function ReasoningBlock({ text, streaming }) {
  const [open, setOpen] = useState(streaming === true)
  const touchedRef = useRef(false) // 用户点过后，自动开/关不再覆盖用户选择
  const isOpen = open
  const innerRef = useRef(null)
  const stickRef = useRef(true)
  useEffect(() => {
    // 单段思考开始自动展开、结束自动收起；用户手动操作过则保持用户状态。
    if (!touchedRef.current) setOpen(streaming === true)
  }, [streaming])
  useEffect(() => {
    const el = innerRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div className="reasoning">
      <button
        className={`reasoning-summary${isOpen ? ' open' : ''}`}
        onClick={() => {
          touchedRef.current = true
          setOpen((o) => !o)
        }}
      >
        <ChevronRight className="reasoning-caret" size={11} strokeWidth={2} aria-hidden="true" />
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

// memo：delta 流式只替换变化的 message 对象（未变消息引用稳定），
// 配合 useCallback 的 onCopy/onUndo 与原始值 canUndo/busy，无关消息不再重渲染（含 marked 解析）
// 子智能体完成通知条（bridge 由 synthetic 映射而来，role='system'）
// 设计 §5.4(d)：本组件是 batch 1 的最小可用形态（batch 4 会升级为与 L1 卡片同款外观）；
// 两个要点必须守住：① 缺失 subagentNotice 时【不渲染空气泡】，回落为剥壳后的纯文本；
// ② 状态文案走 §5.8 的映射表（completed/error/cancelled → 完成/失败/已取消）。
const SUBAGENT_NOTICE_LABEL = { completed: '完成', error: '失败', cancelled: '已取消' }
function SubagentNoticeRow({ m }) {
  const partNotice = (m.parts || []).map((p) => p.subagentNotice).find(Boolean)
  const notice = m.subagentNotice || partNotice || null
  const rawText = (m.parts || []).map((p) => (p.type === 'synthetic' || p.type === 'text' ? p.text || '' : '')).join('')
  const body = notice ? '' : unwrapSubagentOutput(rawText).text
  const label = notice ? SUBAGENT_NOTICE_LABEL[notice.state] || notice.state || '状态未知' : '状态未知'
  // 去重（设计 §5.3 第 8 点）：**tool part 是权威** —— 若本会话已存在该子会话的卡片，
  // 通知条只留一行"已并入上方卡片"，避免同一件事出现两张卡
  if (notice && notice.childID && subagentLive.isKnownChild(notice.childID)) {
    return (
      <div className="row assistant">
        <div className="bubble assistant">
          <div className="tool-chip completed subagent-notice"><Bot size={13} strokeWidth={1.8} aria-hidden="true" /> 后台完成通知已并入上方子智能体卡片</div>
        </div>
      </div>
    )
  }
  return (
    <div className="row assistant">
      <div className="bubble assistant">
        <div className="tool-chip completed">
          <Bot size={13} strokeWidth={1.8} aria-hidden="true" /> 子智能体{notice?.agent ? ` · ${notice.agent}` : ''} · 后台{label}
          {notice?.description ? ` · ${notice.description}` : ''}
        </div>
        {body ? <div style={{ whiteSpace: 'pre-wrap' }}>{body}</div> : null}
      </div>
    </div>
  )
}

// 子会话时间线里的单条消息（`MessageView` 的精简变体）：
// 设计 §5.2 明确要求 **去掉「回退至此」、去掉复制按钮**（语义危险 + 子会话不是用户会话）
function SubagentChildMsg({ m }) {
  const md = (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text || '').join('\n')
  if (m.role === 'user') {
    return <div className="subagent-child-user">{md}</div>
  }
  return (
    <div className="subagent-child-msg">
      {(m.parts || []).map((p, i) =>
        p.type === 'reasoning' ? <ReasoningBlock key={'r' + i} text={p.text} streaming={!!m.streaming} /> : null
      )}
      {md.trim() ? <div className="md-body" dangerouslySetInnerHTML={{ __html: marked.parse(md) }} /> : null}
      {(m.parts || []).map((p, i) =>
        p.type === 'tool' ? <ToolChip key={'t' + i} part={p} /> : null
      )}
    </div>
  )
}

// 展开态：子会话全过程（就地时间线）
//   基线 = messageList 快照；增量 = 事件镜像（subagentStream）；兜底 = 仅断流时轮询（设计 §5.7 / S-6）
const SubagentChildView = memo(function SubagentChildView({ childSid, agent }) {
  const sub = useCallback((cb) => subagentStream.subscriber(childSid)(cb), [childSid])
  const snap = useCallback(() => subagentStream.get(childSid), [childSid])
  const messages = useSyncExternalStore(sub, snap, () => null)
  const [visible, setVisible] = useState(TOOL_PAGE)
  const [err, setErr] = useState('')
  const [pollErr, setPollErr] = useState('')
  const failRef = useRef(0)
  const lastEventRef = useRef(0)
  const t = subagentLive.timings() || {}

  useEffect(() => {
    let alive = true
    window.xwork
      .messageList(childSid)
      .then((rows) => {
        if (!alive) return
        const snapshot = normalize(rows)
        const current = subagentStream.get(childSid) || []
        subagentStream.seed(childSid, current.length ? mergeChildSnapshot(current, snapshot) : snapshot)
      })
      .catch((e) => {
        if (alive) setErr('加载子会话失败：' + ((e && e.message) || String(e)))
      })
    // 仅终态回收；运行中收起后保留镜像，保证再次展开不出现半截正文。
    return () => {
      alive = false
      const live = subagentLive.get(childSid)
      const terminal = !!(
        live && (live.phase === PHASE.completed || live.phase === PHASE.failed || live.phase === PHASE.cancelled)
      )
      if (terminal) subagentStream.drop(childSid)
    }
  }, [childSid])

  useEffect(() => {
    // 兜底轮询（设计 §5.7 / S-6）：**事件镜像为主**，只有"距最后一条事件超过 staleMs"才拉快照；
    // 连续失败达 subagentPollFailMaxCount 即停止并提示（⑤）——否则引擎已死时这里会无限空转
    const maxFail = t.subagentPollFailMaxCount ?? 3
    const tick = async () => {
      const live = subagentLive.get(childSid)
      const terminal = !!(
        live &&
        (live.phase === PHASE.completed || live.phase === PHASE.failed || live.phase === PHASE.cancelled)
      )
      const lastAt = subagentStream.lastEventAt(childSid)
      if (lastAt !== lastEventRef.current) {
        // 事件流仍在推进 ⇒ 失败计数归零（"连续失败"才算数）
        lastEventRef.current = lastAt
        if (failRef.current) failRef.current = 0
      }
      const verdict = pollDecision({
        terminal,
        sinceEventMs: Date.now() - lastAt,
        staleMs: t.subagentStaleMs ?? 8000,
        failCount: failRef.current,
        maxFail
      })
      if (verdict !== 'poll') return
      try {
        const rows = await window.xwork.messageList(childSid)
        failRef.current = 0
        const snapshot = normalize(rows)
        const current = subagentStream.get(childSid) || []
        subagentStream.seed(childSid, current.length ? mergeChildSnapshot(current, snapshot) : snapshot)
        setPollErr('')
      } catch (e) {
        failRef.current++
        if (failRef.current >= maxFail) {
          setPollErr(`子会话过程读取连续失败 ${failRef.current} 次，已停止重试（${(e && e.message) || e}）`)
        }
      }
    }
    const iv = setInterval(tick, t.subagentPollMs ?? 1500)
    return () => clearInterval(iv)
  }, [childSid, t.subagentPollMs, t.subagentStaleMs, t.subagentPollFailMaxCount])

  const list = messages || []
  const shown = list.slice(-visible) // 有界 DOM：只渲染最近 N 条 + 加载更早（§5.7）
  const live = subagentLive.get(childSid)
  const report = (live && live.finalText) || ''
  return (
    <div className="subagent-child">
      <div className="subagent-child-meta">
        <span title={childSid}>子智能体过程{agent ? ` · ${agent}` : ''}</span>
        <button className="tool-expand" onClick={() => window.xwork.copyText(childSid)}>
          复制会话 ID
        </button>
      </div>
      {visible < list.length && (
        <button className="tool-expand" onClick={() => setVisible((v) => v + TOOL_PAGE)}>
          加载更早 {list.length - visible} 条
        </button>
      )}
      {err ? <div className="subagent-error">{err}</div> : null}
      {pollErr ? <div className="subagent-error">{pollErr}</div> : null}
      {!err && shown.length === 0 ? <div className="subagent-activity">加载中…</div> : null}
      {shown.map((m, i) => (
        <SubagentChildMsg key={m.id || i} m={m} />
      ))}
      <div className="subagent-child-actions">
        <button className="tool-expand" onClick={() => window.xwork.copyText(report)} disabled={!report}>
          复制报告
        </button>
      </div>
    </div>
  )
})

// ── 子智能体卡片（对话列表内联）────────────────
// props 刻意只有【稳定的 part 引用】：摘要经 store 自订阅进入，否则 memo 化的
// MessageView 会因每次节流 setState 而全部失效（v2-B-4）。
const SubagentCard = memo(function SubagentCard({ part, parentSid }) {
  const st = part.state || {}
  const childSid = childSessionId(st)
  const sub = useCallback((cb) => (childSid ? subagentLive.subscriber(childSid)(cb) : () => {}), [childSid])
  const snap = useCallback(() => (childSid ? subagentLive.get(childSid) : null), [childSid])
  const live = useSyncExternalStore(sub, snap, snap)
  const [open, setOpen] = useState(false)
  // 收起动画的延迟卸载：CSS 过渡（grid 0fr↔1fr，0.28s）需要内容在过渡期间仍然存在，
  // 否则 React 一撤内容，"1fr→0fr" 就没有主体、看起来是瞬间消失（展开方向不受影响）
  const [renderContent, setRenderContent] = useState(false)
  useEffect(() => {
    if (open) {
      setRenderContent(true)
      return
    }
    const timer = setTimeout(() => setRenderContent(false), 300)
    return () => clearTimeout(timer)
  }, [open])
  const [abortErr, setAbortErr] = useState('')
  const [bgBusy, setBgBusy] = useState(false)
  const t = subagentLive.timings() || {}
  const input = st.input || {}
  // phase 在渲染期重算（而不是只读 store 里的缓存值）：这样"心跳"带来的时间推进
  // 才能让 finalizing 宽限、outcome 纠偏、超时降级 unknown 生效（设计 §5.1 / §5.7）
  const phase = judgePhase({
    partState: st,
    live,
    generation: subagentLive.getGeneration(),
    outcome: childSid ? subagentLive.outcomeOf(childSid) : '',
    graceMs: t.subagentOutcomeGraceMs,
    unknownAfterMs: t.subagentUnknownAfterMs
  })
  const level = identityLevel(st)
  const name = input.agent || (live && live.agent) || (level === 2 ? '未知子智能体' : '')
  const desc = input.description || (live && live.description) || ''
  const time = st.time || {}
  // 后台任务的耗时以通知到达时间为终点（引擎在后台化时就定住了 time.end，会显示成 2s 而不是真实的 45s）
  const dur = fmtDur(time.start, (live && live.noticeAt) || time._tEnd || time.end)
  const activity = (live && live.lastText) || (phase === PHASE.running ? '执行中…' : '')
  const conclusion = phase === PHASE.completed ? conclusionText({ partState: st, live }).text : ''
  const errText =
    phase === PHASE.failed || phase === PHASE.cancelled ? (live && live.errorText) || String(st.error || '') : ''
  const counts = live && (live.steps || live.toolCount) ? `第 ${live.steps || 0} 步 · ${live.toolCount || 0} 次工具调用` : ''
  // 头像底色：来自名册的 agent.color（§5.6 / v2-S-1 白名单校验；无值回落 CSS 的 color-mix 主题色）
  const avatarColor = safeAgentColor((subagentLive.agentRosterOf(name) || {}).color)
  const onAbort = () => {
    if (!childSid) return
    window.xwork.messageAbort(childSid).catch((e) => {
      setAbortErr('终止失败：' + ((e && e.message) || String(e)))
      setTimeout(() => setAbortErr(''), 4000)
    })
  }
  // 移到后台（T0-③ 实测：前置条件是子智能体**已开始执行自己的工具**，否则引擎返回 204 但无效果）
  const canBackground = phase === PHASE.running && ((live && live.toolCount) || 0) > 0 && !!parentSid
  const onMoveToBackground = () => {
    if (!parentSid || bgBusy) return
    setBgBusy(true)
    window.xwork
      .sessionBackground(parentSid)
      .catch((e) => {
        setAbortErr('移到后台失败：' + ((e && e.message) || String(e)))
        setTimeout(() => setAbortErr(''), 4000)
      })
      .finally(() => setBgBusy(false))
  }
  return (
    <div className={`subagent-card ${phase}`}>
      <div className="subagent-head">
        {phase === PHASE.running ? <span className="subagent-dot" /> : null}
        <span className="subagent-avatar" style={avatarColor ? { background: avatarColor } : undefined}>
          <Bot size={14} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span className="subagent-name">子智能体{name ? ` · ${name}` : ''}</span>
        <span className={`tool-status ${statusClassOf(phase)}`}>{phaseLabel(phase)}</span>
        {dur ? <span className="tool-time">{dur}</span> : null}
      </div>
      {desc ? <div className="subagent-desc">{desc}</div> : null}
      {activity ? <div className="subagent-activity">{activity}</div> : null}
      {errText ? <div className="subagent-error">{errText.slice(0, 200)}</div> : null}
      {conclusion ? <div className="subagent-conclusion">结论：{conclusion}</div> : null}
      <div className="subagent-actions">
        <button
          className={`tool-expand subagent-toggle${open ? ' open' : ''}`}
          onClick={() => setOpen((o) => !o)}
          title={open ? '收起子智能体过程' : '展开子智能体过程'}
        >
          <ChevronRight className="subagent-caret" size={11} strokeWidth={2} aria-hidden="true" />
          {open ? '收起' : '展开'}
          {counts ? `（${counts}）` : ''}
        </button>
        {canTerminate(phase) && childSid ? (
          <button className="tool-expand" onClick={onAbort}>
            终止
          </button>
        ) : null}
        {canBackground ? (
          <button
            className="tool-expand"
            onClick={onMoveToBackground}
            disabled={bgBusy}
            title="让子智能体继续在后台跑，父会话不再等待；完成后会收到通知"
          >
            {bgBusy ? '移到后台…' : '移到后台'}
          </button>
        ) : null}
        {abortErr ? <span className="subagent-error">{abortErr}</span> : null}
      </div>
      {/* 展开/收起动画：与「思考过程」同款（.reasoning-body 的 grid 行 0fr→1fr），
          无需测量内容高度；wrapper 始终渲染，只切 open 类，过渡才有起始态 */}
      <div className={`subagent-expand${open ? ' open' : ''}`}>
        <div className="subagent-expand-inner">
          {renderContent
            ? level === 1 && childSid
              ? (
                  <SubagentChildView childSid={childSid} agent={name} />
                )
              : // 二级降级：连子会话 id 都没有 ⇒ 展开为原始输入/输出（不猜测、不编造过程）
                <pre className="subagent-raw">
                  {JSON.stringify({ input: st.input, output: st.output, error: st.error }, null, 2)}
                </pre>
            : null}
        </div>
      </div>
    </div>
  )
})

const MessageView = memo(function MessageView({ m, showName = true, onCopy, onUndo, canUndo, gitAvailable, busy, readOnly, parentSid }) {
  const mdText = m.parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n')
  // 子智能体通知条必须在 user/assistant 分支【之前】返回：否则 role='system' 会落进 assistant 分支，
  // 由于它没有 text part（mdText 为空）而渲染成一个空白气泡（设计 §5.4(d) 第 2 点 / v3-B-3）
  if (m.role === 'system') {
    return <SubagentNoticeRow m={m} />
  }
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
      <div className="row user" data-user-msg={m.id}>
        {/* 只读视图（子会话下钻）不渲染「回退至此」——用户拍板：子会话只读 */}
        {readOnly ? null : (
          <button
            className={'undo-btn' + (undoDisabled ? ' disabled' : '')}
            title={undoTitle}
            disabled={undoDisabled}
            onClick={() => !undoDisabled && onUndo && onUndo(m)}
          >
            ↶
          </button>
        )}
        <div className="bubble user">
          {m.parts.map((p, i) => (p.type === 'text' ? <div key={i}>{p.text}</div> : null))}
        </div>
      </div>
    )
  }
  return (
    <div className={'row assistant' + (showName ? '' : ' no-name')}>
      <div className="bubble assistant">
        {showName ? (
          <div className="msg-name">
            <span className="mini-mark"><Sparkles size={10} strokeWidth={2} aria-hidden="true" /></span>
            XWORK
          </div>
        ) : null}
        {m.error && !m.aborted && <div className="msg-error">回复失败：{m.error}</div>}
        {m.parts.map((p, i) => {
          if (p.type === 'text') return null // 文本统一由下方 TextBlock 渲染
          if (p.type === 'reasoning') {
            return (
              <ReasoningBlock
                key={i}
                text={p.text}
                streaming={p.streaming === true && m.streaming === true}
              />
            )
          }
          if (p.type === 'tool') {
            // 子智能体（L1）：改渲染 <SubagentCard>（取代 [工具] subagent · 完成 的灰 chip）
            if (p.tool === 'subagent')
              return <SubagentCard key={i} part={p} parentSid={parentSid} />
            // 普通工具：`[工具] read · 完成` 芯片，点击展开输入/输出（与面板同一份 ToolIOView）
            return <ToolChip key={i} part={p} />
          }
          return null
        })}
        {mdText.trim() && (
          <TextBlock
            key="text"
            revealKey={(parentSid || 'local') + ':' + m.id}
            text={mdText}
            streamed={m.streamed}
            revealTo={m.revealTo}
            streaming={m.streaming}
          />
        )}
        {/* 中止标记放在所有内容之后，提示这是本条输出的结尾。 */}
        {m.aborted && <div className="aborted-badge">已停止（输出不完整）</div>}
      </div>
      {/* 只读视图（子会话下钻）不提供复制按钮 —— 用户拍板：子会话只读，去掉「回退至此」「复制」 */}
      {mdText.trim() && !m.streaming && !m.aborted && !readOnly && (
        <button className="copy-btn" title="复制" onClick={() => onCopy(mdText)}>
          <Copy size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  )
})

// 文本块：曾流式输出的消息走揭示动画，历史消息直接渲染 Markdown
// revealTo：恢复会话时已累积文本的长度（视为已揭示），后续增量从该位置继续
// streaming：引擎是否仍在输出。与「已追平」取【或】作为 .streaming 判据（§4.5）——
//   只跟 shown 会让 mermaid 用截断围栏源码渲染，并让光标在追平空档熄灭
// progress：揭示进度 { shown, carry, rateCps, samples, seeded, seededAt }，**在 TextBlock 持有**。
//   切档只换子组件、不换状态所有者 ⇒ 进度不重置（P1：否则从 revealTo 重打一遍）
function TextBlock({ revealKey, text, streamed, revealTo, streaming }) {
  const mode = useContext(RevealModeContext)
  const progressRef = useRef(null)
  if (!progressRef.current) {
    // 先恢复上次卸载时的进度；若离页期间 revealTo 已推进到最新正文，
    // 取两者较大值，避免返回时又从离开点补打。
    const saved = revealKey ? revealProgressByMessage.get(revealKey) : null
    progressRef.current = saved
      ? { ...saved, shown: Math.max(saved.shown || 0, revealTo ?? 0) }
      : {
          shown: revealTo ?? 0,
          carry: 0,
          rateCps: 0,
          samples: [],
          seeded: false,
          seededAt: 0
        }
  }
  const progress = progressRef.current
  // 视图切换会卸载 TextBlock；保存最新进度，重新挂载时从该位置继续。
  useEffect(() => {
    return () => {
      if (revealKey) revealProgressByMessage.set(revealKey, progressRef.current)
    }
  }, [revealKey])
  // 换档后重新播种水位环：打字机档期间到达的文字不该在切回浮现时再浮一次
  // （播种帧不包裹，见 emergeDom.sampleTotal；shown/carry 保持不动 ⇒ 进度不倒退）
  const modeRef = useRef(mode)
  if (modeRef.current !== mode) {
    modeRef.current = mode
    progress.seeded = false
  }
  // ★ 揭示态是「粘住」的：session.idle 后的权威重载（normalize）不带 streamed，
  // 若此时退回"直接渲染全文"，正在补打的剩余文本会一次性刷出（用户看到的"先按规矩打、然后全出"）。
  // 一旦本条消息在本实例内进入过揭示态，就一直走揭示路径；换会话/重开时组件重挂、自然回到直出。
  const everRevealedRef = useRef(false)
  if (streamed) everRevealedRef.current = true
  const reveal = streamed || everRevealedRef.current
  if (!reveal) {
    return <div className="md-body" dangerouslySetInnerHTML={{ __html: marked.parse(text) }} />
  }
  // key 让换档时重建容器：同一 __html 时 React 不重写 innerHTML，否则旧档的 .em 包裹会残留
  return mode === 'typewriter' ? (
    <TypewriterText key="tw" text={text} startFrom={revealTo} progress={progress} streaming={streaming} />
  ) : (
    <EmergeText key="em" text={text} startFrom={revealTo} progress={progress} streaming={streaming} />
  )
}

// 打字机组件：积压驱动的「按需追赶」（速率与推进逻辑在 ./typewriter.mjs，可离线单测）。
// 跟得上时维持 80 字/秒原速；积压越大越快，平均上限 300 字/秒、单帧步长 ≤ 8 字符。
// 用 ref 记录已揭示长度与结转余量，文本增长时持续追赶而不重置。
// 全程对已揭示文本渲染 Markdown（单一渲染路径），避免流式中格式/纯文本来回切换闪烁。
// startFrom：初始已揭示长度（0 = 从空开始；恢复会话传已累积文本长度避免重新打印）
// progress：与 EmergeText 共享的进度对象（切档承接）；缺省时行为与改造前一致
function TypewriterText({ text, startFrom, progress, streaming }) {
  const textRef = useRef(text)
  textRef.current = text
  const nudge = useContext(ScrollFollowContext) // 每揭示一帧通知贴底跟随（A）
  const shownRef = useRef(progress ? progress.shown : (startFrom ?? 0))
  const carryRef = useRef(progress ? progress.carry : 0)
  const [shown, setShown] = useState(progress ? progress.shown : (startFrom ?? 0))
  const advancing = shown < text.length
  useEffect(() => {
    if (!advancing) return // 已追平：不起定时器（避免每条历史消息留一个 40Hz 空转）
    const timer = setInterval(() => {
      const next = advanceTypewriterBurst({ text: textRef.current, shown: shownRef.current, carry: carryRef.current })
      carryRef.current = next.carry
      if (progress) progress.carry = next.carry
      if (next.step <= 0) return
      shownRef.current = next.shown
      setShown(next.shown)
      if (progress) {
        progress.shown = next.shown
        progress.rateCps = (next.step * 1000) / TW_TICK_MS
      }
    }, TW_TICK_MS)
    return () => clearInterval(timer)
  }, [advancing])
  // 内容是逐帧长高的：消息数组不变 ⇒ App 的滚动 effect 不会跑 ⇒ 由这里通知贴底跟随（A）
  useLayoutEffect(() => {
    if (nudge) nudge()
  }, [shown, nudge])
  // 打字机落后或引擎仍在输出时挂 .streaming（光标已按用户要求全局隐藏，见 styles.css）
  const lagging = !!streaming || shown < text.length
  return (
    <div className={'md-body' + (lagging ? ' streaming' : '')} dangerouslySetInnerHTML={{ __html: marked.parse(text.slice(0, shown)) }} />
  )
}

// 浮现档的 DOM 层（末窗采集 / 负延迟包裹 / 降级还原）在 ./emergeDom.mjs ——
// 抽成独立模块是为了让真浏览器验收脚本能求值同一份源码（scripts/accept-emerge.mjs）。

// 系统「减少动态效果」偏好；运行中改变也生效。降级一律由 JS 判定（D8）：
// CSS 里不写 @media，因为内联 --em-dur 会盖掉它，媒体规则会变成死代码。
function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    setReduced(mq.matches) // 首帧与 matchMedia 对齐（避免 hydrate 前后不一致）
    const onChange = (e) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

// 浮现档：新字以「模糊→清晰」出现，已浮现的文字保持稳定、绝不重播。
// 机制（D2）：每帧整体重建子树会让动画从第 0 帧重播 ⇒ 用负 animation-delay 把「重播」变成「定位」，
// 不需要 rAF、不需要保留节点身份。出生时刻由水位环推导（emerge.mjs）。
// **必须 useLayoutEffect**：useEffect 在绘制之后运行，每帧会先看到全亮的一帧再包回模糊（40Hz 预闪）。
function EmergeText({ text, startFrom, progress, streaming }) {
  const textRef = useRef(text)
  textRef.current = text
  const nudge = useContext(ScrollFollowContext) // 每揭示一帧通知贴底跟随（A）
  const ref = useRef(null)
  const [shown, setShown] = useState(progress ? progress.shown : (startFrom ?? 0))
  const shownRef = useRef(shown)
  const reduced = usePrefersReducedMotion()
  const advancing = shown < text.length
  useEffect(() => {
    if (!advancing) return // 已追平：不起定时器
    const timer = setInterval(() => {
      const next = advanceTypewriterBurst({ text: textRef.current, shown: shownRef.current, carry: progress.carry })
      progress.carry = next.carry
      if (next.step <= 0) return // 无推进：不 setState，零重渲染
      progress.rateCps = (next.step * 1000) / TW_TICK_MS
      progress.shown = next.shown
      shownRef.current = next.shown
      setShown(next.shown)
    }, TW_TICK_MS)
    return () => clearInterval(timer)
  }, [advancing])

  const html = marked.parse(text.slice(0, shown))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const now = performance.now() // 同一 effect 内只取一次（§5.8）
    if (reduced) {
      // 降级：不包裹；水位环照常推进，关掉降级后新字仍能正常浮现
      sampleTotal(el, progress, now)
      unwrapEmerge(el)
      if (nudge) nudge()
      return
    }
    wrapEmerge(el, progress, now)
    if (nudge) nudge() // 每揭示一帧内容都在长高 ⇒ 通知贴底跟随（A）
  }, [shown, html, reduced, nudge])

  const lagging = !!streaming || shown < text.length
  return (
    <div
      ref={ref}
      className={'md-body' + (lagging ? ' streaming' : '')}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
