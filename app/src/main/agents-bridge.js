// .agents → .opencode junction 桥接：判定、建链、摘链、git 防污染
//
// 设计依据：功能设计文档/agents目录junction桥接设计.md（v2.1）
//   §5.1 模块职责 / §5.2 联接判定 / §5.3 创建规则 / §5.4 git 三级防御 / §5.5 摘除与清理
//
// 关键实测结论（写在代码里，防止后续维护者"顺手简化"）：
//   J9  目录联接的 lstat 是 isSymbolicLink()===true / isDirectory()===false → 判定必须用 lstat
//   J10 git 会【穿透】junction：git add -A 把 .agents 内容以普通 blob 记入 .opencode/**，
//       clone 后物化为真目录且 .agents 缺失（永久静默降级）→ 必须先做 git 防污染
//   J14 删除类操作（rmdirSync/rmSync/unlinkSync/rd /s /q）只摘链接、不动目标；
//       真正会跟随并物化内容的是【拷贝类】操作（cpSync/robocopy）
//   J22 忽略规则不能回滚已索引内容（写入 .opencode/.gitignore('*') 后 ls-files 仍含旧条目）
//   J23 防护文件 .opencode/.gitignore 自身不被跟踪（`*` 把它自己忽略了）——不是缺口
//
// 三条判据的顺序是硬约束（v2.1 §5.4），顺序写错会：
//   ① 先用 2️⃣/3️⃣ 再查 1️⃣ → 静默"删除"用户已提交的文件（写 * 后真文件从工作区消失）
//   ② 复验用目录路径而非探针路径 → 已跟踪/已污染场景判据漂移，反向误判

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 本方案托管的两个联接（相对工作区根） */
const LINKS = [
  { rel: path.join('.opencode', 'agents'), target: path.join('.agents', 'agents') },
  { rel: path.join('.opencode', 'commands'), target: path.join('.agents', 'commands') }
]

/** 探针文件名：用于"是否已被忽略"的判定。必须是不存在于索引的路径（见 J22/§5.4） */
const PROBE_REL = path.join('.opencode', 'agents', '__xwork_probe__.md')

/** 本方案写入的保护文件内容（含归属判定依据，见 §5.5 第 1 点） */
const GUARD_GITIGNORE = '*\n'

/** git 命令超时（防分支/慢盘下卡死工作区打开） */
const GIT_TIMEOUT_MS = 5000

// ── 路径工具 ─────────────────────────────────────────────────────────────────

/**
 * 路径归一化：解析符号链接/联接、统一大小写与分隔符（Windows 的 8.3 短名差异也一并消除）。
 * 目标不存在时回退到纯字符串归一（用于 dangling 判定）。
 */
function normalizePath(p) {
  const abs = path.resolve(p)
  try {
    return fs.realpathSync.native(abs).toLowerCase()
  } catch {
    return abs.toLowerCase()
  }
}

/** 两个路径是否指向同一位置（归一化后比较） */
function samePath(a, b) {
  return normalizePath(a) === normalizePath(b)
}

/** 目录是否为空（不存在或读取失败都返回 false，交由调用方判定） */
function isEmptyDirOrMissing(dir) {
  try {
    const st = fs.lstatSync(dir)
    if (!st.isSymbolicLink() && !st.isDirectory()) return false
    return fs.readdirSync(dir).length === 0
  } catch (e) {
    return e.code === 'ENOENT'
  }
}

// ── git 探针（§5.4 的底层能力） ──────────────────────────────────────────────

let cachedGitExe
/**
 * 解析随包 git（与 app/package.json 的 extraResources 一致：resources/git → <resources>/git）。
 * 打包后用 process.resourcesPath；dev 下用 app.getAppPath()/resources。
 * 可用 XWORK_GIT_EXE 覆盖（测试/排查）。
 */
function resolveGitExe() {
  if (cachedGitExe !== undefined) return cachedGitExe
  cachedGitExe = null
  if (process.env.XWORK_GIT_EXE) {
    cachedGitExe = process.env.XWORK_GIT_EXE
    return cachedGitExe
  }
  let bases = []
  try {
    const electron = require('electron')
    if (electron.app?.isPackaged) bases.push(path.join(process.resourcesPath, 'git'))
    else if (electron.app) bases.push(path.join(electron.app.getAppPath(), 'resources', 'git'))
  } catch {
    /* 非 Electron（测试）环境：仅走下面的回退 */
  }
  bases.push(path.join(__dirname, '..', '..', 'resources', 'git'))
  for (const base of bases) {
    const exe = path.join(base, 'cmd', 'git.exe')
    if (fs.existsSync(exe)) {
      cachedGitExe = exe
      return cachedGitExe
    }
    const exeNoExt = path.join(base, 'cmd', 'git')
    if (fs.existsSync(exeNoExt)) {
      cachedGitExe = exeNoExt
      return cachedGitExe
    }
  }
  return cachedGitExe
}

