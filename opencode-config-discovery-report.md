# opencode（anomalyco/opencode，dev 分支 / V2 引擎）配置目录发现机制调研报告

> 调研日期：2026-10-14（基于 dev 分支当日 HEAD 与 npm registry / GitHub API 实时数据）
> 注意：`opencode.ai/docs` 是 V1 文档；V2 文档在 `opencode.ai/v2/docs`。本报告以 dev 分支源码为准。

## 0. 版本背景（先纠正一个前提）

- 仓库 monorepo 版本：`package.json` `name: "opencode"`，`version: "2.0.28"`（dev 分支）。
- npm 包 `opencode2`：曾在 2026-09-25（2.0.16）至 2026-10-13（2.7.53）之间发布 2.x 系列；**2026-10-13 之后该包名已被 npm 官方接管为 security holding package（latest = 0.0.1-security）**，即 `opencode2` 这个名字当前不可安装。
- `v2.6.0`（opencode2，2026-10-07T18:07 发布）是 npm 时间线中的一个历史版本；最新 npm 版本为 2.7.53（2026-10-13T12:49）。
- GitHub Releases 页面的 `v1.19.0` / `v1.18.35` 等 tag 是 V1 引擎（`packages/opencode/`，npm `opencode`）的发布；V2 走 npm 包发布。
- V2 的插件 SDK 包名是 **`@opencode/plugin`**（2026-09-07 PR #47852 迁移到 `@opencode` npm scope）；`@opencode-ai/plugin` 是 V1 的包名（V1 文档仍在用）。

## (a) 目录发现逻辑：源码级结论

### a.1 三层架构

V2 的发现逻辑分三层，全部在 `packages/core/src/` 下：

1. **Config roots 枚举** — `config/discovery.ts`（`ConfigDiscovery.discover`）：决定"哪些目录是配置根"。
2. **各域内部插件**（id 形如 `opencode.config.<domain>`）— 在 `config/plugin/agent.ts`、`command.ts`、`skill.ts`、`compatibility.ts`：对每个 config root 用 glob 模式扫描 markdown。
3. **插件目录发现** — `plugin/source-directory.ts`（`PluginSourceDirectory.discover`）。

### a.2 Config roots：`packages/core/src/config/discovery.ts`

```ts
const globalDirectory = AbsolutePath.make(global.config)                 // ~/.config/opencode（见 a.6）
const globalAgentsDirectory = AbsolutePath.make(path.join(global.home, ".agents"))   // ~/.agents
const globalClaudeDirectory = AbsolutePath.make(path.join(global.home, ".claude"))   // ~/.claude
...
yield* Effect.forEach([".claude", ".agents", ".opencode", ...names.toReversed()], (name) =>
  fs.resolve(path.join(parent, name)).pipe(...)   // 向上遍历每一级父目录都找这 4 类名字
)
...
return {
  system: ...,        // /Library/Application Support/opencode | /etc/opencode | %ProgramData%\opencode
  global: globalDirectory,
  project: /* 各级 .opencode 目录（含存在性） */,
  claude: [ ~/.claude, ...各级 .claude ],
  agents: [ ~/.agents, ...各级 .agents ],
  ...
} satisfies Sources
```

- 项目级：`fs.up({ start: location.directory })` 从当前目录**向上逐级**扫描 `.opencode`、`.agents`、`.claude`、`opencode.json(c)`。
- `Options.global === false` 时跳过 system/global 目录和 `~/.claude`、`~/.agents`（config.ts 注释）。
- 优先级（config.ts `load()`）：system → global → explicit(--config) → direct(路径上的 opencode.json) → project `.opencode`（近者覆盖远者）。

### a.3 各域扫描模式（对**每个** config root `<root>` = system 目录 / `~/.config/opencode` / 各级 `.opencode/`）

