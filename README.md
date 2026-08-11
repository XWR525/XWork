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
- 权限策略：读取 / 修改文件 / 执行命令 / 联网搜索 / 子任务等 11 类操作，按「允许 / 询问 / 禁止」三档配置（含严格 / 标准 / 宽松预设）
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
- **回退（undo）**：user 气泡左侧「回退至此」→ 轻确认 → 撤销该轮及之后全部 AI 变更（引擎 revert + 快照补偿恢复，改名 / 移动的旧文件自动找回），回退完成后展示实际影响清单（删除 / 还原 / 找回）并刷新消息列表与文件树（详见 [undo功能设计.md](undo功能设计.md)）
- **压缩会话**：输入区「压缩」按钮，将历史对话压缩为摘要以换取上下文空间（引擎 summarize，需指定总结模型）
- **上下文 Token 统计**：输入区实时显示当前会话上下文长度（最近一次成功回复的 input + cache.read）

### 界面与系统
- 暗色 / 亮色主题
- 设置面板（模型设置 / 界面设置），支持「保存并重启引擎」
- 自绘无边框标题栏（最小化 / 最大化 / 关闭）
- **任务通知**：AI 完成回复或发起提问时，窗口不在前台则弹 Windows 系统通知（点击恢复窗口）
- **关闭时最小化到托盘**：托盘图标 + 右键菜单（显示主窗口 / 退出），首次最小化有系统通知
- **技能市场（Skill Hub）**：浏览 / 安装 / 卸载技能（`.agents/skills`），安装后引擎自动加载
- 文件日志：主进程 + 渲染进程日志落盘，1MB 轮转保留 5 份
- 自动更新（打包版，基于 GitHub Releases 的 electron-updater，支持差分更新）

## 架构

```
┌──────────────────────────── XWork (Electron) ────────────────────────────┐
│  渲染进程 (React, App.jsx)                                               │
│    │ window.xwork.*（preload contextBridge）                             │
│    │ ←── engine:event（IPC，全局事件流转发）                              │
│ 主进程 (index / engine / bridge / settings / undo / config / logger)        │
│    │ HTTP REST + 全局 SSE (GET /global/event)                            │
└────┼─────────────────────────────────────────────────────────────────────┘
     ▼
opencode serve（127.0.0.1:4096，本地无头引擎）
```

- **主进程**：管理 opencode 子进程生命周期（探测 / 启动 / 健康检查 / 崩溃重启 / 工作区切换换进程）、IPC 桥、设置与 Key 存储、文件日志。
- **preload**：通过 `contextBridge` 向渲染层暴露受控的 `window.xwork.*` API，渲染层 `console` 转发至主进程日志。
- **渲染层**：React 单页应用（对话流 + 消息内联任务展示 + 文件树 + 设置面板）。
- **桥接层**（`bridge.js`）：直接以 `fetch` 调用 opencode REST API；实时事件走**全局事件流** `GET /global/event`（per-session 事件端点不可用，故不用）。
- **消息发送**：同步 `POST /session/{id}/message` 等待完整回复；流式增量（`message.part.delta` / `message.part.updated`）、思考、工具状态由全局事件流驱动实时渲染。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron 33 |
| 前端 | React 18 + Vite 5（electron-vite 构建） |
| Markdown | marked（GFM + breaks） |
| 打包 / 更新 | electron-builder 26（NSIS 安装器）、electron-updater 6 |
| 执行引擎 | opencode（`serve` 模式，HTTP + SSE） |

## 环境要求

- Windows x64
- Node.js 18+ 与 npm（开发 / 打包）
- opencode 引擎：打包版随安装包分发；开发模式需本机可探测（见下）

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

## opencode 引擎

- **探测顺序**：打包版 `resources/engine/opencode.exe` → 环境变量 `XWORK_OPENCODE_PATH` → npm 全局安装目录（`opencode-ai`）。开发模式推荐 `npm install -g opencode-ai`。
- **启动**：`opencode serve --port 4096 --hostname 127.0.0.1`，启动前将 `XDG_*` 环境变量重定向到引擎数据目录（规避安全软件对用户目录写入的拦截）。
- **复用**：端口上已有健康服务时直接复用（`owned=false`）；切换工作区 / 保存并重启引擎时强制拉起新进程。
- **工作区**：引擎以工作区目录为启动目录（opencode 无 `--cwd` 参数，会话按项目隔离），因此切换工作区需重启引擎（数秒）。

## 配置与数据

所有数据存放于引擎数据目录（开发：`<仓库根>/.opencode-home`；打包：`<userData>/opencode`；可用环境变量 `XWORK_OPCODE_HOME` 覆盖）。

| 文件 | 说明 |
| --- | --- |
| `xwork-settings.json` | 应用设置：`modelGroups`（模型组）、`permission`（权限策略）、`theme`、`workspace`、`modelUsage`（模型使用统计） |
| `xwork-workspaces.json` | 工作区注册表（历史目录 + 最近使用 + 会话数） |
| `config/opencode/opencode.json` | 引擎配置：每个模型组写入一个 `xgroup-*` provider；全局权限规则 |
| `data/`、`state/` | opencode 运行时数据与会话存储 |

- **模型 Key**：`apiKey` 经 Electron safeStorage（Windows DPAPI）加密存储（`enc:` 前缀）；写入 `opencode.json` 时以 `{env:XWORK_KEY_<组ID>}` 引用，引擎启动时注入环境变量，**明文 Key 不落盘**。
- **模型组 ID**：`xgroup-<...>`，同时作为 opencode.json 的 provider key，会话绑定模型后保持稳定。
- **日志**：`main.log`（1MB 轮转 × 5）与 `updater.log`；打包版位于 exe 旁 `logs/`，开发版位于 `app/logs/`。设置页可一键打开日志目录。

## 目录结构

```
app/                        Electron 应用（源码 + 构建配置）
  src/main/                 主进程：index（IPC）/ engine（进程管理）/ bridge（引擎 API 桥）/ settings（设置与 Key）/ undo（回退兜底恢复）/ config（应用配置）/ logger
  src/preload/              contextBridge 桥接层
  src/renderer/             React 渲染层（App.jsx / styles.css / main.jsx）
  scripts/                  dev.mjs（开发启动）/ build-dist.mjs（一键打包）/ gen-icon.mjs（图标生成）
  build/                    图标与本地 Electron zip（打包用）
  release/                  打包产物（NSIS 安装器 / win-unpacked）
PACKAGING.md                打包与发布指南
PRD.md                      产品需求文档（含各阶段实现记录）
undo功能设计.md             回退（undo）功能设计（已实现）
回退功能测试报告.md          回退功能端到端测试报告（真实 AI，13/13 通过）
多模态图片支持功能设计.md    多模态图片支持方案讨论稿（待评审）
定时任务功能设计.md          定时任务方案讨论稿（待评审）
start-xwork.bat             开发一键启动脚本
```

## 打包与发布

完整流程见 [PACKAGING.md](PACKAGING.md)。

- 产物：`app/release/XWork-Installer-<版本>.exe`（NSIS 向导安装器，内含 Electron 运行时与 opencode 引擎，目标机器无需预装 Node.js / opencode）。
- 本地打包：`cd app && npm run build:dist`（默认仅产本地，不上传）。
- 发布更新：配置 `GH_TOKEN` + `XWORK_PUBLISH=always` 后运行同一命令，产物自动上传 GitHub Releases；应用内「检查更新」据此检测并下载新版本。

## 许可

MIT
