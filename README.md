<div align="center">

# XWork

**本地优先的可视化 AI 工作台**

`Windows x64` · `Electron 33` · `opencode V2` · `v0.6.5` · `MIT`

---

## 这是什么

XWork 是一个基于 **Electron + React** 的桌面 AI 工作台，以本地 **opencode V2** 为执行引擎。

它不只是一个聊天窗口：模型可以读取工作区文件、执行命令、修改代码、启动子智能体、运行定时任务；XWork 负责把这些过程可视化，并在敏感操作前停下来等你确认。

- **本地优先**：会话、设置、任务记录和日志都在本机
- **过程透明**：思考、工具输入/输出、文件变更、子智能体过程可回看
- **可控执行**：读取、编辑、命令、联网等操作分级授权
- **面向真实工作区**：不是临时沙箱，直接在你的项目目录里协作
- **Windows 桌面体验**：托盘、系统通知、自动更新、无边框窗口

> XWork 的模型请求会发送到你配置的模型服务商；除此之外，应用数据默认只保存在本机。

---

## 核心能力

### 对话与模型

- 任意 **OpenAI 兼容** 接口：每组配置 `Base URL + API Key + 模型 ID`
- 一个模型组可包含多个模型，聊天框内即时切换
- 每个会话独立绑定模型，切回会话自动恢复
- 模型组「测试连接」：请求 `/models`，气泡展示结果
- 常用模型自动记忆：新对话默认选中发送次数最多的模型
- **推理强度** 档位：默认 / 低 / 中 / 高；只影响发送参数，不重启引擎
- 流式揭示两种模式：
  - **浮现**：模糊到清晰
  - **打字机**：逐字输出
- 停止按钮可中止当前任务，并保留已输出内容

### 可观察的 AI 过程

- **思考过程**按单段流式展开，段结束自动收起
- 用户点击后进入手动状态：流式中可立即收起，已结束的思考块手动展开后不再自动收起
- **工具调用时间线**：`pending → running → completed / error`
- 命令卡片可展开查看输入、输出、错误和耗时
- 子智能体卡片支持状态、后台完成、过程下钻和独立会话查看
- 子代理会话按事件镜像持续累积，切换视图不会丢失中间输出
- Markdown / GFM、代码高亮、KaTeX 公式、Mermaid 图表
- 消息底部的复制、回退和停止操作

### 权限与安全

设置页的「权限设置」覆盖 10 类操作：

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

每项支持 **允许 / 询问 / 禁止**，并提供 **严格 / 标准 / 宽松** 预设。

- 敏感操作弹出确认窗：允许一次 / 总是允许 / 拒绝
- 多个权限请求按队列逐个处理
- AI 提问支持选项、补充输入和拒绝
- 权限修改即时热更新，无需重启引擎

### 联网搜索：严格受控

默认使用 DeepSeek 兼容的 Search API：

- 在「权限设置 → 联网搜索」填写 **API 地址** 和 **API Key**
- Key 由 Electron `safeStorage`（Windows DPAPI）加密保存
- 保存时发送一次最小验证请求
- 验证通过后只使用内置 `xwork-deepseek` provider
- 未配置、401/403、超时或响应不兼容时：
  - 配置写入 `websearch: false`
  - 删除本地搜索插件
  - 完全禁用联网搜索
  - **不回退**到 Exa / Firecrawl / Parallel / Tavily / TinyFish
- 搜索失败不会静默切换到其它服务商

### 工作区与文件

- 打开 / 切换本地文件夹作为工作区
- 引擎以工作区为当前目录，AI 的文件操作都发生在这里
- 文件树懒加载，默认隐藏 `.git`、`node_modules`、`.opencode`、`.agents` 等目录
- 磁盘变更轮询同步（默认 2 秒）
- 勾选文件以 `@文件名` 附加到消息
- 右键用系统程序打开 / 在资源管理器中定位
- 多工作区注册表：历史路径、最近使用、会话数
- 路径失效时标记删除线并支持清理

### 会话管理

- 新建、重命名、删除、回看
- 置顶与拖拽排序，本地持久化
- **回退（Undo）**：撤销某一轮及之后的 AI 变更
  - 引擎 staged revert 负责裁剪会话
  - XWork 基于 snapshot 做文件补偿
  - 覆盖删除、还原、找回；完成后展示实际影响清单
- **压缩会话**：把历史压缩成摘要，释放上下文空间
- **上下文 Token 统计**：显示最近一次成功回复的 `input + cache.read`
- 子智能体会话下钻：查看子会话的完整过程、工具调用和最终报告

### 定时任务