| 域 | 源文件 | glob 模式 | 实际路径 |
|---|---|---|---|
| agents | `config/plugin/agent.ts` | `{agent,agents}/**/*.md` | `<root>/agent/**/*.md`、`<root>/agents/**/*.md` |
| modes（V1 兼容，作为 primary agent 加载） | 同上 | `{mode,modes}/*.md` | `<root>/mode/*.md`、`<root>/modes/*.md`（`primary: true`，即强制 `mode: "primary"`） |
| commands | `config/plugin/command.ts` | `{command,commands}/**/*.md` | `<root>/command/**/*.md`、`<root>/commands/**/*.md` |
| skills | `config/plugin/skill.ts` | `{*.md,**/SKILL.md}` | `<root>/skill/`、`<root>/skills/`（`sources()` 里 `path.join(directory, "skill"|"skills")`） |
| plugins | `plugin/source-directory.ts` | 目录枚举 | `<root>/plugin/`、`<root>/plugins/` 下的 `.ts`/`.js` 文件、子目录、symlink |

关键代码（`config/plugin/agent.ts`）：

```ts
const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
const sourceDirectories = ["agent", "agents", "mode", "modes"] as const
```

关键代码（`config/plugin/command.ts`）：

```ts
const files = yield* fs.scan("{command,commands}/**/*.md", { cwd: directory, absolute: true, dot: true, symlink: true })
const sourceDirectories = ["command", "commands"] as const
```

嵌套路径成为 ID/命令名的一部分（`team/review.md` → `/team/review`）；agent 名去掉 `^(agent|agents|mode|modes)/` 前缀。

### a.4 `.claude` / `.agents` 兼容层：`config/plugin/compatibility.ts`

`Config.compatibility()`（config.ts）暴露 `claude` / `agents` roots（即 `~/.claude`、`~/.agents` + 项目各级 `.claude`、`.agents`），**目前只消费其 `skills` 子目录**：

```ts
const roots = config.compatibility ? yield* config.compatibility() : { claude: [], agents: [] }
const directories = [...roots.claude, ...roots.agents].map((root) => path.join(root, "skills"))
const files = yield* fs.scan("{*.md,**/SKILL.md}", { cwd: resolved, ... })
```

即 skills 额外从 `.claude/skills/`、`.agents/skills/`（项目各级）和 `~/.claude/skills/`、`~/.agents/skills/`（全局）加载。**`.agents` 下没有任何其他子目录被读取**（无 `.agents/agent`、`.agents/command`）。

### a.5 完整路径清单（V2 引擎实际扫描的所有目录）

**Agents**（markdown，frontmatter + 正文为 system prompt）：
- `~/.config/opencode/agent/**/*..md`、`~/.config/opencode/agents/**/*.md`
- `<系统目录>/agent(s)/**/*.md`（`/etc/opencode` 等）
- 项目各级 `.opencode/agent/**/*.md`、`.opencode/agents/**/*.md`
- （V1 兼容）各级 `.opencode/mode/*.md`、`.opencode/modes/*.md`

**Commands**：
- `~/.config/opencode/command|commands/**/*.md`
- `<系统目录>/command|commands/**/*.md`
- 项目各级 `.opencode/command|commands/**/*.md`
- （`.agents/commands` **不支持**，见 (b)）

**Skills**：
- `~/.config/opencode/skill|skills/`（`{*.md,**/SKILL.md}`）
- `<系统目录>/skill|skills/`
- 项目各级 `.opencode/skill|skills/`
- 项目各级 `.claude/skills/`、`.agents/skills/`；全局 `~/.claude/skills/`、`~/.agents/skills/`
- config `skills` 数组指定的任意目录 / `~/` 前缀 / http(s) URL（见 (c)）

**Plugins**：
- `<root>/plugin/`、`<root>/plugins/`（`.ts`/`.js` 文件 + 即时子目录 + symlink），root = `~/.config/opencode`、系统目录、各级 `.opencode/`
- config `plugins` 数组（npm 包、任意相对/绝对路径、file:// URL），相对路径相对包含它的 config 文件解析
- 项目根 `opencode.json` 旁的 `plugins/` 目录**不**自动发现（v2 文档明确）

