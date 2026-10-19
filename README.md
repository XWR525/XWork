# XWork

基于 [opencode](https://opencode.ai) 的桌面端可视化 AI 工作台（Electron + React）。

以 `opencode serve` 为本地执行引擎，提供对话式 AI 交互、任务执行全过程可视化、关键操作人机确认与工作区文件协作，让 AI 的每一步操作透明可控。模型 API Key 本地加密存储，数据不出本机。

## 特性

### 对话与模型
- 多模型组配置：任意 OpenAI 兼容接口（Base URL + API Key + 模型 ID），可添加多个模型组，每组多个模型
- 聊天框内选择本次对话模型，切换会话自动恢复其绑定的模型
- 模型组「测试连接」按钮（`GET /models` 带 Bearer 认证，气泡反馈结果）
- 最常用模型自动默认：新对话与启动空会话默认选中使用次数最多的模型（按发送计数统计）

### 过程可视化
- 思考过程以可折叠引用块展示，流式输出期间实时累积
- 工具调用全程可见：状态流转（pending → running → completed / error）、输入输出、命令输出实时刷新
- 打字机流式吐字 + 完成后无缝切换完整 Markdown 渲染
- 一键停止正在运行的任务（引擎 abort 端点）

### 人机确认
- 权限策略：读取 / 修改文件 / 执行命令 / 联网搜索 / 子智能体等 11 类操作，按「允许 / 询问 / 禁止」三档配置（含严格 / 标准 / 宽松预设）
- 敏感操作弹窗确认：允许一次 / 总是允许 / 拒绝
- AI 主动提问（question 工具）：选项或自由输入作答，也可拒绝

### 工作区
- 打开 / 切换文件夹作为工作区（引擎随工作区重启，AI 在此目录内读写文件）
- 文件树：懒加载展开、隐藏常见大目录、实时同步磁盘变化（资源管理器新增 / 删除文件 2 秒内反映）
- 勾选文件以 `@文件名` 引用形式附加到消息，AI 直接读取其内容
- 文件右键：系统默认程序打开 / 在资源管理器中定位
- 所有工作区列表：历史目录、会话数、最近使用；路径已不存在时标记删除线并支持一键删除

### 会话管理
- 新建 / 重命名（双击标题）/ 删除 / 回看
- 置顶与拖拽排序（本地持久化）
- **回退（undo）**：user 气泡左侧「回退至此」→ 轻确认 → 撤销该轮及之后全部 AI 变更（引擎 revert + 快照补偿恢复，改名 / 移动的旧文件自动找回），回退完成后展示实际影响清单（删除 / 还原 / 找回）并刷新消息列表与文件树（详见 [功能设计文档/undo功能设计.md](功能设计文档/undo功能设计.md)）
- **压缩会话**：输入区「压缩」按钮，将历史对话压缩为摘要以换取上下文空间（引擎 summarize，需指定总结模型）
- **上下文 Token 统计**：输入区实时显示当前会话上下文长度（最近一次成功回复的 input + cache.read）

### 定时任务
- 标题栏「⏰ 定时任务」入口进入任务管理页；固定使用 build 模式执行
- **cron 可视化构造器**：标准 5 字段表达式（分/时/日/月/周），每行「每 / 每隔 N / 指定列表」三态单选，月/周勾选框，实时表达式预览 + 「接下来 5 次运行时间点」；主进程手写解析器支持 `*` / 数字 / 逗号列表 / 步进 `*/N`，本地时区解释（详见 [功能设计文档/定时任务功能设计.md](功能设计文档/定时任务功能设计.md)）
- 任务要素：名称 / 工作区 / 执行内容+模型 / 执行频率 / 超时与重试次数；内容支持 `{{date}}`、`{{date:±Nd}}` 占位符（按执行时刻渲染）
- **全局串行 + 等待队列**：同一时间仅执行一个任务；执行器忙时（如手动触发 A）新到点的定时任务 B 排队挂起，A 结束后按 FIFO 自动执行——不因 busy 被丢弃；手动「立即执行」与定时触发共用同一队列；同一任务重复触发防重，排队期间被删除 / 禁用的任务自动丢弃本次触发
- **执行记录**：每任务保留最近 100 条历史（状态 / 摘要 / 耗时 / 实际尝试次数 / 是否已默认应答），列表内联展开 + 独立「详情」面板全文展示
- 每次执行新建独立会话（即用即弃），避免固定会话上下文累积导致模型复述指令而不执行；任务执行中发起提问自动默认应答并留痕
- 任务完成/失败/超时按「任务通知」开关弹系统通知；支持工作区选择（含登记新工作区）
- 已停用「启动时运行」（@startup）：不再提供该入口，存量任务自动清理

### 界面与系统
- 暗色 / 亮色主题
- 设置面板（模型设置 / 界面设置），支持「保存并重启引擎」
- 自绘无边框标题栏（最小化 / 最大化 / 关闭）
- **任务通知**：AI 完成回复或发起提问时，窗口不在前台则弹 Windows 系统通知（点击恢复窗口）
- **关闭时最小化到托盘**：托盘图标 + 右键菜单（显示主窗口 / 退出），首次最小化有系统通知
- **技能市场（Skill Hub）**：浏览 / 安装 / 卸载技能（`.agents/skills`），安装后引擎自动加载
- **`.agents` 自定义智能体与命令**：工作区 `.agents/agents/*.md`、`.agents/commands/*.md` 由引擎自动加载（无需放进 `.opencode`）——见下节- 文件日志：主进程 + 渲染进程日志落盘，1MB 轮转保留 5 份
- 自动更新（打包版，基于 GitHub Releases 的 electron-updater，支持差分更新）

## `.agents` 目录：自定义智能体与命令

XWork 让工作区 `.agents/` 下的自定义智能体与命令模板**被引擎直接加载**，不必放进 `.opencode/`。`.agents/` 因此可以作为跨工具共享目录（技能放 `skills/`，智能体放 `agents/`，命令放 `commands/`）。

### 文件约定

**`.agents/agents/**/*.md`** —— 正文即系统提示词

```markdown
---
description: 代码审查专家     # 可选
mode: subagent                # 可选，primary | subagent，缺省 subagent
model: xgroup-x/gpt-x         # 可选，provider/model
---
你是一个代码审查专家……
```

**`.agents/commands/**/*.md`** —— 正文为命令模板

```markdown
---
description: 审查当前变更      # 可选
agent: reviewer               # 可选，执行前切换智能体
model: xgroup-x/gpt-x         # 可选，执行前切换模型
---
请审查以下内容：$ARGUMENTS
```

- **命名**：相对路径去掉 `.md`，`/` 保留 —— `commands/web/search.md` → `/web/search`；`agents/team/deep.md` → `team/deep`
- **模板**：`$ARGUMENTS`、`$1/$2`、无占位符时自动追加参数、`` !`命令` `` 插值 —— **与直接写在 `.opencode` 下完全一致**（引擎原生实现，XWork 不做任何转译）
- 只支持**复数**目录名 `agents` / `commands`（`skills` 亦为复数，由引擎原生加载，无需任何桥接）

### 生效时机（重要）

| 操作 | 何时生效 |
| --- | --- |
| 新增 `.agents/**/*.md` | **需重启引擎**（设置页「保存并重启引擎」，或重新打开工作区） |
| 修改已有文件内容 | **需重启引擎** |
| 删除文件 | 需重启引擎 |

> 引擎的变更监听只识别 `.opencode` 路径下的变更，而 `.agents` 是通过目录联接（junction）暴露的，因此经 `.agents` 侧的增删改**不会**热生效。放在 `.opencode/` 下的文件则可以秒级热生效——这是两者唯一的体验差异。

### XWork 做了什么（`.opencode` 从何而来）

为了让引擎发现这些文件，XWork 在**每次打开工作区时**确保存在两个目录联接，把它们指向 `.agents`：

```
<工作区>/.opencode/agents    →  .agents/agents
<工作区>/.opencode/commands  →  .agents/commands
```

因此工作区里会出现一个 `.opencode/` 目录（文件树中已隐藏）。请注意：

- **不要手动删除** `.opencode/agents` 与 `.opencode/commands`（它们是联接；删掉后重新打开工作区会自动重建）；
- 若你自己写了 `.opencode/.gitignore`，XWork **不会覆盖**它；
- 你仍然可以像往常一样直接使用 `.opencode/agent/`、`.opencode/command/`（单数或复数都可），两种方式共存。

### git 安全（重要）

git 会**穿透**目录联接：若 `.opencode/` 未被忽略，`git add -A` 会把 `.agents` 里的内容当作普通文件提交到 `.opencode/**` 路径，别人 clone 后会得到一份**静态副本**、而 `.agents` 并不存在 —— 之后你改 `.agents` 将不再生效。

XWork 的防护：打开工作区时检查 `.opencode` 是否被忽略，未忽略则写入 `.opencode/.gitignore`（内容 `*`）使其自我忽略。

若该工作区**已有被 git 跟踪的 `.opencode/**` 内容**（例如你自己提交过 `.opencode/opencode.json`），XWork **不会擅自改动**，而是**跳过桥接并在界面提示**。要启用桥接需按提示处置：

1. 若你跟踪的是**自己的配置文件** → 把它从索引移除（`git rm --cached <路径>`），或接受它被忽略；
2. 若跟踪的是**已被物化的联接内容**（`.opencode/agents/**`、`.opencode/commands/**`）→ 按此顺序处理，顺序错了会二次丢内容：
   1. 先恢复 `.agents/{agents,commands}` 的目标目录与文件（`.agents` 通常被 git 忽略，clone 出来的工作区里没有它）；
   2. `git rm --cached -r .opencode/agents .opencode/commands`
   3. 删除已被物化的真目录 `.opencode/{agents,commands}`
   4. 重新打开工作区（桥接会自动重建）

### 关闭 / 清理

在 `xwork-settings.json` 里设置（**需重启应用**，无 UI 开关）：

```json
{ "agentsBridge": { "enabled": false } }
```

关闭后 XWork 会遍历所有已注册工作区摘除联接；若 `.opencode` 内只剩 XWork 写入的 `.gitignore`，该目录一并清理（你自写的文件与目录绝不会被删除）。

### 限制

- 仅复数目录名；不支持 `.agents/agent`、`.agents/command`
- 不支持 `temperature` 字段（引擎无此字段）
- 跨卷 / 网络盘 / 非 NTFS 工作区无法创建联接，桥接会被跳过（仅提示，不影响其它功能）

> 实现细节与全部实测依据见 [功能设计文档/agents目录junction桥接设计.md](功能设计文档/agents目录junction桥接设计.md)。

## 架构

```
┌──────────────────────────── XWork (Electron) ────────────────────────────┐
│  渲染进程 (React, App.jsx)                                               │
│    │ window.xwork.*（preload contextBridge）                             │
│    │ ←── engine:event（IPC，全局事件流转发）                              │
│ 主进程 (index / engine / bridge / settings / undo / tasks / task-runner / config / logger / agents-bridge / agents-selfcheck) │
│    │ HTTP REST + 全局 SSE (GET /api/event)                                │
└────┼─────────────────────────────────────────────────────────────────────┘
     ▼
opencode V2 serve（127.0.0.1:4096，本地无头引擎，强制 Basic Auth）
```

- **任务引擎**：定时任务使用独立的 opencode 进程（端口自 4096 顺延动态探测，独立数据目录），随任务工作区 / 设置变化重启。
- **主进程**：管理 opencode 子进程生命周期（探测 / 启动 / 健康检查 / 崩溃重启 / 工作区切换换进程）、IPC 桥、设置与 Key 存储、文件日志；定时任务由 `tasks`（cron 解析 / 存储 / 调度器）与 `task-runner`（任务引擎生命周期 / 全局串行执行 / 等待队列 / 重试 / 结果持久化）承载。
- **preload**：通过 `contextBridge` 向渲染层暴露受控的 `window.xwork.*` API，渲染层 `console` 转发至主进程日志。
- **渲染层**：React 单页应用（对话流 + 消息内联任务展示 + 文件树 + 设置面板 + 定时任务管理页）。
- **桥接层**（`bridge.js`）：调用 opencode V2 REST API（`/api/*`，Basic Auth）；实时事件走**全局事件流** `GET /api/event`（per-session 事件端点不可用，故不用），并在桥内把 V2 事件**归一化**为渲染层沿用的 V1 事件名与消息结构（`{info, parts}`），使渲染层与任务引擎无需感知 V2 差异。
- **消息发送**：V2 为异步收件箱模型 —— `POST /api/session/{id}/prompt` 立即返回受理回执，首个 step 完成由事件等待（`message.updated` / `session.idle`，归一化自 `session.execution.*`）确定；流式增量（`session.text.delta` 等）经归一化后驱动实时渲染。
- **`.agents` 桥接**（`agents-bridge.js` / `agents-selfcheck.js`）：引擎启动前（`engine.start()` 的**唯一封装** `startEngineWithBridge`）在工作区建立 `.opencode/{agents,commands}` → `.agents/{agents,commands}` 目录联接，并做 git 防污染（索引检查为硬闸门，随后用**探针路径**复验忽略规则，必要时写 `.opencode/.gitignore`）。引擎就绪后异步跑**收敛式自检**：按 `location[directory]` 查询 `/api/agent`、`/api/command` 并校验响应回显（不带 location 会永远返回引擎启动目录的注册表，热切换后会查错工作区），轮询至"连续两次样本相等且含期望条目且不跌破峰值 90%"才判成功。阻断与未收敛经 `engine.bridge.warning` 事件在界面提示。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron 33 |
| 前端 | React 18 + Vite 5（electron-vite 构建） |
| Markdown | marked（GFM + breaks） |
| 打包 / 更新 | electron-builder 26（NSIS 安装器）、electron-updater 6 |
| 执行引擎 | opencode **V2**（npm `opencode2`，`serve` 模式，HTTP + SSE + Basic Auth） |

## 环境要求

- Windows x64
- Node.js 18+ 与 npm（开发 / 打包）
- opencode **V2** 引擎：打包版随安装包分发；开发模式需本机可探测（见下）
- Git：内置 MinGit 随打包版分发（undo / 任务工作区快照开箱即用）；开发模式无内置 MinGit 时需本机安装 Git

## 快速开始（开发）

```powershell
# 一键启动（首次自动 npm install）
start-xwork.bat

# 或手动
cd app
npm install
npm run dev
```

`npm run dev`（`scripts/dev.mjs`）会把引擎数据目录固化到项目根 `.opencode-home`，并开放 9222 调试端口供验收脚本使用。

## opencode V2 引擎

- **探测顺序**：打包版 `resources/engine/opencode.exe`（V2 二进制，实际文件名为 opencode2.exe）→ 环境变量 `XWORK_OPENCODE_PATH` → npm 全局安装目录（`opencode2` / `opencode2-windows-x64`）。
  开发模式安装：`npm i -g opencode2 --registry=https://registry.npmmirror.com`。
  ⚠️ V1 引擎（`opencode-ai`，如 1.18.x）**不兼容**：无 `/api/info`、无强制认证、prompt 为同步语义。
- **启动**：`opencode2 serve --port 4096 --hostname 127.0.0.1`，启动前将 `XDG_*` 环境变量（含 `XDG_CACHE_HOME`）重定向到引擎数据目录（规避安全软件对用户目录写入的拦截）。
- **认证**：V2 强制 HTTP Basic Auth（用户名固定 `opencode`）。XWork 按引擎数据目录**确定性派生**密码并注入 `OPENCODE_SERVER_PASSWORD`：同机多实例 / 应用重启后可复用同一引擎；外部进程因密码不同而健康检查失败，会被端口预清理接管。
- **健康检查**：`GET /api/info`（校验响应为 JSON 且含 `version`；老引擎回退 HTML 的 200 不再被误判为健康）。
- **复用**：端口上已有本应用的健康引擎时直接复用（`owned=false`）；切换工作区 / 保存并重启引擎时强制拉起新进程。
- **工作区**：引擎以工作区目录为启动目录（会话按项目隔离），因此切换工作区需重启引擎（数秒）。
- **数据目录（V2 布局）**：`<引擎数据目录>/config/opencode2`、`data/opencode2`（SQLite `opencode.db`、`snapshot/` 快照库）、`state`、`cache`。
  与 V1 的 `opencode` 目录并存互不干扰；**引擎不支持 V1 会话迁移**（升级后旧会话不出现在列表中，降级不受影响）。
- **回退（undo）**：V2 的 staged revert 只裁剪会话、**不恢复文件**，XWork 按被回退轮次的 `snapshot.files` 做完整补偿（还原/删除）并生成影响清单（详见 `功能设计文档/迁移文档.md`）。

## 配置与数据

所有数据存放于引擎数据目录（开发：`<仓库根>/.opencode-home`；打包：`<userData>/opencode`；可用环境变量 `XWORK_OPCODE_HOME` 覆盖）。

| 文件 | 说明 |
| --- | --- |
| `xwork-settings.json` | 应用设置：`modelGroups`（模型组）、`permission`（权限策略）、`theme`、`workspace`、`modelUsage`（模型使用统计）、`agentsBridge`（`.agents` 桥接开关，默认启用；**手工编辑需重启应用**——`load()` 有实例级缓存） |
| `xwork-workspaces.json` | 工作区注册表（历史目录 + 最近使用 + 会话数） |
| `xwork-tasks.json` | 定时任务存储：任务定义 + 执行历史（上限 100 条/任务） |
| `config/opencode/opencode.json` | 引擎配置：每个模型组写入一个 `xgroup-*` provider；全局权限规则 |
| `data/`、`state/` | opencode 运行时数据与会话存储 |

- **模型 Key**：`apiKey` 经 Electron safeStorage（Windows DPAPI）加密存储（`enc:` 前缀）；写入 `opencode.json` 时以 `{env:XWORK_KEY_<组ID>}` 引用，引擎启动时注入环境变量，**明文 Key 不落盘**。
- **模型组 ID**：`xgroup-<...>`，同时作为 opencode.json 的 provider key，会话绑定模型后保持稳定。
- **内置 MinGit**：打包版随包分发 `resources/git`（MinGit 2.55.0），引擎 PATH 优先注入，undo 与任务工作区 git 快照开箱即用、不依赖用户机器安装 Git；开发模式依次回退系统 git。
- **日志**：`main.log`（1MB 轮转 × 5）与 `updater.log`；打包版位于 exe 旁 `logs/`，开发版位于 `app/logs/`。设置页可一键打开日志目录。

## 目录结构

```
app/                        Electron 应用（源码 + 构建配置）
  src/main/                 主进程：index（IPC）/ engine（进程管理）/ bridge（引擎 API 桥）/ settings（设置与 Key）/ undo（回退兜底恢复）/ tasks（cron 解析 + 任务存储 + 调度器）/ task-runner（任务执行器：串行队列 / 重试 / 持久化）/ config（应用配置）/ logger / agents-bridge（.agents 联接与 git 防污染）/ agents-selfcheck（收敛式自检判据）
  src/preload/              contextBridge 桥接层
  src/renderer/             React 渲染层（App.jsx / styles.css / main.jsx）
  scripts/                  dev.mjs（开发启动）/ build-dist.mjs（一键打包）/ gen-icon.mjs（图标生成）/ test-agents-bridge*.cjs（`.agents` 桥接回归，`test-agents-bridge-all.cjs` 一次跑完）
  resources/                engine/（内置 opencode.exe）、git/（内置 MinGit，undo 依赖）
  build/                    图标与本地 Electron zip（打包用）
  release/                  打包产物（NSIS 安装器 / win-unpacked）
CHANGELOG.md                更新日志（按时间倒序）
PACKAGING.md                打包与发布指南
功能设计文档/                设计文档：undo功能设计.md、回退功能测试报告.md（真实 AI 13/13 通过）、定时任务功能设计.md、多模态图片支持功能设计.md
ui-mockup/                  界面静态演示（html 原型，与真实 UI 同步演进）
.agents/skills/             内置技能（changelog 更新日志 / code-review 代码审查 / greeting）
start-xwork.bat             开发一键启动脚本
```

## 打包与发布

完整流程见 [PACKAGING.md](PACKAGING.md)。

- 产物：`app/release/XWork-Installer-<版本>.exe`（NSIS 向导安装器，内含 Electron 运行时与 opencode 引擎，目标机器无需预装 Node.js / opencode）。
- 本地打包：`cd app && npm run build:dist`（默认仅产本地，不上传）。
- 发布更新：配置 `GH_TOKEN` + `XWORK_PUBLISH=always` 后运行同一命令，产物自动上传 GitHub Releases；应用内「检查更新」据此检测并下载新版本。

## 许可

MIT