- 标准 5 字段 cron，可视化构造器
- 支持 `*`、数字、逗号列表、`*/N` 步进
- 实时预览表达式和接下来 5 次运行时间
- 任务字段：名称 / 工作区 / 执行内容 / 模型 / 频率 / 超时 / 重试
- 内容支持 `{{date}}`、`{{date:±Nd}}` 占位符
- **全局串行 + FIFO 等待队列**
  - 同一时间只执行一个任务
  - 忙时到点的任务不会被丢弃
  - 手动「立即执行」与定时触发共用队列
  - 排队期间被删除 / 禁用的任务自动丢弃
- 每次执行新建独立会话，避免上下文累积
- 每任务保留最近 100 条执行记录
- 执行中自动应答 AI 提问并留痕
- 完成 / 失败 / 超时系统通知

### Skill Hub 与 `.agents`

- **Skill Hub**：浏览、安装、卸载技能到 `.agents/skills`
- 技能服务地址默认 `http://localhost:4321`
- 支持工作区级自定义智能体和命令：
  - `.agents/agents/**/*.md`
  - `.agents/commands/**/*.md`
- 正文即提示词 / 命令模板，Front Matter 支持 `description`、`mode`、`model`、`agent`
- 命令支持 `$ARGUMENTS`、`$1/$2`、无占位符追加参数、`` !`命令` `` 插值
- 为兼容引擎扫描路径，XWork 会把 `.opencode/agents`、`.opencode/commands` 链接到 `.agents`
- 自动做 git 防污染，避免 `.agents` 内容被当作 `.opencode` 静态副本提交
- `.agents` 侧修改需重启引擎后生效；`.opencode` 热更新不受影响

### 统计与桌面集成

- **用量统计**：
  - Token 构成、会话 / 指令 / 工具调用
  - 52 周活跃热力图
  - 工具与模型使用排行
  - 本地操作计数：回退 / 中止 / 拒绝 / 压缩 / 任务执行
  - 近 7 天 / 近 30 天 / 今年 / 全部
- 暗色 / 亮色主题
- 无边框自绘标题栏：最小化、最大化、关闭
- 关闭动作可选「退出」或「最小化到托盘」
- 窗口不在前台时，AI 完成回复或提问可弹 Windows 通知
- 自动更新：从内网 Gitea 发布通道读取版本与安装包

---

## 技术架构

```text
┌────────────────────────────── XWork (Electron) ──────────────────────────────┐
│                                                                              │
│  React Renderer                                                              │
│    App.jsx / components / styles                                             │
│         │                                                                    │
│         │ window.xwork.*  (preload contextBridge)                            │
│         ▼                                                                    │
│  Electron Main Process                                                       │
│    index / engine / bridge / settings / undo / tasks / task-runner /         │
│    agents-bridge / agents-selfcheck / config / logger / stats                │
│         │                                                                    │
│         │ HTTP REST + global SSE (GET /api/event)                            │
└─────────┼────────────────────────────────────────────────────────────────────┘
          ▼
  opencode V2 serve (127.0.0.1:4096, Basic Auth)
```

### 主进程模块

| 模块 | 职责 |
| --- | --- |
| `index.js` | 应用生命周期、IPC、窗口 / 托盘 / 通知、设置保存、更新 |
| `engine.js` | opencode 子进程探测、启动、健康检查、崩溃重启、Basic Auth |
| `bridge.js` | V2 REST API 封装；全局 SSE 归一化为前端消息结构 |
| `settings.js` | 设置存储、Key 加密、provider/权限写入 `opencode.json` |
| `undo.js` | 基于快照的工作区补偿恢复 |
| `tasks.js` | cron 解析、任务存储、调度器 |
| `task-runner.js` | 任务引擎、全局串行队列、重试、执行记录 |
| `agents-bridge.js` | `.agents` → `.opencode` 目录联接与 git 防污染 |
| `agents-selfcheck.js` | 引擎侧 agent/command 注册表收敛式自检 |
| `stats-core.js` / `stats-counters.js` | 本地统计聚合与操作计数 |
| `config.js` / `logger.js` | 有效配置合并、文件日志 |

### 引擎与数据隔离

- 主引擎固定 `127.0.0.1:4096`
- V2 强制 HTTP Basic Auth：
  - 用户名固定 `opencode`
  - 密码由 XDG 数据目录确定性派生，注入 `OPENCODE_SERVER_PASSWORD`
  - 同机重启 / 多实例可复用同一数据目录的引擎
- 健康检查使用 `GET /api/info`，校验 JSON 中的 `version`
- 任务引擎：
  - 独立数据目录：`<引擎数据目录>/tasks`
  - 从主引擎端口 `+1` 起探测空闲端口
  - 与主引擎隔离，任务结束后可回收