**Modes**：V2 无独立 mode 子系统；`.opencode/mode|modes/*.md` 作为 primary agent 加载（上表）。V2 内建的 codemode 是 per-tool 开关，与目录发现无关。

### a.6 全局目录的确定：`packages/util/src/global.ts` + `global-roots.ts`

```ts
const app = "opencode"          // 目录名是 "opencode"，不是 opencode2
const { data, cache, config, state, tmp } = roots(app)
// global-roots.ts: config = $XDG_CONFIG_HOME || ~/.config  →  ~/.config/opencode
// global.ts layer: acquire({ config: process.env.OPENCODE_CONFIG_DIR ?? Path.config })
```

即全局 config 目录 = `~/.config/opencode`（macOS 同样走 XDG 风格，`app` 硬编码 `"opencode"`），可被 `OPENCODE_CONFIG_DIR` 或 `XDG_CONFIG_HOME` 改写。

## (b) `.agents` 支持现状与版本时间线

### 现状（dev HEAD）

`.agents` 目录**只支持 `skills` 子目录**（项目各级 + `~/.agents` 全局），由 `config/plugin/compatibility.ts` 加载。V1 引擎（`packages/opencode/`，v1.18/1.19）同样扫描 `.agents/skills`（PR #48976 确认 `packages/opencode/src/skill/index.ts` 自 cwd 向上扫 `.claude/skills` 与 `.agents/skills`）。

### `.agents/commands`：PR #27973 **未合并**

- PR #27973 "feat(config): load commands from .agents"：`state: closed`、`merged: false`、`merged_at: null`，2026-05-17 提交，2026-06-17 关闭（带 `automated-pr-cleanup` 标签，即被机器人清理关闭）。
- 它关闭的目标 issue #27972（请求 `.agents/commands`）因此未解决；更早的 #12486（同样请求）和 #12488（实现 PR）均以 stale 关闭。
- **结论：`.agents/commands` 在任何版本（2.0.x ～ 2.7.53，含 v2.6.0 和最新 dev）都不支持。**

### `.agents/agents`（自定义 agent 从 .agents 加载）

- 无任何实现，也无在途 PR。
- 相关在途提案只有 **PR #54594** "feat(core): load project config from `.agents/opencode`"（open，未合并，2026-10-11）：让 `.agents/opencode/` 整体成为项目 config 目录（agents/commands/skills/plugins 都从其中加载，同目录下 `.opencode` 优先）。其 PR 描述明确证实现状："Discovery already checks `.agents` at every level, but **only reads `.agents/skills`** from it."（对应 issue #47742 的 `.agents/<harness>/` 提案）。
- 功能请求 issue：#14240（可配置 command/agent 搜索路径，未实现）。

### 版本时间线（依据 npm registry `time` 与 PR 合并记录）

| 时间 | 事件 |
|---|---|
| ≤2026-09-03 | `.claude/.agents` roots + skills 加载已在 v2 代码中（#46925 重构时已存在；#47026 仅是 watch 修复） |
| 2026-09-25 | npm `opencode2@2.0.16`（registry 可见最早版本）→ **`.agents/skills` 自首个可见 npm 版本起就支持** |
| 2026-10-07 | `opencode2@2.6.0` 发布（`.agents` 支持与最新 dev 无差异：仍只有 skills） |
| 2026-10-13 | `opencode2@2.7.53`（最后一个版本）；随后包名被 npm security holding 接管 |
| dev HEAD | 同 v2.6.0：`.agents` 仍只读 `skills/` |

**CHANGELOG.md（dev，193 行）中没有任何 `.agents` 相关条目**（全文 grep 无命中），因此无法用 CHANGELOG 判定引入版本；以上时间线来自 PR 合并状态 + npm 发布时间交叉验证。

