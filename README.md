<div align="center">

# XWork

**本地优先的可视化 AI 工作台**

`Windows x64` · `Electron 33` · `opencode V2` · `v0.7.1` · `MIT`

</div>

---

## 目录

- [这是什么](#这是什么)
- [界面与导航](#界面与导航)
- [核心能力](#核心能力)
  - [对话与模型](#对话与模型)
  - [可观察的执行过程](#可观察的执行过程)
  - [权限与安全](#权限与安全)
  - [工作区](#工作区)
  - [会话](#会话)
  - [定时任务](#定时任务)
  - [Hub 与 `.agents`](#hub-与-agents)
  - [统计](#统计)
  - [桌面集成](#桌面集成)
- [技术架构](#技术架构)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [开发与构建](#开发与构建)
- [配置与数据](#配置与数据)
- [项目结构](#项目结构)
- [已知边界](#已知边界)
- [常见问题](#常见问题)
- [文档](#文档)
- [License](#license)

---

## 这是什么

XWork 是一个面向 Windows 的桌面 AI 工作台：**Electron + React** 负责界面与宿主能力，**opencode V2** 作为执行引擎负责真正的模型调用与工具执行。

它不只是一个聊天窗口。模型可以读取工作区文件、执行命令、修改代码、启动子智能体、按 cron 无人值守地跑任务；XWork 负责把这些过程**可视化**，并在敏感操作前**停下来等你确认**。

### 设计原则

| 原则 | 含义 |
| --- | --- |
| **本地优先** | 会话、设置、任务、统计与日志都在本机；对外只访问你配置的模型 / 技能 / 更新服务 |
| **过程透明** | 思考、工具输入/输出、文件变更、子智能体过程都可回看，不是黑盒 |
| **可控执行** | 读取、编辑、命令、联网等操作分级授权，支持“允许一次 / 总是允许 / 拒绝” |
| **面向真实工作区** | 不是临时沙箱，直接在你的项目目录里协作，文件树与磁盘实时同步 |
| **Windows 原生体验** | 无边框窗口、托盘、系统通知、自动更新、内置引擎与 Git |

> 数据边界：应用数据默认只保存在本机；对外网络请求仅限你配置的模型服务商、技能服务地址与更新源。没有内置遥测上报。

---

## 界面与导航

主界面左侧是一条窄导航栏，包含 4 个顶层页面；设置固定在栏底，其下是主题切换按钮。

| 页面 | 作用 |
| --- | --- |
| **Work** | 对话主界面：会话列表（对话 / 工作区两个分栏）、消息流、输入区 |
| **定时任务** | 任务列表、执行概览、执行记录、cron 构造器 |
| **Hub** | 技能中心：浏览、安装、卸载技能包，重启引擎 |
| **设置** | 模型设置 / 界面设置 / 权限设置 / 配置 / 统计 / 关于 六个 tab |

窗口外壳：自绘无边框标题栏（左侧品牌与版本号、引擎状态点，右侧最小化 / 最大化 / 关闭）；引擎状态显示为「待选择工作区 / 就绪 / 未连接」。

---

## 核心能力

### 对话与模型

- **任意 OpenAI 兼容接口**：每组配置 `Base URL + API Key + 模型 ID`，一个组可包含多个模型
- 聊天框内即时切换模型与智能体；**模型绑定到会话**，切回会话自动恢复
- **连接测试**：请求 `{BaseURL}/models`（Bearer 认证，10s 超时），结果以气泡展示
- **常用模型记忆**：新会话默认选中发送次数最多的模型（已失效则留空等待选择）
- **推理强度（effort）**：`Default / Low / Medium / High`，作为发送参数下发，不写 `opencode.json`、不重启引擎；可在设置中关闭档位显示
- **流式揭示两档**：
  - **浮现**（默认）：模糊 → 清晰，按“出生时刻”分块
  - **打字机**：逐字揭示，带按需追赶
- **智能体选择器**：引擎内置智能体 + 工作区 `.agents` 自定义智能体（标注来源），子智能体只读展示
- **图片粘贴**：输入框内 `Ctrl+V` 直接粘贴截图，以缩略图呈现，随消息发给模型（引擎按 OpenAI `image_url` 协议传图）；支持多张、点击预览、单张删除
  - 格式 `PNG / JPEG / WebP`，单张 ≤ 4 MB、单次合计 ≤ 7 MB、单条 ≤ 10 张（超出会自动压缩降质，仍超限则拦截并提示）
  - 只发图片、不发文字也可以发送；切会话后历史消息里的图片仍可回看
  - 模型不支持视觉时，错误气泡里会补一句中文提示
  - 与「工作区 → @文件引用」相互独立
- **停止**：中止当前任务，并连带结束引擎派生的命令子进程树（避免残留 python 等外部进程）
- 上下文 Token 计数：显示最近一次成功回复的 `input + cache.read`，并支持一键压缩会话

消息支持 Enter 发送、Shift + Enter 换行。

### 可观察的执行过程

- **思考过程**按单段流式展开，段结束自动收起；用户点击后进入手动状态，已结束的块不会被再次自动收起
- **工具调用时间线**：`pending → running → completed / error`，命令卡片可展开查看输入、输出、错误与耗时；超长输出截断并支持展开全文
- **子智能体卡片**：阶段徽标（准备中 / 运行中 / 后台运行中 / 收尾中 / 完成 / 失败 / 已取消 / 状态未知）、活动行、结论、工具调用次数；支持「移到后台」「终止」「展开子会话」
- **子代理会话**：按事件镜像持续累积，从第一步开始保留；主会话与子会话切换不会重播或丢失增量
- **Markdown / GFM**、代码高亮与语言标签、KaTeX 公式、Mermaid 图表（异步渲染，失败保留源码）
- 助手消息可复制；用户消息 hover 出现「回退至此」，确认后回滚该轮及之后的全部 AI 变更
- **点状会话目录**：右侧每条用户消息一个圆点，滚动高亮，hover 显示摘要与时间，点击跳转
- 执行中提示行：正在思考 / 生成回复 / 执行命令 / 等待某个子智能体 / 正在停止
- 离页不断流：流式增量在后台继续累积，返回时从最新位置继续，不从头重放
- 流式跟随平滑：新行出现时逐帧滑动（单帧 ≤10px），不再整块上跳；用户上滑即停止跟随，系统开启「减少动态效果」时退化为直接到底

> 没有「重新生成」按钮，也没有斜杠命令（见 [已知边界](#已知边界)）。

### 权限与安全

设置 → 权限设置 覆盖 10 类操作：

| 操作 | 说明 |
| --- | --- |
| 读取文件 | 读取工作区内容 |
| 修改文件 | 编辑、新建、覆盖文件 |
| 执行命令 | 终端 / PowerShell 命令 |
| 文件查找 | glob 模式查找 |
| 内容搜索 | grep 文本搜索 |
| 网页抓取 | 抓取指定网页 |
| 联网搜索 | 搜索互联网 |
| 子智能体 | 启动子智能体并行处理 |
| 工作区外访问 | 访问当前工作区之外的路径 |
| 向用户提问 | AI 主动提问并等待回答 |

- 每项支持 **允许 / 询问 / 禁止**，并提供 **严格 / 标准 / 宽松** 预设
- 敏感操作弹出确认窗：允许一次 / 总是允许 / 拒绝；多个请求按队列逐个处理
- AI 提问支持单选项、多选项、自行输入与取消
- 权限保存后**热更新**生效，无需重启引擎
- **工作保护**：有会话或定时任务正在执行时，重启引擎、保存并生效、安装更新等操作会被拒绝，并提示等待或先停止任务
- 内部低风险动作（`skill`）固定放行，不打扰用户
- 引擎侧权限规则与存储键一一映射（详见 [权限映射](#权限映射)）

### 工作区

- **首次启动不设默认工作区**：安装目录永远不会被当成工作区，必须先明确选择；入口页同时列出最近使用
- 选择工作区后才会启动引擎；未选择时后端拒绝创建会话
- **静默 `git init`**：工作区建立时自动初始化 Git（undo 快照依赖），不会弹出任何提示
- **切换工作区不重启引擎**：依靠引擎的 `location` 机制，新会话带 `location.directory`，切换时只做配置热重载
- 侧栏「工作区」分栏：懒加载文件树，默认隐藏 `.git`、`node_modules`、`.opencode`、`.agents` 等目录；每 2 秒轮询同步磁盘变更
- 勾选文件即加入对话，发送时以 `@相对路径` 引用注入提示词
- 右键菜单：用系统程序打开 / 打开所在文件夹 / 复制路径
- 「所有工作区」：历史路径、会话数、最近使用；路径失效时显示删除线并可清理（同时删除该目录下的引擎会话）

### 会话

- 新建、双击重命名、删除、回看；空标题显示「未命名」
- **置顶与拖拽排序**：后置顶的排最前，仅置顶项可拖拽，顺序存 `localStorage`
- **回退（Undo）**：撤销某条用户消息及之后的全部 AI 变更
  - 引擎侧 `revert stage → commit` 负责裁剪会话
  - XWork 基于 Git 快照完整补偿文件：还原被改文件、删除本轮新建、找回被删/改名旧文件
  - 完成后展示实际影响清单（删除 / 还原 / 找回）
  - 无 Git 快照时明确失败（`no_git_snapshot`），不会误报成功
- **压缩会话**：把历史压缩成摘要，释放上下文空间
- **上下文 Token**：显示最近一次成功回复的 `input + cache.read`
- 子智能体会话下钻：查看完整过程、工具调用和最终报告
- 会话按工作区隔离：列表只显示当前工作区的根会话（子会话在父卡片里下钻）
- 会话列表按「最新回复时间」排序；子会话不占列表条目

### 定时任务

- 标准 **5 字段 cron**：分 / 时 / 日 / 月 / 周，支持 `*`、数字、逗号列表、`*/N` 步进（不支持 `1-5` 区间语法）
- **可视化构造器**：分钟 / 小时 / 日三选一（每 X / 每隔 N / 指定），月 / 周勾选，实时预览表达式与接下来 5 次运行时间
- 任务字段：名称 / 工作区 / 执行内容 / 模型与推理强度 / 频率 / 超时（默认 30 分钟）/ 重试（默认 2 次）
- 执行内容支持 `{{date}}`、`{{date:±Nd}}` 占位符（按执行时本地日期渲染）
- **全局串行 + FIFO 等待队列**
  - 同一时间只执行一个任务；忙时到点的任务不会被丢弃
  - 手动「立即执行」与定时触发共用队列
  - 排队期间被删除 / 禁用的任务自动丢弃
- **每次执行新建独立会话，结束后立即删除**，避免上下文累积导致模型复述指令
- 每任务保留最近 100 条执行记录（含尝试次数、时延、是否默认应答）
- 执行中自动应答 AI 提问（取第一个选项）并在历史中留痕
- 完成 / 失败 / 超时系统通知（窗口在前台时不打扰）
- 任务页提供：启用中、今日待执行、近 7 天执行、成功率四项概览，以及全部 / 已启用 / 已停用筛选与「近期执行」时间线
- 「启动时运行」（`@startup`）已移除：历史遗留任务在应用启动时会被自动删除

### Hub 与 `.agents`

- **Hub（技能中心）**：从技能服务拉取列表，一键安装 / 卸载到工作区 `.agents/skills`
  - 默认服务地址 `http://localhost:4321`（可在设置 → 配置修改）
  - 消费两个接口：`GET /api/skill/list`、`GET /api/skill/{id}/download`
  - 安装为 zip 解压，带 zip-slip 路径净化；卸载按 slug 删除目录并做白名单校验
- **工作区级自定义智能体与命令**：
  - `.agents/agents/**/*.md`、`.agents/commands/**/*.md`
  - 正文即提示词 / 命令模板；Front Matter 支持 `description`、`mode`、`model`、`agent`
  - 命令支持 `$ARGUMENTS`、`$1/$2`、无占位符追加参数、`` !`命令` `` 插值
- **目录联接桥接**：引擎只扫描 `.opencode`，XWork 把 `.opencode/agents`、`.opencode/commands` 链接到 `.agents`（仅这两个子目录；`skills` 由引擎原生加载）
- **Git 防污染**：三级判据 + `.opencode/.gitignore` 保护文件，避免 `.agents` 内容被 `git add` 物化进仓库；检测到已跟踪 / 真实目录 / 自定义 `.gitignore` 等情况会阻断并在界面提示
- **自检**：引擎启动后异步校验注册表是否收敛，未收敛给出提示
- **生效时机**：`.agents/agents`、`.agents/commands` 由引擎在扫描 `.opencode` 时加载，修改后需重启引擎（Hub 顶部的「重启引擎」，或退出后重开应用）；`skills` 由引擎原生加载，Hub 安装后无需重启应用；`.opencode` 侧改动可热更新

### 统计

设置 → 统计，只读展示，不影响任何配置：

- **总览四格**：总 Tokens / AI 请求 / 工具调用 / 连续使用
- **Token 构成**：输入、缓存读、输出、推理，并换算为「≈ N 万字 · 约 N 本《书》」
- **52 周活跃热力图**：颜色越深当天模型回合越多，悬浮显示日期与步数
- **工具榜**：调用次数、成功率、P50；**模型劳模榜**：按模型调用次数排序，标注「最勤劳」
- **事实四格**：最忙的一天 / 平均每条指令 / 缓存命中率 / 子智能体
- **你和 AI 的相处**：本地操作计数（回退 / 中止 / 拒绝 / 压缩 / 任务执行），不随区间变化
- 区间：近 7 天 / 近 30 天 / 今年 / 全部；数据来自引擎实验统计接口，旧引擎自动降级为基础统计
- 统计范围是**当前引擎会话库**，不含定时任务引擎的会话

### 桌面集成

- 暗色 / 亮色主题（左下角切换，选中即保存）
- 无边框自绘标题栏：最小化、最大化 / 还原、关闭；拖动标题栏移动，双击最大化
- 关闭动作可选「退出程序」或「最小化到系统托盘」；托盘单击恢复，右键菜单「显示主窗口 / 退出」
- 窗口不在前台时，AI 完成回复或提问、定时任务完成可弹 Windows 通知；点击通知恢复主窗口
- 自动更新：读取内网 Gitea 发布通道的 `latest.yml`，支持差分下载；检测到新版本后由你决定何时下载与安装
- 多开 XWork 共享同一个引擎进程：最后一个实例退出时才停止引擎
- F12 / Ctrl + Shift + I 可打开开发者工具（打包版同样生效）

---

## 技术架构

### 分层

```text
┌────────────────────────────── XWork (Electron) ──────────────────────────────┐
│                                                                              │
│  Renderer (React 18)                                                         │
│    App.jsx + 纯函数模块（typewriter / emerge / subagentModel / stats …）      │
│         │                                                                    │
│         │ window.xwork.*  (preload contextBridge，contextIsolation: true)     │
│         ▼                                                                    │
│  Main Process                                                                │
│    index / engine / bridge / settings / config / logger / undo /             │
│    tasks / task-runner / agents-bridge / agents-selfcheck / agents-list /    │
│    engine-status / stats-core / stats-counters                               │
│         │                                                                    │
│         │ HTTP REST + 全局 SSE（GET /api/event，Basic Auth）                  │
└─────────┼────────────────────────────────────────────────────────────────────┘
          ▼
   opencode V2 `serve`（127.0.0.1:4096）
          │
          │ 任务执行时另起一个隔离实例（数据目录 tasks/，端口 4096+1 起）
          ▼
   任务引擎（无人值守，全放行）
```

- **渲染层不接触 Node**：所有系统能力经 `preload` 暴露的 `window.xwork` 调用，主进程做校验与降权
- **主进程持有秘密**：API Key 只在主进程解密，渲染层只看到掩码值
- **桥接层做版本适配**：引擎的 V2 事件在 `bridge.js` 归一化成 V1 形状，渲染层与任务引擎无需感知引擎版本差异

### 主进程模块

| 模块 | 职责 |
| --- | --- |
| `index.js` | 应用生命周期、全部 IPC、窗口 / 托盘 / 通知 / 更新、设置保存、工作区、技能、统计聚合 |
| `engine.js` | 引擎探测、启动、健康检查、Basic Auth 密码派生、端口清理、退出监听 |
| `bridge.js` | V2 REST API 封装；全局 SSE 解帧与 V2→V1 事件归一化；分页 |
| `settings.js` | 设置存储、Key 加解密、生成 `opencode.json` 与身份 `AGENTS.md` |
| `config.js` | `app.config.json` 默认值与用户覆盖层合并（引擎端口固定 4096） |
| `logger.js` | 文件日志（1 MB × 5 轮转）、更新日志、渲染层日志转发 |
| `undo.js` | 基于 Git 快照的工作区补偿恢复与影响清单 |
| `tasks.js` | cron 解析、任务存储、调度器 |
| `task-runner.js` | 任务引擎生命周期、全局串行队列、重试、执行记录、通知 |
| `agents-bridge.js` | `.agents` → `.opencode` 目录联接、Git 防污染、摘链 |
| `agents-selfcheck.js` | 引擎侧 agent / command 注册表收敛式自检 |
| `agents-list.js` | 智能体列表轮询收敛与整形、并发合并 |
| `engine-status.js` | `engine:status` 返回体组装（含引擎世代号） |
| `stats-core.js` | 统计纯函数：区间、归一化、基础聚合、错误分类 |
| `stats-counters.js` | 本地操作计数持久化 |

### 引擎进程

- 随安装包分发 **opencode V2**（`resources/engine/opencode.exe`，当前 **v2.6.0**，约 196 MB）
- 启动命令：`serve --port 4096 --hostname 127.0.0.1`，工作目录 = 当前工作区
- **端口固定 4096**：配置与用户覆盖层都不能改写（多实例共享同一引擎）
- **强制 HTTP Basic Auth**
  - 用户名固定 `opencode`
  - 密码由 XDG 数据目录路径确定性派生（sha256），注入 `OPENCODE_SERVER_PASSWORD`
  - 同一数据目录的不同书写形式（盘符大小写、斜杠、尾分隔符）会归一化后再派生，保证多实例 / 重启后可复用
- **健康检查**：`GET /api/info` 必须返回 `content-type: json` 且含字符串 `version`；HTML 回退页（V1 引擎）判为不健康
- **端口清理**：启动前若端口被非本应用的进程占用，先 `taskkill` 再拉起新进程，避免 `EADDRINUSE`
- **XDG 重定向**：`XDG_CONFIG_HOME / XDG_STATE_HOME / XDG_DATA_HOME / XDG_CACHE_HOME` 全部指向应用数据目录，规避安全软件对用户目录的拦截
- **内置 MinGit**：`resources/git` 注入 `PATH` 最前；引擎快照 / undo 依赖 `git`，缺失时 revert 会静默失败
- 引擎以 `detached + unref` 启动（脱离实例进程树），父子退出互不连带；应用退出时按多实例规则显式停止

### 事件流模型

opencode V2 的 prompt 是**异步收件箱**语义：

1. `POST /api/session/{id}/prompt` 立即返回受理回执
2. 主进程订阅 `GET /api/event` 全局 SSE
3. `bridge.js` 把 V2 事件（`{type, data}`、事件名不同、扁平消息结构）归一化为 V1 形状（`{type, properties}`），逐条推给渲染层

关键映射（节选）：

| V2 事件 | 归一化输出 |
| --- | --- |
| `session.text.delta` / `session.text.ended` | `message.part.delta` / `message.part.updated` |
| `session.reasoning.*` | `message.part.updated`（桥内累积全文，带 `streaming` 标记） |
| `session.tool.input.started` / `.called` / `.progress` / `.success` / `.error` | `message.part.updated`（工具状态机） |
| `session.step.ended` / `.failed` | `message.updated`（finish / tokens / cost） |
| `session.execution.started` | `session.status`（busy） |
| `session.execution.succeeded` / `.interrupted` / `.failed` | `session.idle`（失败时另发 `session.error`） |
| `permission.asked` | `permission.asked`（action 映射回存储键） |
| `form.created`（question 类） | `question.asked`（选项、多选、自定义输入） |
| `session.retry.scheduled` | `session.retry`（引擎内请求级重试留痕） |

其他约定：

- 会话与消息列表按 **100 条 / 页** 翻页，保留 `cursor`，不会在超过 100 条时被静默截断
- `location` 查询参数必须写成 `location[directory]=...`（点号形态会被引擎静默忽略并回落启动目录）；对 `/api/agent`、`/api/command`、`/api/config` 还会校验响应里的 `location.directory` 回显

### 配置如何生效

设置保存时**优先热重载**：

1. 写入 `opencode.json`
2. `POST /api/location/reload`
3. 校验引擎读回的配置与刚写入的文件一致：
   - provider 集合完全一致（不留已删除的 `xgroup-*`）
   - 权限规则全部出现
   - `{env:VAR}` 引用的 Key 已注入且值指纹匹配
4. 校验通过 → 热生效；任一项不符 → **自动回退为重启引擎**

因此：改模型组 / 权限通常不重启；**新增或更换 API Key**、修改联网搜索配置（插件文件不会被热重载）会走重启分支。

### 工作区切换

V2 引擎一个进程可服务多个目录，会话自带 `location.directory`：

1. 持久化工作区路径
2. 静默 `git init`（已存在则跳过）
3. 记录引擎当前工作区
4. 建立 `.agents` 联接（必须在 reload 之前，引擎只在扫描 `.opencode` 时发现 `.agents`）
5. 引擎在运行：`POST /api/location/reload`；引擎未运行：直接以新工作区为启动目录拉起一次

切换过程**不重启进程**，正在运行的其他会话 / 任务不受影响。

### 任务引擎

定时任务使用**独立的引擎实例**，与主引擎隔离：

- 独立数据目录：`<引擎数据目录>/tasks`（config / data / state / cache 各自独立）
- 端口：从主引擎端口 `+1` 起探测，最多顺延 59 个
- 配置：引擎（重）启动时重写为「全放行」（一条通配 `allow`），无人值守时不弹确认框
- **不写快照**：任务引擎配置里显式 `snapshots: false`（引擎默认开启）。定时任务没有回退入口——会话即用即弃、执行历史只存摘要——快照只会白占磁盘；同时任务工作区也不再被静默 `git init`
- 执行：新建会话 → 发送 prompt → 监听全局事件直到 `session.idle` / `session.error` / 超时
- 提问：自动取第一个选项应答，并在历史中标记「已默认应答」
- 重试：任务级退避重试（第 N 次前等待 `N × 5s`），引擎内部的请求级重试只记日志
- 空闲 5 分钟无任务即回收引擎进程
- 引擎意外退出：执行中的任务立即标记失败（附退出码），随后按任务的重试配置决定是否重跑

### 回退（Undo）机制

V2 引擎的 `revert` **只裁剪会话，不恢复文件**，因此文件回滚完全由 XWork 完成：

1. 从消息流取目标轮次前的快照 `T_before`：
   - 优先取该轮首个 assistant 的 `snapshot.start`
   - 该轮无 assistant 时退化为上一条 assistant 的 `snapshot.end`
2. 收集目标轮及之后所有 `snapshot.files` 作为「被触碰文件」
3. `POST /api/session/{id}/revert/stage` → 暂存
4. 补偿：被触碰文件在 `T_before` 中有则还原内容，没有则删除（本轮新建）；再兜底还原 `T_before` 中缺失的文件
5. `POST /api/session/{id}/revert/commit` 裁剪会话
6. 对比 `stage.snapshot` 与当前工作区，生成影响清单（删除 / 还原 / 找回）

跳过 `node_modules`、`.git`、`dist` 等目录，避免大仓库下长时间阻塞。

### `.agents` 桥接

- 只桥接 `agents`、`commands` 两个子目录；`skills` 由引擎原生加载，不需要桥接
- 目录联接（junction）而非符号链接：删除只摘链接、不动目标
- Git 三级防御（顺序是硬约束）：
  1. 已有被跟踪内容 → 阻断
  2. `.opencode` 下已存在非空真实目录（常见于 clone）→ 阻断
  3. 用户自写 `.opencode/.gitignore` 且未忽略联接 → 阻断，不改用户文件
- 写入 `.opencode/.gitignore = *` 后，`git add` 不会穿透联接物化 `.agents` 内容
- 关闭桥接开关时遍历所有已知工作区摘链；开关本身没有 UI，需编辑 `xwork-settings.json`

### 联网搜索

- 仅使用 **DeepSeek 兼容 Search API**（`.../tools/search`）
- Key 用 `safeStorage`（Windows DPAPI）加密保存
- 保存时发一次最小验证请求（12s 超时）；只有 2xx 且返回 `results` 数组才算有效
- 验证通过：生成 `xwork-deepseek-search` 本地插件，`websearch.provider` 固定为 `xwork-deepseek`
- 未配置 / 验证失败：写入 `websearch: false`、删除插件、**整个联网搜索不可用**
- **不回退**到 Exa / Firecrawl / Parallel / Tavily / TinyFish，也不会静默切换服务商

### 多实例

- 多个 XWork 实例共享同一引擎（固定端口 + 确定性密码）
- 活跃实例 PID 记录在 `<数据目录>/engine-instances.json`
- 仅当最后一个存活实例退出时才停止引擎，其它实例的退出不会中断服务

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面运行时 | Electron `33.4.11` |
| 界面 | React `18.3.1`、lucide-react `1.61.0` |
| 构建 | electron-vite `2.3.0`、Vite `5.4.21` |
| 渲染 | marked `18`（GFM）、highlight.js `11`、KaTeX `0.18`、Mermaid `11` |
| 打包 / 更新 | electron-builder `26.15.3`、electron-updater `6.8.9` |
| 工具 | Node.js `18+`、npm、JSZip `3.10`（技能包解压） |
| 执行引擎 | opencode **V2**（随包 `v2.6.0`，独立二进制） |
| 版本控制能力 | 内置 MinGit `2.55.0`（undo 快照 / 桥接防污染） |

---

## 快速开始

### 使用安装包（推荐）

当前构建产物：

- 安装包：`app/release/XWork-Installer-0.7.1.exe`（约 207 MB）
- 免安装版：`app/release/win-unpacked/XWork.exe`

安装包已包含：

- Electron 运行时
- opencode V2 引擎（`resources/engine/opencode.exe`）
- 内置 MinGit（`resources/git`）

目标机器**无需**预装 Node.js、opencode 或 Git。安装器为 NSIS 向导式，可自定义安装目录（会在所选目录下追加 `XWork` 文件夹），并创建桌面 / 开始菜单快捷方式。

### 首次启动

1. 打开应用，Work 页会要求**先选择一个工作区**（可选最近使用，或打开文件夹）
2. 选择后 XWork 会在该目录**静默 `git init`**，然后启动本地引擎（首次启动通常需要十几秒，等待上限 20 秒）
3. 进入设置 → 模型设置，添加至少一个模型组（Base URL / API Key / 模型 ID），点「测试连接」确认可用，再「保存并生效」
4. 回到 Work，在输入区选择模型即可开始对话

> 没有选择工作区时引擎不会启动，也无法创建会话——这是刻意的安全设计，避免把安装目录当作工作区。

### 从源码运行

环境要求：

- Windows 10/11 x64
- Node.js 18+ 与 npm
- 一个可用的 **opencode V2** 可执行文件（V1 不兼容）

一键启动：

```powershell
start-xwork.bat
```

或手动：

```powershell
cd app
npm install
npm run dev
```

开发模式的行为：

- 引擎数据目录固定为仓库根目录 `.opencode-home`（由 `scripts/dev.mjs` 注入 `XWORK_OPCODE_HOME`）
- 开放 `9222` 远程调试端口，供验收脚本连接
- 主进程日志写入 `app/logs/`；引擎的启动输出在启动失败时会一并落到 `main.log`

#### 准备 V2 引擎

开发模式下引擎按以下顺序查找：

1. `XWORK_OPENCODE_PATH` 环境变量
2. npm 全局 `opencode2` 的平台包

因此最稳妥的方式是直接指向随包引擎（若本地已有）：

```powershell
# 在仓库根目录执行
$env:XWORK_OPENCODE_PATH = "$PWD\app\resources\engine\opencode.exe"
```

也可以尝试安装 npm 包（该包名为历史渠道，可用性随上游发布策略变化）：

```powershell
npm i -g opencode2 --registry=https://registry.npmmirror.com
```

验证版本：

```powershell
# 在仓库根目录执行
& "$PWD\app\resources\engine\opencode.exe" --version
# opencode v2.6.0
```

> **只兼容 opencode V2**。V1（`opencode-ai`、1.18.x 等）缺少 `/api/info`、强制认证与异步 prompt 语义，XWork 会拒绝复用，打包脚本也会直接中止。

---

## 开发与构建

### 常用命令

```powershell
cd app

npm run dev         # 开发模式（electron-vite dev + 调试端口 9222）
npm run build       # 构建 out/（主进程 + preload + renderer），不打安装包
npm run build:dist  # 构建并生成 NSIS 安装包
npm run icon        # 重新生成应用图标
```

没有 `npm test` 脚本；测试与验收脚本位于 `app/scripts/`，按需用 `node` 直接运行。

### 打包

```powershell
cd app
npm run build:dist
```

`build-dist.mjs` 依次执行：

1. `electron-vite build` → `out/`
2. `build/icon.ico` 缺失时自动生成
3. 探测并复制 opencode V2 引擎到 `resources/engine/opencode.exe`，**校验版本号为 v2.x**（非 V2 直接中止）
4. 内置 MinGit 缺失时下载（npmmirror 优先，GitHub 回退）到 `resources/git`
5. 清理输出目录（Windows 文件被占用时重试）
6. `electron-builder --win nsis`，默认 `--publish never`

输出：

- `app/release/XWork-Installer-0.7.1.exe`
- `app/release/XWork-Installer-0.7.1.exe.blockmap`
- `app/release/latest.yml`
- `app/release/win-unpacked/`

可选环境变量：

| 变量 | 作用 |
| --- | --- |
| `XWORK_OUT_DIR` | 输出到指定目录（相对 `app/` 或绝对路径），避免覆盖正在运行的 `release/` |
| `XWORK_OPENCODE_PATH` | 指定打包来源的 opencode V2 可执行文件 |
| `XWORK_PUBLISH=always` | 打包后按配置的发布通道上传（默认 `never`） |
| `XWORK_GIT_EXE` | 覆盖桥接 / undo 使用的 git 可执行文件 |
| `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` | 覆盖内置的 npmmirror 镜像 |

> 打包前关闭正在运行的 XWork；`release/win-unpacked` 被占用时 electron-builder 无法替换文件。
> 无法关闭时可使用 `$env:XWORK_OUT_DIR = "release-tmp"`。

### 发布与更新

更新源是**内网 Gitea 发布仓库**，不是 GitHub：

- 发布仓库：`http://192.168.102.11:3004/xuwenrui/XWork/releases`
- 更新解析：`app/app.config.json` → `updateSource.latestApi`（Gitea API 取最新 tag）+ `downloadBase`（拼出该 tag 的资产目录）
- 打包发布：`app/package.json` → `build.publish`

发布时通常需要同时上传：

- `XWork-Installer-<version>.exe`
- `XWork-Installer-<version>.exe.blockmap`
- `latest.yml`

应用内「检查更新」读取 `latest.yml`，检测到新版本后由用户点击下载，支持差分或整包。安装更新前会检查是否有会话 / 任务在跑。

> [PACKAGING.md](PACKAGING.md) 中「发布到 GitHub Releases」一节是早期历史内容；当前发布通道是上面的内网 Gitea 仓库，不需要 `GH_TOKEN`。

### 测试与验收

`app/scripts/` 下有三类脚本：

- **纯逻辑单测**（无需 GUI / 引擎）：`test-settings.cjs`、`test-v2-normalize.cjs`、`test-stats.cjs`、`test-effort.cjs`、`test-agents-list.cjs`、`test-subagent-model.mjs`、`test-subagent-list.mjs`、`test-typewriter-catchup.mjs`、`test-emerge.mjs`、`test-renderer-decl-order.mjs`、`test-main-build-manifest.cjs`
- **联调 / 验收**（需要真实引擎或运行中的应用）：`test-agents-bridge*.cjs`、`test-v2-integration.cjs`、`accept-*.mjs`、`e2e-*.mjs`、`smoke-packaged.mjs`
- **一次性诊断 / 尖刺**：`diag-*.mjs`、`check-*.mjs`、`spike-*.mjs`、`ws-*.mjs`、`get-messages.mjs`、`obs-stream.mjs`

桥接相关的聚合回归：

```powershell
cd app
node scripts/test-agents-bridge-all.cjs
```

> 注意：除 `dev.mjs`、`build-dist.mjs`、`gen-icons.mjs`、`lib/v2-bridge.mjs`、`smoke-packaged.mjs`、`v2-openapi.json` 外，`scripts/` 下的测试 / 验收 / 诊断脚本都**未纳入 git**（见 `app/.gitignore`），属于本地开发资料。E2E 脚本依赖 9222 调试端口或 `release/win-unpacked`，部分脚本含本机绝对路径，换机后需先调整。

`v2-openapi.json` 是引擎 V2 HTTP API 的契约快照（113 个端点），供人工排查 `location` 等参数形态；`lib/v2-bridge.mjs` 是测试脚本复用主进程 `Bridge` 的 ESM 包装。

### 新增主进程模块时

`app/electron.vite.config.mjs` 的 `main.build.rollupOptions.input` 是**显式入口清单**。新增 `src/main/*.js` 后必须同步加一行，否则构建不报错、但运行时 `Cannot find module './xxx'`（0.6.4 曾因此事故）。`test-main-build-manifest.cjs` 会校验源码 require、清单与 `out/main` 三者一致。

---

## 配置与数据

### 数据目录

优先级：

1. 环境变量 `XWORK_OPCODE_HOME`
2. 打包版：`%APPDATA%\XWork\opencode`
3. 开发版：仓库根目录 `.opencode-home`（由 `scripts/dev.mjs` 设置）

> 变量名是 `XWORK_OPCODE_HOME`（历史拼写），不是 `XWORK_OPENCODE_HOME`。

### 目录布局

```text
<XDG_HOME>/
  xwork-settings.json          # 应用设置（模型组、权限、主题、effort、搜索…）
  xwork-workspaces.json        # 工作区注册表
  xwork-tasks.json             # 定时任务与每任务最多 100 条执行历史
  xwork-counters.json          # 本地操作计数（undo / abort / permissionDeny / compact / taskRuns）
  engine-instances.json        # 多实例共享引擎的活跃 PID
  config/
    opencode2/
      opencode.json            # 引擎配置：providers + permissions + websearch + plugins
      AGENTS.md                # 固定身份指令（以 XWork 身份出现、默认中文回复）
      xwork-deepseek-search/   # 联网搜索 provider 插件（仅验证通过时存在）
        package.json
        index.js
  data/
    opencode2/
      opencode.db              # 会话 / 消息数据库
      snapshot/                # 引擎写入的 Git 快照（undo 依赖）
      repos/ shell/ log/
  state/  cache/
  tasks/                       # 任务引擎独立数据目录（同样含 config/data/state/cache）
```

> 旧版本的 `config/opencode`、`data/opencode`（V1）目录会保留但不再使用，与 V2 数据互不干扰。

### 设置文件

| 文件 | 内容 |
| --- | --- |
| `xwork-settings.json` | `modelGroups`、`modelUsage`、`workspace`、`theme`、`streamReveal`、`closeAction`、`notifyTask`、`effort`、`permission`、`websearch`、`config`（用户覆盖层）、`agentsBridge` |
| `xwork-workspaces.json` | 历史工作区、最近使用、会话数 |
| `xwork-tasks.json` | 任务定义 + 最近 100 条执行记录 |
| `xwork-counters.json` | 5 个本地计数器 |
| `config/opencode2/opencode.json` | provider 列表、有序权限规则、`websearch`、搜索插件路径 |

设置页「配置」保存的是用户覆盖层，与 `app.config.json`（仅存在于源码目录，不打进安装包）合并后生效；窗口尺寸需重启应用，隐藏列表即时生效。

### 权限映射

存储层使用固定键名，生成引擎配置时转换为 V2 的 action：

| 设置项 | 引擎 action |
| --- | --- |
| `read` | `read` |
| `edit` | `edit` |
| `bash` | `shell` |
| `glob` | `glob` |
| `grep` | `grep` |
| `webfetch` | `webfetch` |
| `websearch` | `websearch` |
| `task` | `subagent` |
| `external_directory` | `external_directory` |
| `question` | `question` |
| （内部） | `skill` 固定 `allow` |

### Key 如何保存

- 模型 API Key 与搜索 API Key 通过 Electron `safeStorage`（Windows DPAPI）加密
- `xwork-settings.json` 中保存 `enc:` 密文；渲染层只看到掩码 `••••••`
- 写入 `opencode.json` 时使用 `{env:XWORK_KEY_<组ID 大写并去掉非字母数字>}` 引用（如 `XWORK_KEY_XGROUP_AOTA0Z8HUX`）
- 引擎启动时把明文 Key 注入环境变量
- **明文 Key 不写入引擎配置文件**

### 日志

- 打包版：`<exe 目录>/logs/`（不可写时回退 `%APPDATA%\XWork\logs`）
- 开发版：`app/logs/`
- `main.log`：1 MB 轮转，保留 5 份；渲染层 `warn/error` 也会转发进来（打包版）
- `updater.log`：自动更新日志
- 设置 → 关于 → 「日志」可直接打开日志目录

### 更新源

| 配置 | 值 |
| --- | --- |
| `app/app.config.json` → `updateSource.latestApi` | `http://192.168.102.11:3004/api/v1/repos/xuwenrui/XWork/releases/latest` |
| `app/app.config.json` → `updateSource.downloadBase` | `http://192.168.102.11:3004/xuwenrui/XWork/releases/download` |
| `app/package.json` → `build.publish` | generic provider，指向同一内网仓库 |

---

## 项目结构

```text
XWork/
├─ app/
│  ├─ src/main/                Electron 主进程（15 个模块，见上表）
│  ├─ src/preload/index.js     contextBridge API（window.xwork.*）
│  ├─ src/renderer/
│  │  ├─ index.html
│  │  └─ src/
│  │     ├─ App.jsx            主界面、设置、任务、Hub、统计、子智能体、消息渲染
│  │     ├─ main.jsx           入口 + 白屏兜底 ErrorBoundary
│  │     ├─ styles.css         全量样式与主题变量（亮 / 暗）
│  │     ├─ typewriter.mjs     打字机揭示算法
│  │     ├─ emerge.mjs         浮现揭示算法
│  │     ├─ emergeDom.mjs      浮现的 DOM 包裹
│  │     ├─ sendButtonMorph.mjs 发送 ↔ 停止按钮形变插值
│  │     ├─ sessionList.mjs    会话列表纯函数（子会话过滤、置顶排序）
│  │     ├─ subagentLiveStore.mjs 子智能体摘要节流订阅 + 事件镜像
│  │     ├─ subagentModel.mjs  子智能体状态 / part 归一化
│  │     ├─ imageAttach.mjs    图片附件纯函数（尺寸换算、上限判定、载荷组装）
│  │     └─ stats.mjs          统计格式化与聚合辅助
│  ├─ scripts/                 开发启动、打包、图标、测试与验收脚本
│  ├─ resources/
│  │  ├─ engine/               随包分发的 opencode V2（打包时复制，未入库）
│  │  └─ git/                  内置 MinGit 2.55.0（随仓库提供）
│  ├─ build/                   图标源（logo.jpg / logo.svg）、installer.nsh、electron-dist.zip（未入库）
│  ├─ release/                 NSIS 安装包与 win-unpacked（未入库）
│  ├─ out/                     构建产物（未入库）
│  ├─ app.config.json          应用默认配置（窗口、隐藏列表、轮询与超时）
│  └─ package.json             electron-vite / electron-builder 配置
├─ 功能设计文档/                设计稿、实测记录与静态预览（本地资料，未入库）
├─ ui-mockup/                  官网演示用静态界面原型（未入库）
├─ _v2spike/                   V2 迁移调研与尖刺工作区（未入库）
├─ _shots/                     UI 校对截图（未入库）
├─ .agents/skills/             本地示例技能（未入库）
├─ CHANGELOG.md                按时间倒序的更新记录（本地资料，未入库）
├─ PACKAGING.md                打包与发布细节（含 V2 迁移注意事项）
├─ opencode-config-discovery-report.md  引擎配置目录发现机制调研
├─ start-xwork.bat             开发一键启动
└─ README.md
```

> 仓库实际跟踪的内容只有 `README.md`、`PACKAGING.md`、`opencode-config-discovery-report.md`、`start-xwork.bat`、`.gitignore` 与 `app/`（含 `app/src`、`app/scripts` 中的少数脚本）。上表中标注「未入库」的目录属于本地开发资料，clone 后不会存在。

---

## 已知边界

- **仅 Windows x64**：依赖 NSIS 打包、PowerShell、`netstat` / `taskkill`、NTFS 目录联接
- **仅 opencode V2**：V1 引擎不兼容；V1 时代的会话数据也不会自动迁移
- **引擎端口固定 4096**：多开共享同一引擎；端口被非本应用占用时会清理占用者
- **定时任务全局串行**：同一时间只跑一个任务，忙时排队（不丢弃）
- **定时任务需要有效工作区**：工作区被删除 / 移动后任务会失败并提示
- **图片只支持粘贴**：入口是输入框 `Ctrl+V`，暂无拖拽入框与「选图」按钮；格式仅 `PNG / JPEG / WebP`（GIF / SVG / PDF 不支持）
- **图片能力取决于所选模型**：XWork 默认按「模型支持图片输入」下发，不支持视觉的模型会由服务商报错（错误气泡会给出中文提示）
- **无斜杠命令、无「重新生成」**：消息操作只有复制与回退
- **统计不包含定时任务会话**：统计读取当前主引擎的会话库
- **联网搜索只支持 DeepSeek 兼容接口**，且验证失败即整体关闭
- **`.agents/agents`、`.agents/commands` 修改需重启引擎**：引擎只在扫描 `.opencode` 时加载它们（`skills` 不受影响）

---

## 常见问题

### 启动提示找不到执行引擎

开发模式：

```powershell
$env:XWORK_OPENCODE_PATH = "D:\path\to\opencode.exe"   # 指向 V2 可执行文件
```

或安装 npm 包：

```powershell
npm i -g opencode2 --registry=https://registry.npmmirror.com
```

打包版会使用随包的 `resources/engine/opencode.exe`；缺失说明安装不完整。

### 提示引擎版本不是 V2

本机全局安装的是 V1（`opencode-ai`，如 1.18.x）。XWork 只接受 V2：请改用 `opencode2` 的可执行文件，或显式设置 `XWORK_OPENCODE_PATH`。

### 引擎一直未就绪

查看 `logs/main.log`：

- **401**：Basic Auth 密码不匹配（通常是另一数据目录的实例占用了端口）
- **EADDRINUSE**：端口被占用；正常启动流程会先清理占用者，失败时检查安全软件拦截
- **引擎进程退出**：查看引擎启动日志与安全软件记录

### 首次启动不能发消息

没有选择工作区时引擎不会启动，后端也会拒绝创建会话。先在 Work 页选择或打开一个文件夹。

### `.agents` 修改不生效

引擎的变更监听只覆盖 `.opencode`，而 `.agents` 是通过目录联接暴露的。新增 / 修改 / 删除 `.agents` 下的 agent 或 command 后，需要：

- Hub 顶部的「重启引擎」
- 或重新打开工作区

### `.opencode` 目录可以删除吗

不要手动删除 `.opencode/agents`、`.opencode/commands`。它们是 XWork 创建的目录联接，重新打开工作区会自动重建。

如果 git 已跟踪 `.opencode/**`，XWork 会阻断桥接并在界面提示，避免把 `.agents` 内容物化为静态副本提交。

### 打包失败：release 目录被占用

关闭正在运行的 XWork、资源管理器预览、编辑器预览后重试；或输出到独立目录：

```powershell
$env:XWORK_OUT_DIR = "release-build"
cd app
npm run build:dist
```

### 打包后启动报 `Cannot find module './xxx'`

新增的主进程模块没有登记到 `app/electron.vite.config.mjs` 的 `input` 清单。补一行后重新构建；可提前检查：

```powershell
cd app
node scripts/test-main-build-manifest.cjs
```

### 搜索 API 配置后仍显示禁用

检查：

- API 地址是否是完整的 `.../tools/search`
- Key 是否有效
- 服务是否返回 `results` 数组

验证失败时 XWork 会主动把权限行改为「禁止」并删除搜索插件；这是**失败关闭**行为，不是回退失败。

### 回退提示没有 Git 快照

undo 依赖工作区的 `.git` 与引擎快照。以下情况无法回退文件：

- 工作区不是 Git 仓库（XWork 只会在工作区建立时自动 `git init`，中途删除 `.git` 会导致后续轮次无快照）
- 目标消息之前没有任何 assistant 快照
- 内置 git 与系统 git 都不可用

### 多开 XWork 会互相影响吗

不会互相停止：所有实例共享同一引擎，最后一个实例退出时才停引擎。但正在执行的任务会阻止重启引擎 / 安装更新（工作保护）。

### 定时任务为什么在等待

任务执行是全局串行的。前一个任务未结束时，到点任务会进入 FIFO 队列；「立即执行」同样排队，不会丢失。任务页会显示执行中 / 排队状态。

### 模型调用报 `DEPTH_ZERO_SELF_SIGNED_CERT`

企业零信任客户端（如 aTrust）拦截了引擎的 HTTPS 请求：导出企业根证书并让引擎加载（`NODE_EXTRA_CA_CERTS`），或把引擎进程与模型域名加入放行清单。

---

## 文档

- [更新日志](CHANGELOG.md)（本地资料，未入库）
- [打包与发布](PACKAGING.md)
- [V1 → V2 迁移设计](功能设计文档/迁移文档.md)（含引擎行为实测结论）
- [Undo 功能设计](功能设计文档/undo功能设计.md)、[回退功能测试报告](功能设计文档/回退功能测试报告.md)
- [定时任务功能设计](功能设计文档/定时任务功能设计.md)
- [`.agents` 目录 junction 桥接设计](功能设计文档/agents目录junction桥接设计.md)
- [子智能体前端表现设计](功能设计文档/subagent前端表现设计.md)
- [统计页功能设计](功能设计文档/统计页功能设计.md)
- [推理强度（effort）功能设计](功能设计文档/模型effort参数功能设计.md)
- [打字机功能设计](功能设计文档/打字机功能设计文档.md)
- [多模态图片支持功能设计](功能设计文档/多模态图片支持功能设计.md)（2026-08-10 旧稿：B+C 兜底方案，已被下篇取代其落地路径）
- [对话框图片粘贴功能设计](功能设计文档/对话框图片粘贴功能设计.md)（设计稿 v1.0，待实现；图片走引擎 `files[].uri` data URL，按 OpenAI `image_url` 协议传给模型）
- [引擎配置目录发现机制调研](opencode-config-discovery-report.md)

---

## License

MIT