/** 在工作区里跑一条只读 git 命令。绝不抛错——失败一律返回 code=-1 */
function gitRun(workspace, args, opts = {}) {
  const exe = opts.gitExe || resolveGitExe()
  if (!exe) return { code: -1, out: '', err: 'git executable not found' }
  const r = spawnSync(exe, args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  })
  return { code: r.status ?? -1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

/** 工作区是否是 git 仓库（同时得到仓库根，用于确认 .opencode 在仓库内） */
function isGitRepo(workspace, opts = {}) {
  if (!fs.existsSync(path.join(workspace, '.git'))) return false // 快路径：无 .git 目录
  const r = gitRun(workspace, ['rev-parse', '--is-inside-work-tree'], opts)
  return r.code === 0 && r.out === 'true'
}

/**
 * §5.4 判据 1️⃣：索引检查（硬闸门）。
 * 返回被跟踪的 .opencode 路径列表（空数组 = 通过）。
 */
function trackedUnder(workspace, relDir, opts = {}) {
  const r = gitRun(workspace, ['ls-files', '--', relDir.split(path.sep).join('/')], opts)
  if (r.code !== 0 || !r.out) return []
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * §5.4 判据 2️⃣：探针路径是否已被忽略。
 * 必须用【不存在的探针路径】：目录路径与已跟踪路径会返回 exit=1（J22 实测），与"未保护"不可区分。
 */
function isIgnored(workspace, relPath, opts = {}) {
  const r = gitRun(workspace, ['check-ignore', '-q', '--', relPath.split(path.sep).join('/')], opts)
  return r.code === 0
}

// ── 保护文件归属（§5.5 第 1 点，评审 B-4） ───────────────────────────────────

/**
 * 读 .opencode/.gitignore 的归属：
 *   'ours'     内容恰为 '*'（本方案写的；文本文件语义下 \n 无意义，故 trim 后比较）
 *   'user'     用户自己写的（含任何额外规则，如 '!opencode.json'）
 *   'missing'  不存在
 */
function guardGitignoreState(workspace) {
  const file = path.join(workspace, '.opencode', '.gitignore')
  let content
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { state: e.code === 'ENOENT' ? 'missing' : 'unreadable', file }
  }
  return { state: content.trim() === '*' ? 'ours' : 'user', file, content }
}

// ── §5.2 联接判定 ────────────────────────────────────────────────────────────

/**
 * 判定一个联接槽位的状态。
 * @returns {{state:'missing'|'ok'|'occupied'|'dangling'|'wrongTarget'|'error', ...}}
 *   occupied 时附 kind('real-dir-empty'|'real-dir-nonempty') 与 entries
 */
function linkState(linkPath, targetPath) {
  let st
  try {
    st = fs.lstatSync(linkPath)
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'missing' }
    return { state: 'error', error: e.message }
  }

  if (!st.isSymbolicLink()) {
    // 真目录/真文件：绝不覆盖（J9：联接的 lstat 是 symlink，真目录不是）
    if (!st.isDirectory()) return { state: 'occupied', kind: 'real-file' }
    let entries = []
    try {
      entries = fs.readdirSync(linkPath)
    } catch (e) {
      return { state: 'error', error: e.message }
    }
    return {
      state: 'occupied',
      kind: entries.length === 0 ? 'real-dir-empty' : 'real-dir-nonempty',
      entries
    }
  }

  // 是联接：先比对目标（readlink 不受目标是否存在影响 → 可区分 dangling 与 wrongTarget）
  let pointed = null
  try {
    pointed = fs.readlinkSync(linkPath)
  } catch (e) {
    return { state: 'error', error: e.message }
  }
  if (!samePath(pointed, targetPath)) return { state: 'wrongTarget', pointed }

  // 目标一致：确认目标可达（悬空联接的 realpath 会抛 ENOENT，评审 S-4）
  try {
    fs.realpathSync(linkPath)
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'dangling', pointed }
    return { state: 'error', error: e.message }
  }
  return { state: 'ok', pointed }
}