### 流式事件模型

opencode V2 使用异步收件箱：

1. `POST /api/session/{id}/prompt` 返回受理回执
2. 前端通过全局 SSE 接收增量
3. 主进程 bridge 将 V2 事件归一化为：
   - `message.part.updated`
   - `message.part.delta`
   - `session.idle`
4. 渲染层维护流式缓存，切换会话 / 页面不丢增量
5. 单段 reasoning 通过 `streaming` 标记独立控制展开/收起

---

## 快速开始

### 使用安装包

当前构建产物：

- 安装包：`app/release/XWork-Installer-0.6.5.exe`
- 免安装版：`app/release/win-unpacked/XWork.exe`

安装包已包含：

- Electron 运行时
- opencode V2 引擎
- 内置 MinGit

目标机器无需预装 Node.js、opencode 或 Git。

### 从源码开发

环境要求：

- Windows 10/11 x64
- Node.js 18+
- npm
- 开发模式需要本机可探测的 opencode V2（也可用 `XWORK_OPENCODE_PATH` 指定）

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

开发模式使用仓库根目录的 `.opencode-home` 作为引擎数据目录，并开放 `9222` 调试端口供验收脚本连接。

安装 opencode V2：

```powershell
npm i -g opencode2 --registry=https://registry.npmmirror.com
```

或者：

```powershell
$env:XWORK_OPENCODE_PATH = "D:\path\to\opencode2.exe"
```

> XWork 只兼容 opencode **V2**。V1（`opencode-ai`、1.18.x 等）缺少 `/api/info`、强制认证和异步 prompt 语义，不能使用。

---

## 开发与构建

### 常用命令

```powershell
cd app

npm run dev         # 开发模式
npm run build       # 构建 out/（主进程 + preload + renderer）
npm run build:dist  # 构建并生成 NSIS 安装包
npm run icon        # 重新生成应用图标
```

### 打包

```powershell
cd app
npm run build:dist
```

输出：

- `app/release/XWork-Installer-0.6.5.exe`
- `app/release/win-unpacked/`

可选环境变量：

| 变量 | 作用 |
| --- | --- |
| `XWORK_OUT_DIR` | 将打包产物输出到指定目录，避免覆盖正在运行的 `release/` |
| `XWORK_OPENCODE_PATH` | 指定打包用的 opencode V2 可执行文件 |
| `XWORK_PUBLISH=always` | 打包后按配置的发布通道上传 |

> 打包前关闭正在运行的 XWork；`release/win-unpacked` 被占用时 electron-builder 会无法替换文件。
>
> 如果暂时不能关闭应用，可使用 `XWORK_OUT_DIR=release-tmp` 先生成到独立目录。

### 发布与更新

更新源是**内网 Gitea 发布仓库**，不是 GitHub：

- 发布仓库：`http://192.168.102.11:3004/xuwenrui/XWork/releases`
- `app/app.config.json` → `updateSource.latestApi` / `downloadBase`
- `app/package.json` → `build.publish`

发布时通常需要同时更新：

- `XWork-Installer-<version>.exe`
- `XWork-Installer-<version>.exe.blockmap`
- `latest.yml`

应用内「检查更新」读取 `latest.yml`，下载差分或完整安装包。

---

## 配置与数据

### 数据目录

优先级：

1. 环境变量 `XWORK_OPCODE_HOME`
2. 打包版：`%APPDATA%\XWork\opencode`
3. 开发版：仓库根目录 `.opencode-home`

> 变量名是 `XWORK_OPCODE_HOME`（历史拼写），不是 `XWORK_OPENCODE_HOME`。

### 目录布局

```text
<XDG_HOME>/
  xwork-settings.json      # 应用设置
  xwork-workspaces.json    # 工作区注册表
  xwork-tasks.json         # 定时任务与执行历史
  config/
    opencode2/
      opencode.json        # 引擎配置：provider + permission
      xwork-deepseek-search/
        package.json
        index.js           # 联网搜索 provider 插件（仅配置有效时存在）
  data/
    opencode2/
      opencode.db
      snapshot/            # 文件快照 / undo 依赖
  tasks/                   # 任务引擎独立数据目录
```

### 设置文件

| 文件 | 内容 |
| --- | --- |
| `xwork-settings.json` | 模型组、权限、主题、工作区、流式模式、推理强度、联网搜索、agentsBridge |
| `xwork-workspaces.json` | 历史工作区、最近使用、会话数 |
| `xwork-tasks.json` | 任务定义 + 最近 100 条执行记录 |
| `config/opencode2/opencode.json` | provider、全局权限规则、插件路径 |

