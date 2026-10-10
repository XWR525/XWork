// undo 兜底恢复：补偿 opencode 引擎 revert 的缺陷（改名/删除后旧文件不恢复）
// 原理见 undo功能设计.md §7.4。实测确认：
//   - revert 返回的 snapshot 是「最后一轮操作完成后」的 tree（非目标轮次前状态）
//   - 引擎能正确删除被回退轮次内「新增的文件」，但对「被改名/移动的旧文件」漏恢复
//     （旧名不在任何 patch 的 files 列表里，引擎从不触碰它们）
//   - 因此参照改为「目标轮次前快照 T_before」：回退后工作区应等于 T_before 的状态，
//     T_before 有、工作区缺的文件即漏恢复的旧文件，按路径直接从 T_before 恢复（无需 blob 匹配）
// T_before 由调用方（index.js session:undo-to）从消息流 step-finish/step-start 提取
// 删除/编辑/新建场景不受影响：文件仍在则不动；T_before 为空时兜底空操作
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')

// 路径归一化：统一分隔符、去尾斜杠、小写（Windows 路径不区分大小写），用于 worktree 匹配
const norm = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()

// 定位当前工作区的引擎快照仓库：遍历 snapshot 根目录下两层（project → repo）的 git 仓库，
// 读各仓库 config 的 worktree 与工作区匹配；未命中返回 null
function findSnapshotRepo(snapshotDir, workspace) {
  if (!fs.existsSync(snapshotDir)) return null
  const want = norm(workspace)
  let projects
  try {
    projects = fs.readdirSync(snapshotDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const projectDir = path.join(snapshotDir, p.name)
    let repos
    try {
      repos = fs.readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const r of repos) {
      if (!r.isDirectory()) continue
      const repo = path.join(projectDir, r.name)
      if (!fs.existsSync(path.join(repo, 'HEAD'))) continue
      const cfg = fs.readFileSync(path.join(repo, 'config'), 'utf8')
      const m = /worktree\s*=\s*(.+)/i.exec(cfg || '')
      if (m && norm(m[1].trim()) === want) return repo
    }
  }
  return null
}

// 列出 git 仓库中指定 tree 的全部文件：path → blob hash（NUL 分隔 + 不转义非 ASCII，防路径含特殊字符/中文错位）
function listTree(git, repo, tree) {
  const out = execFileSync(
    git,
    ['-c', 'core.quotepath=false', '--git-dir', repo, 'ls-tree', '-r', '-z', tree],
    { encoding: 'buffer', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  )
  const map = {}
  for (const line of out.toString('utf8').split('\0')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const meta = line.slice(0, tab).split(' ')
    const p = line.slice(tab + 1)
    if (meta[1] === 'blob') map[p] = meta[2]
  }
  return map
}

// 快照补偿恢复：找回引擎 revert 漏恢复的「被改名/移动的旧文件」
// 参数：git（findGit() 结果）、snapshotDir（快照根目录）、workspace（当前工作区）、snapshot（目标轮次前快照 T_before）
// 返回：{ ok, restored:[相对路径], skipped:[相对路径], reason? }
function restoreMissingFiles({ git, snapshotDir, workspace, snapshot }) {
  if (!git || !workspace || !snapshot) return { ok: false, reason: 'no_git_or_args' }
  const repo = findSnapshotRepo(snapshotDir, workspace)
  if (!repo) return { ok: false, reason: 'no_snapshot_repo' }
  // 校验 snapshot 是有效 tree
  try {
    const t = execFileSync(git, ['--git-dir', repo, 'cat-file', '-t', snapshot], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (t !== 'tree') return { ok: false, reason: 'bad_snapshot' }
  } catch {
    return { ok: false, reason: 'bad_snapshot' }
  }
  // T_before tree = 回退后工作区应有的状态：其中「当前工作区缺失」的文件 = 引擎漏恢复的旧文件
  let S
  try {
    S = listTree(git, repo, snapshot)
  } catch {
    return { ok: false, reason: 'list_failed' }
  }
  const restored = []
  const skipped = []
  for (const [p, blob] of Object.entries(S)) {
    if (isSkippedPath(p)) continue // 与工作区扫描同步跳过依赖/产物目录（快照与工作区都不对比，避免阻塞）
    const abs = path.join(workspace, p)
    if (fs.existsSync(abs)) continue
    try {
      const content = execFileSync(git, ['--git-dir', repo, 'cat-file', 'blob', blob], {
        encoding: 'buffer',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      restored.push(p)
    } catch {
      skipped.push(p)
    }
  }
  return { ok: true, restored, skipped }
}

// git blob 的 SHA-1（与 git hash-object 一致）：sha1("blob <len>\0" + 内容)，用于与快照 blob hash 比对
function gitBlobHash(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

// 扫描时跳过的常见大目录（与 app.config.json 的 hideDirs 对齐）：
// 撤销影响收集需同步全量对比工作区文件，跳过依赖/产物目录避免大仓库下主进程长时间阻塞
const SKIP_DIRS = new Set([
  '.opencode',
  '.agents',
  'node_modules',
  '.git',
  '.svn',
  '.next',
  'dist',
  'build',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode'
])

// 相对路径是否落在被跳过的目录下（路径段匹配，忽略大小写，与 norm 一致）
function isSkippedPath(rel) {
  for (const seg of rel.split('/')) {
    if (SKIP_DIRS.has(seg.toLowerCase())) return true
  }
  return false
}

// 递归收集工作区全部文件（相对路径，正斜杠）；skipDirs 中的目录整棵跳过
function walkWorkspace(dir, base, skipDirs = SKIP_DIRS) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const ent of entries) {
    if (skipDirs && skipDirs.has(ent.name.toLowerCase())) continue
    const rel = base ? `${base}/${ent.name}` : ent.name
    if (ent.isDirectory()) out.push(...walkWorkspace(path.join(dir, ent.name), rel, skipDirs))
    else if (ent.isFile()) out.push(rel)
  }
  return out
}

// 收集 undo 后「实际影响清单」：revert.snapshot（该轮操作完成后 = undo 前）vs 当前工作区（undo 后）
// 分类见 undo功能设计.md §6.3（不解析 diff，快照全量对比更可靠）：
//   - 快照有、当前无 → delete  （本轮新建被删，含改名新名如 renamed.txt）
//   - 快照有、当前有、内容不同 → restore（本轮被修改，内容回到本轮之前）
//   - 快照无、当前有 → recover  （本轮被删/改名弄丢、undo 后重现，含兜底恢复的旧文件）
// 返回 { ok, impact:[{path,type}], reason? }；path 为相对工作区路径
function collectUndoImpact({ git, snapshotDir, workspace, snapshot }) {
  if (!git || !workspace || !snapshot) return { ok: false, reason: 'no_git_or_args' }
  const repo = findSnapshotRepo(snapshotDir, workspace)
  if (!repo) return { ok: false, reason: 'no_snapshot_repo' }
  try {
    const t = execFileSync(git, ['--git-dir', repo, 'cat-file', '-t', snapshot], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (t !== 'tree') return { ok: false, reason: 'bad_snapshot' }
  } catch {
    return { ok: false, reason: 'bad_snapshot' }
  }
  let S
  try {
    S = listTree(git, repo, snapshot) // { 快照路径 → blob hash }，即 undo 前工作区全量文件
  } catch {
    return { ok: false, reason: 'list_failed' }
  }
  // 快照 blob 大小（一次 batch 查询，供「大小不同 → 内容必不同」短路，避免读盘）
  const sizeByHash = {}
  {
    const uniq = [...new Set(Object.values(S))]
    const batch = spawnSync(git, ['--git-dir', repo, 'cat-file', '--batch-check=%(objectname) %(objectsize)'], {
      input: uniq.join('\n') + '\n',
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    for (const line of (batch.stdout || '').split('\n')) {
      const m = /^([0-9a-f]{40}) (\d+)/.exec(line.trim())
      if (m) sizeByHash[m[1]] = Number(m[2])
    }
  }
  // 工作区文件集合（相对路径），按归一化键索引（walkWorkspace 已跳过依赖/产物目录）
  const wByNorm = new Map(walkWorkspace(workspace).map((p) => [norm(p), p]))
  const impact = []
  const classified = new Set() // 已在快照中分类的归一化路径
  // 1) 快照有的文件：当前无 → 删除；当前有且内容不同 → 还原
  for (const [p, blob] of Object.entries(S)) {
    if (isSkippedPath(p)) continue // 快照侧与被跳过的目录同步排除，避免误报 delete
    const n = norm(p)
    classified.add(n)
    const cur = wByNorm.get(n)
    if (!cur) {
      impact.push({ path: p, type: 'delete' })
      continue
    }
    let st
    try {
      st = fs.statSync(path.join(workspace, cur))
    } catch {
      impact.push({ path: p, type: 'delete' })
      continue
    }
    if (st.isFile() && st.size === sizeByHash[blob]) {
      let buf
      try {
        buf = fs.readFileSync(path.join(workspace, cur))
      } catch {
        impact.push({ path: p, type: 'restore' })
        continue
      }
      if (gitBlobHash(buf) !== blob) impact.push({ path: p, type: 'restore' })
    } else {
      impact.push({ path: p, type: 'restore' })
    }
  }
  // 2) 快照没有、工作区有 → 找回（本轮被删/改名弄丢，undo 后重现；兜底恢复的文件自然满足）
  for (const [n, cur] of wByNorm) {
    if (!classified.has(n)) impact.push({ path: cur, type: 'recover' })
  }
  impact.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { ok: true, impact }
}

// V2 快照补偿恢复：把工作区还原到 T_before（目标轮次前）状态
// V1 与 V2 的关键差异（实测确认，见迁移文档 §14）：
//   - V1：引擎 revert 能删除新增文件、还原被修改文件，仅「被改名/移动的旧文件」漏恢复 → 只需补缺失
//   - V2：引擎 revert 只裁剪会话，完全不触碰文件（阶段 stage/commit 后工作区不变）→ 必须由 XWork 完整补偿
// 策略（精确优先，避免误删用户文件）：
//   1) 被回退轮次触碰过的文件（union of assistant.snapshot.files）→ 存在 T_before 则还原内容，否则删除（该轮新建）
//   2) 兜底：T_before 中有、当前工作区缺失的文件（引擎未归因的漏网文件，如 shell 副作用）→ 还原
// 参数：git、snapshotDir、workspace、snapshot（T_before tree）、touchedFiles（相对路径数组）
// 返回：{ ok, restored:[], removed:[], skipped:[], reason? }
function restoreWorkspaceToSnapshot({ git, snapshotDir, workspace, snapshot, touchedFiles }) {
  if (!git || !workspace || !snapshot) return { ok: false, reason: 'no_git_or_args' }
  const repo = findSnapshotRepo(snapshotDir, workspace)
  if (!repo) return { ok: false, reason: 'no_snapshot_repo' }
  try {
    const t = execFileSync(git, ['--git-dir', repo, 'cat-file', '-t', snapshot], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (t !== 'tree') return { ok: false, reason: 'bad_snapshot' }
  } catch {
    return { ok: false, reason: 'bad_snapshot' }
  }
  let S
  try {
    S = listTree(git, repo, snapshot) // 相对路径 → blob hash
  } catch {
    return { ok: false, reason: 'list_failed' }
  }
  const byNorm = new Map(Object.entries(S).map(([p, b]) => [norm(p), { p, b }]))
  const restored = []
  const removed = []
  const skipped = []
  const writeBlob = (rel, blob) => {
    const abs = path.join(workspace, rel)
    try {
      const content = execFileSync(git, ['--git-dir', repo, 'cat-file', 'blob', blob], {
        encoding: 'buffer',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      return true
    } catch {
      return false
    }
  }
  // 触碰文件统一为「相对工作区」的归一化键（引擎可能给绝对路径，兼容两种）
  const wsNorm = norm(workspace)
  const want = new Map() // 归一化键 → 展示用相对路径
  for (const f of touchedFiles || []) {
    const s = String(f || '').replace(/\\/g, '/')
    const rel = norm(s).startsWith(wsNorm + '/') ? s.replace(/\\/g, '/').slice(wsNorm.length + 1) : s
    if (rel) want.set(norm(rel), rel.replace(/^\/+/, ''))
  }
  // 1) 被回退轮次触碰过的文件：还原或删除
  for (const [n, rel] of want) {
    if (isSkippedPath(n)) continue
    const hit = byNorm.get(n)
    const abs = path.join(workspace, rel)
    const exists = fs.existsSync(abs)
    if (hit) {
      if (!exists) {
        writeBlob(hit.p, hit.b) ? restored.push(hit.p) : skipped.push(hit.p)
      } else {
        try {
          const buf = fs.readFileSync(abs)
          if (gitBlobHash(buf) !== hit.b) {
            writeBlob(hit.p, hit.b) ? restored.push(hit.p) : skipped.push(hit.p)
          }
        } catch {
          skipped.push(hit.p)
        }
      }
    } else if (exists) {
      // T_before 无此文件 → 该轮新建，删除以回到回退前状态
      try {
        fs.rmSync(abs, { force: true })
        removed.push(rel)
      } catch {
        skipped.push(rel)
      }
    }
  }
  // 2) 兜底：T_before 有、当前缺失（引擎未归因的漏网文件）
  for (const [p, blob] of Object.entries(S)) {
    if (isSkippedPath(p)) continue
    if (want.has(norm(p))) continue
    if (!fs.existsSync(path.join(workspace, p))) {
      writeBlob(p, blob) ? restored.push(p) : skipped.push(p)
    }
  }
  return { ok: true, restored, removed, skipped }
}

module.exports = { restoreMissingFiles, restoreWorkspaceToSnapshot, collectUndoImpact }