/** 把 occupied 与 git 归属合成结构化 blocked 原因（两维正交，评审 M-10/M-15） */
function classifyOccupied(workspace, relLink, linkInfo, opts = {}) {
  const tracked = trackedUnder(workspace, relLink, opts)
  return {
    rel: relLink,
    kind: linkInfo.kind,
    tracked: tracked.length > 0,
    trackedSample: tracked.slice(0, 5),
    blockedBy: linkInfo.kind === 'real-dir-empty' ? null : 'real-dir-nonempty'
  }
}

// ── 期望条目集合（§5.1；注意评审 M-14 的局限） ───────────────────────────────

/**
 * 递归收集目录下的 *.md（含点文件），返回相对路径（/ 分隔，不含扩展名）。
 * 命名推导复刻引擎公式（二进制锚点 S3），逐字对应：
 *   path.relative(<config root>, <file>).replaceAll('\\','/').replace(/^(agent|agents|mode|modes)\//,'').replace(/\.md$/,'')
 * 由于 cwd 就是 config root，relative 结果必然以域目录名开头，因此等价于：
 *   **无条件去掉第一段路径**，再去 .md。
 *
 * ⚠ 这里曾写错两次，实测教训（0.6.4 期间由 /api/agent 真实返回纠正）：
 *   `.agents/agents/agents/inner.md` 的引擎 id 是 **`agents/inner`**（只剥一层），
 *   不是 `inner`。写成本域正则条件剥离会导致多剥一层（`agents/inner` → `inner`），
 *   自检的期望集合与引擎实际不一致 → 误报"未加载"。
 * 验证方式：`node scripts/test-agents-bridge.cjs`（T-B*）与真实引擎的 /api/agent 对照。
 * 注意 M-14：该公式与引擎同源，所以【不能】单独用于 T-REG 的语义漂移检查。
 */
function collectMdNames(rootDir) {
  const out = new Set()
  const walk = (dir, segments) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        walk(path.join(dir, ent.name), [...segments, ent.name])
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        // segments 首段固定是域目录名（与引擎的 replace(/^(agents|commands)\//,'') 对应），
        // 其余为子目录。根下的文件（segments 只有域目录名）也命中——实测 `**/` 可匹配零层：
        //   .agents/agents/hello-agent.md → hello-agent
        //   .agents/agents/agents/inner.md → agents/inner（只剥一层，第二段 agents 保留）
        out.add([...segments.slice(1), ent.name.slice(0, -3)].join('/'))
      }
    }
  }
  walk(rootDir, [path.basename(rootDir)]) // 第一段固定为域目录名（agents / commands）
  return out
}

/**
 * 期望条目集合（供自检比对）。
 * @returns {{agents:Set<string>, commands:Set<string>, files:number}}
 */
function expectedEntries(workspace) {
  const root = path.join(workspace, '.agents')
  const agents = collectMdNames(path.join(root, 'agents'))
  const commands = collectMdNames(path.join(root, 'commands'))
  return { agents, commands, files: agents.size + commands.size }
}

// ── §5.4 git 防污染（三级，顺序是硬约束） ────────────────────────────────────

/**
 * git 防污染。必须在【建链之前】调用，且严格按 1️⃣→2️⃣→3️⃣ 顺序。
 * @returns {{ok:boolean, mode?:string, blocked?:string, tracked?:string[], wroteGitignore?:boolean}}
 */
function gitGuard(workspace, opts = {}) {
  if (!isGitRepo(workspace, opts)) return { ok: true, mode: 'not-a-repo' }

  // 1️⃣ 索引检查（硬闸门）—— 必须最先跑：写保护文件会让已跟踪文件从工作区"消失"
  const tracked = trackedUnder(workspace, '.opencode', opts)
  if (tracked.length > 0) {
    return { ok: false, blocked: 'git-tracked', tracked, repair: repairAdvice(tracked) }
  }

  // 2️⃣ 探针判据（绝不用目录路径或已跟踪路径）
  if (isIgnored(workspace, PROBE_REL, opts)) return { ok: true, mode: 'already-ignored' }

  // 3️⃣ 写入 + 复验同一条探针判据
  const gi = guardGitignoreState(workspace)
  if (gi.state === 'user') {
    // 用户自写（可能含 '!opencode.json' 之类的例外）→ 用他的规则，不覆盖；
    // 但探针未命中说明其规则未覆盖联接 → 不能建链
    return { ok: false, blocked: 'gitignore-user-owned', file: gi.file }
  }
  if (gi.state === 'unreadable') return { ok: false, blocked: 'gitignore-unreadable', file: gi.file }

  try {
    fs.mkdirSync(path.dirname(gi.file), { recursive: true })
    fs.writeFileSync(gi.file, GUARD_GITIGNORE)
  } catch (e) {
    return { ok: false, blocked: 'gitignore-write-failed', error: e.message }
  }
  if (!isIgnored(workspace, PROBE_REL, opts)) {
    return { ok: false, blocked: 'git-ignore-ineffective' }
  }
  return { ok: true, mode: 'wrote-ignore', wroteGitignore: true }
}