### Key 如何保存

- 模型 API Key 和搜索 API Key 通过 Electron `safeStorage`（Windows DPAPI）加密
- `xwork-settings.json` 中保存的是 `enc:` 密文
- 写入 `opencode.json` 时使用 `{env:XWORK_KEY_<组ID>}` 引用
- 引擎启动时再把明文 Key 注入环境变量
- **明文 Key 不写入引擎配置文件**

### 日志

- 打包版：`<exe 目录>/logs/`
- 开发版：`app/logs/`
- 主日志 `main.log`：1 MB 轮转，保留 5 份
- 更新日志 `updater.log`
- 设置页「关于」可打开日志目录

---

## 项目结构

```text
XWork/
├─ app/
│  ├─ src/main/              Electron 主进程
│  ├─ src/preload/           contextBridge API
│  ├─ src/renderer/          React 界面与前端模块
│  ├─ scripts/               开发启动、打包、验收脚本
│  ├─ resources/
│  │  ├─ engine/             随包分发的 opencode V2
│  │  └─ git/                内置 MinGit
│  ├─ build/                 图标、Electron 本地 zip、NSIS 配置
│  ├─ release/               安装包与 win-unpacked
│  └─ app.config.json        应用默认配置
├─ 功能设计文档/              功能设计与实测记录
├─ ui-mockup/                 静态界面原型
├─ .agents/skills/            内置技能
├─ CHANGELOG.md               按时间倒序的更新记录
├─ PACKAGING.md               打包与发布说明
├─ start-xwork.bat            开发一键启动
└─ README.md
```

### 前端模块

| 文件 | 作用 |
| --- | --- |
| `App.jsx` | 主界面、设置、会话、任务、统计、子智能体视图 |
| `styles.css` | 全量界面样式与主题变量 |
| `typewriter.mjs` | 打字机揭示算法 |
| `emerge.mjs` / `emergeDom.mjs` | 浮现揭示算法与 DOM 包裹 |
| `subagentLiveStore.mjs` | 子智能体摘要节流订阅 + 子会话事件镜像 |
| `subagentModel.mjs` | 子智能体状态、part 归一化 |
| `stats.mjs` | 统计格式化与聚合辅助 |

---

## 常见问题

### 启动提示找不到执行引擎

开发模式：

```powershell
npm i -g opencode2 --registry=https://registry.npmmirror.com
```

或设置：

```powershell
$env:XWORK_OPENCODE_PATH = "D:\path\to\opencode2.exe"
```

### 提示引擎版本不是 V2

本机全局安装的是 V1 `opencode-ai`。XWork 不接受 V1，请改用 `opencode2` 或显式指定 V2 可执行文件。

### 引擎一直未就绪

检查 `logs/main.log`：

- `401`：Basic Auth 密码不匹配
- `EADDRINUSE`：端口被占用
- 引擎进程退出：查看引擎启动日志与安全软件拦截

V2 会使用派生密码接管同数据目录的端口；如果端口上是无关服务，会先清理占用者。

### `.agents` 修改不生效

`.agents` 通过目录联接暴露给引擎，但引擎的变更监听只覆盖 `.opencode`。新增 / 修改 / 删除 `.agents` 下的 agent 或 command 后，需要重启引擎：

- 设置页「保存并重启引擎」
- 或重新打开工作区

### `.opencode` 目录可以删除吗

不要手动删除 `.opencode/agents`、`.opencode/commands`。它们是 XWork 创建的目录联接，重新打开工作区会自动重建。

如果 git 已跟踪 `.opencode/**`，XWork 会跳过桥接并在界面提示，避免把 `.agents` 内容物化为静态副本提交。

### 打包失败：release 目录被占用

关闭正在运行的 XWork / 资源管理器预览 / 编辑器预览后重试；或使用：

```powershell
$env:XWORK_OUT_DIR = "release-build"
cd app
npm run build:dist
```

### 搜索 API 配置后仍显示禁用

检查：

- API 地址是否是完整的 `.../tools/search`
- Key 是否有效
- 服务是否返回 `results` 数组

验证失败时 XWork 会主动把权限行改为「禁止」，并删除搜索插件；这是失败关闭行为，不是回退失败。

---

## 设计文档

- [更新日志](CHANGELOG.md)
- [打包与发布](PACKAGING.md)
- [回退功能设计](功能设计文档/undo功能设计.md)
- [定时任务功能设计](功能设计文档/定时任务功能设计.md)
- [`.agents` 目录 junction 桥接设计](功能设计文档/agents目录junction桥接设计.md)
- [多模态图片支持设计](功能设计文档/多模态图片支持功能设计.md)

---

## License

MIT