## (c) 扩展发现目录的可行性（权威依据）

### c.1 现有配置项 / 环境变量

| 机制 | 能力 | 依据 |
|---|---|---|
| config `skills` 数组 | **任意 skill 目录**：相对路径（相对项目 location）、绝对路径、`~/` 前缀、`http(s)://` URL（URL 经 SkillDiscovery.pull 拉取）。例：`"skills": ["../shared/skills", "~/my-skills", "https://..."]` | `config/plugin/skill.ts` `sources()`；仓库自身用 `.opencode/opencode.jsonc` 的 `"skills": ["packages/ui/skills"]`（PR #53485） |
| config `plugins` 数组 | **任意路径的插件**：`./relative`、`../shared/plugin.ts`、`/abs/path`、`file://` URL、npm 包（含版本/scoped/对象形式 `{package, options}`）；相对路径相对所在 config 文件解析 | `config/normalize.ts` L185-190（V1 `plugin` + V2 `plugins` 归一化）；v2 文档 /v2/docs/plugins |
| `OPENCODE_CONFIG_DIR` 环境变量 | 覆盖全局 config 目录（连带 agent/command/skill/plugin 的全局扫描根） | `packages/util/src/global.ts`（`layer` 中 `process.env.OPENCODE_CONFIG_DIR ?? Path.config`） |
| `XDG_CONFIG_HOME` | 移动整个 `~/.config` 根 | `packages/util/src/global-roots.ts` |
| Config `Options`（`global`/`system`/`project`/`file`） | 内部 API：可禁用全局/系统/项目来源 | `packages/core/src/config.ts` `Options` schema；非用户配置文件字段 |
| ❌ 通用 "额外扫描目录" 配置 | **不存在**；agents/commands 的扫描根固定为 config roots，无 `agents.paths`/`commands.paths` 类字段 | `config/plugin/agent.ts`/`command.ts` 源码；issue #14240（开放中的功能请求）；PR #41533 想加 `OPENCODE_DISABLE_AGENTS=1` 也未合并（当前无任何 disable 环境变量） |

### c.2 插件 API 能否动态注册 agents/commands/skills —— **可以**

包 `@opencode/plugin`（Promise API）与 `@opencode/plugin/effect`（Effect API），插件形态 `Plugin.define({ id, setup(ctx) })`：

- **可用 transform hooks**（`packages/plugin/src/README.md` 原文列举）：`ctx.agent.transform`、`ctx.command.transform`、`ctx.integration.transform`、`ctx.mcp.transform`、`ctx.model.transform`、`ctx.provider.transform`、`ctx.reference.transform`、`ctx.skill.transform`、`ctx.tool.transform`、`ctx.vcs.transform`、`ctx.websearch.transform`；配套 `ctx.<domain>.reload()`。
- **commands**：`ctx.command.transform((editor) => editor.add({ name, description, execute: async ({sessionID, prompt, delivery}) => {...} }))` —— 内建 command 插件（`config/plugin/command.ts`）正是这样注册 markdown 命令的。
- **skills**：`ctx.skill.transform((editor) => editor.add(skillInfo))` —— `config/plugin/compatibility.ts` 就是现成范例。
- **agents**：`ctx.agent.transform` 的 editor 只有 `list/get/default/update/remove`（**没有 `add()`**，添加 `AgentEditor.add()` 的 PR #50564 仍 open 未合并）。但底层 registry 的 `update()` 对不存在的 ID 会**插入**新 agent（`packages/core/src/agent.ts`：`const current = editor.agents.get(id) ?? Info.default(id); if (!editor.agents.has(id)) editor.agents.set(id, current)`），所以逐字段 update 即可注册全新 agent（README 示例亦演示此用法）。
- **读取任意目录**：`setup` 是异步的，README 明确建议"load asynchronous data before registering a transform"。插件运行在 Node/Bun 进程内，可用 `fs`/Bun API 读任意目录的 markdown，解析 frontmatter（引擎用 gray-matter，见 `config/markdown.ts`），再经上述 transform 注册 —— **因此"插件读取任意目录文件注册为 command/skill"完全可行，agent 可行（经 update）**。唯一的限制是编辑器回调本身必须同步；先异步读文件、再注册同步 transform 即可。
- **项目级插件启用**：`.opencode/plugins/*.ts`（或 `plugin/`）自动加载，无需配置；或写进 `plugins` 数组。npm 插件自动用 Bun 安装缓存到 `~/.cache/opencode/node_modules/`。内置不可禁用的插件：`opencode.config.policy`、`opencode.provider.opencode`。