/**
 * 针对"索引里已有 .opencode/**"给出修复指引（§5.4 第 1️⃣ 行）。
 * 顺序错了会二次丢内容：.agents 通常被 git 忽略 → clone 里根本不存在，必须先恢复。
 */
function repairAdvice(tracked) {
  const materialized = tracked.some((p) => /^\.opencode\/(agents|commands)\//i.test(p.replace(/\\/g, '/')))
  if (!materialized) {
    return {
      kind: 'user-config-tracked',
      steps: [
        '索引中已存在 .opencode 下的文件（可能是你提交的配置，如 .opencode/opencode.json）。',
        '若要启用 .agents 桥接：把这些文件从索引移除（git rm --cached <path>），或接受它们被忽略。'
      ]
    }
  }
  return {
    kind: 'materialized-from-junction',
    steps: [
      '① 先恢复 .agents/{agents,commands} 的目标目录与文件（.agents 通常被 git 忽略，clone 出来的工作区里没有它）。',
      '② 再清理索引：git rm --cached -r .opencode/agents .opencode/commands',
      '③ 然后删除已被物化的真目录 .opencode/{agents,commands}（确认内容无遗漏后）。',
      '④ 最后重新激活工作区，桥接会自动重建。'
    ]
  }
}

// ── §5.3/§5.5 建链 / 摘链 ────────────────────────────────────────────────────

/** 建一个联接（target 必须绝对路径；directory junction 不需要管理员权限） */
function createLink(linkPath, targetPath) {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    fs.symlinkSync(path.resolve(targetPath), linkPath, 'junction')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message, code: e.code }
  }
}

/**
 * 摘除一个联接。铁律：只 rmdirSync，绝不递归删除（J14）。
 * @returns {{ok:boolean, skipped?:string, reason?:string}}
 */
function removeLink(linkPath) {
  let st
  try {
    st = fs.lstatSync(linkPath)
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, skipped: 'missing' }
    return { ok: false, reason: e.message }
  }
  if (!st.isSymbolicLink()) return { ok: false, reason: 'not-a-link' } // 真目录/真文件绝不删
  try {
    fs.rmdirSync(linkPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

/**
 * 幂等保证两个联接可用（§5.3）。
 * 顺序：git 防污染 → 逐槽位判定 → 建链 / 修复 / 阻断。
 */
function ensureAgentsBridge(workspace, opts = {}) {
  const result = { workspace, linked: [], repaired: [], blocked: [], warnings: [] }
  if (!workspace || typeof workspace !== 'string') {
    result.blocked.push({ rel: null, blockedBy: 'invalid-workspace' })
    return result
  }

  // git 防污染（未通过则不建链）
  const guard = gitGuard(workspace, opts)
  if (!guard.ok) {
    result.blocked.push({ rel: '.opencode', blockedBy: guard.blocked, tracked: guard.tracked, repair: guard.repair })
    return result
  }
  if (guard.wroteGitignore) result.warnings.push({ code: 'wrote-guard-gitignore', rel: '.opencode/.gitignore' })

  for (const slot of LINKS) {
    const linkPath = path.join(workspace, slot.rel)
    const targetPath = path.join(workspace, slot.target)

    {
      const ti = linkState(targetPath, targetPath)
      if (ti.state === 'missing') continue // 目标不存在 → 不建链（避免悬空联接）
    }

    const info = linkState(linkPath, targetPath)
    switch (info.state) {
      case 'ok':
        break
      case 'missing': {
        const created = createLink(linkPath, targetPath)
        if (created.ok) result.linked.push(slot.rel)
        else result.blocked.push({ rel: slot.rel, blockedBy: 'cross-volume', error: created.error })
        break
      }
      case 'dangling':
      case 'wrongTarget': {
        const rm = removeLink(linkPath)
        if (!rm.ok) {
          result.blocked.push({ rel: slot.rel, blockedBy: 'remove-failed', error: rm.reason })
          break
        }
        const created = createLink(linkPath, targetPath)
        if (created.ok) result.repaired.push(slot.rel)
        else result.blocked.push({ rel: slot.rel, blockedBy: 'cross-volume', error: created.error })
        break
      }
      case 'occupied': {
        if (info.kind === 'real-dir-empty') {
          // 空真目录：不可能有用户内容 → 自动 rmdir 后建链（评审 M-15）
          try {
            fs.rmdirSync(linkPath)
          } catch (e) {
            result.blocked.push({ rel: slot.rel, blockedBy: 'occupied', kind: info.kind, error: e.message })
            break
          }
          const created = createLink(linkPath, targetPath)
          if (created.ok) result.repaired.push(slot.rel)
          else result.blocked.push({ rel: slot.rel, blockedBy: 'cross-volume', error: created.error })
          break
        }
        result.blocked.push(classifyOccupied(workspace, slot.rel, info, opts))
        break
      }
      default:
        result.blocked.push({ rel: slot.rel, blockedBy: 'error', error: info.error })
    }
  }
  return result
}

/**
 * 摘除两个联接；并按归属判定是否清理 .opencode 空壳（§5.5 第 1 点，评审 B-4）。
 * 三条同时成立才删目录：① 仅剩 .gitignore（或空）② 该文件是本方案写的 ③ 无被跟踪内容。
 */
function removeAgentsBridge(workspace, opts = {}) {
  const result = { workspace, removed: [], blocked: [], shellRemoved: false }
  if (!workspace || typeof workspace !== 'string') return result

  for (const slot of LINKS) {
    const r = removeLink(path.join(workspace, slot.rel))
    if (r.ok) {
      if (!r.skipped) result.removed.push(slot.rel)
    } else {
      result.blocked.push({ rel: slot.rel, reason: r.reason })
    }
  }

  const dir = path.join(workspace, '.opencode')
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return result // 目录不存在（或不可读）→ 无事可做
  }
  const onlyGuardFile = entries.every((e) => e === '.gitignore')
  const guard = guardGitignoreState(workspace)
  const tracked = isGitRepo(workspace, opts) ? trackedUnder(workspace, '.opencode', opts) : []
  if (onlyGuardFile && guard.state === 'ours' && tracked.length === 0) {
    try {
      // Windows 的 rmdir 要求目录为空：必须先删掉本方案写的保护文件（内容已确认是我们的，B-4）。
      // 顺序不能反，也不能用递归删除（那会顺着任何残留联接跑）。
      if (entries.length > 0) fs.unlinkSync(guard.file)
      fs.rmdirSync(dir)
      result.shellRemoved = true
    } catch (e) {
      result.blocked.push({ rel: '.opencode', reason: e.message })
    }
  }
  return result
}

// ── §5.6 自检（只读体检；收敛轮询在阶段 5 接入） ─────────────────────────────

/** 只读体检：不下结论、不写盘，供 ensure 后的用户提示与排查使用 */
function inspectAgentsBridge(workspace, opts = {}) {
  const out = { workspace, links: {}, git: null, expected: null }
  for (const slot of LINKS) {
    out.links[slot.rel] = linkState(path.join(workspace, slot.rel), path.join(workspace, slot.target))
  }
  if (isGitRepo(workspace, opts)) {
    out.git = {
      tracked: trackedUnder(workspace, '.opencode', opts),
      ignored: isIgnored(workspace, PROBE_REL, opts),
      guardGitignore: guardGitignoreState(workspace).state
    }
  }
  const exp = expectedEntries(workspace)
  out.expected = { agents: [...exp.agents].sort(), commands: [...exp.commands].sort() }
  return out
}

module.exports = {
  LINKS,
  PROBE_REL,
  GUARD_GITIGNORE,
  // 路径工具
  normalizePath,
  samePath,
  isEmptyDirOrMissing,
  // git 探针
  resolveGitExe,
  isGitRepo,
  trackedUnder,
  isIgnored,
  guardGitignoreState,
  repairAdvice,
  // 判定
  linkState,
  classifyOccupied,
  collectMdNames,
  expectedEntries,
  // 动作
  gitGuard,
  createLink,
  removeLink,
  ensureAgentsBridge,
  removeAgentsBridge,
  inspectAgentsBridge
}