### c.3 对 "把发现目录扩展到 .agents/agents 等位置" 的落地建议（依据以上事实）

1. 今天就能做：写一个 `.opencode/plugins/loader.ts`（或全局插件），在 setup 里 `fs.readdir` 任意目录（如 `.agents/agents/*.md`）→ `ctx.agent.transform` update 注册、`.agents/commands/*.md` → `ctx.command.transform` add 注册；
2. 纯配置可做：skills 用 `skills: ["<任意目录>"]`；插件本身用 `plugins: ["<任意路径>"]`；
3. 等上游：关注 #54594（`.agents/opencode` 作为项目 config 根）、#50564（AgentEditor.add）、#14240（可配置搜索路径）。

## (d) 来源 URL

源码（dev 分支 raw）：
- 目录枚举核心：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/config/discovery.ts
- config 管线与 compatibility roots：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/config.ts
- agents/modes 加载：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/config/plugin/agent.ts
- commands 加载：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/config/plugin/command.ts
- skills 加载 + `skills` 数组源：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/config/plugin/skill.ts
- .claude/.agents 兼容加载器：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/config/plugin/compatibility.ts
- 插件目录发现：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/plugin/source-directory.ts
- 全局目录：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/util/src/global.ts 、https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/util/src/global-roots.ts
- 插件 SDK 文档与 hooks 清单：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/README.md （包 `@opencode/plugin` 2.0.28）
- agent registry（update 插入语义）：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/agent.ts
- plugins 字段归一化：https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/config/normalize.ts

PR / issue：
- PR #27973（未合并）：https://github.com/anomalyco/opencode/pull/27973
- PR #54594（open，.agents/opencode 提案）：https://github.com/anomalyco/opencode/pull/54594
- PR #50564（open，AgentEditor.add）：https://github.com/anomalyco/opencode/pull/50564
- PR #41533（closed 未合并，OPENCODE_DISABLE_AGENTS）：https://github.com/anomalyco/opencode/pull/41533
- PR #46925 / #47026（已合并，watch/roots 修复）：https://github.com/anomalyco/opencode/pull/46925 、https://github.com/anomalyco/opencode/pull/47026
- PR #48976（V1 .agents/skills 文档佐证）：https://github.com/anomalyco/opencode/pull/48976
- PR #47852（迁移到 @opencode scope）：https://github.com/anomalyco/opencode/commit/a5312e169b13c0f08b93c4b6e0c3076c94785aca

版本数据：
- npm opencode2（含发布时间线与 security holding）：https://registry.npmjs.org/opencode2
- GitHub Releases（V1 tags）：https://api.github.com/repos/anomalyco/opencode/releases

文档站：
- V2 skills：https://opencode.ai/v2/docs/skills
- V2 agents：https://opencode.ai/v2/docs/agents
- V2 commands：https://opencode.ai/v2/docs/commands
- V2 plugins（配置）：https://opencode.ai/v2/docs/plugins
- V2 build/plugins（API/transform 参考）：https://opencode.ai/v2/docs/build/plugins
- V1 skills（交叉验证）：https://opencode.ai/docs/skills
