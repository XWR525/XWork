# PRD：私有化可视化 Agent 工具（基于 opencode）

> 版本：v0.1（雏形）
> 日期：2026-08-04
> 状态：Phase 10 已完成（端到端验收通过）

## 1. 产品定位

私有、桌面化的 Agent 工具。以 opencode 为执行引擎，用大众化的可视化界面（对标 Claude 的对话交互 + 腾讯 WorkBuddy 的任务面板），让普通用户用自然语言完成日常信息搜集与办公工作。

核心差异化：**任务执行过程全可视化 + 关键节点人机确认**，让用户看得见 Agent 在做什么、可以随时干预，从而降低 AI 使用的门槛与信任成本。

## 2. 目标用户与部署

- 目标用户：**两者兼顾**
  - 普通大众：界面零门槛，全自然语言驱动，任务模板一键发起
  - 技术用户：保留高级配置入口（自定义模型、自定义工具、更多设置）
- 部署形态：**Windows 个人电脑本机使用**，桌面应用
- 隐私要求：数据不出本机；模型 API Key 本地存储，不上传

## 3. 模型接入

- 模式：**配置化**，用户可增删多个提供商
- 双预置（首版）：
  1. DeepSeek（国内可用、便宜、中文能力强）
  2. 通用 OpenAI 兼容接口（用户自填 baseURL / API Key / 模型名）
- Key 存储：本地安全存储（系统凭据库或本地加密文件）

## 4. MVP 范围（单场景端到端）

### 4.1 首个场景：信息搜集

用户用自然语言描述调研需求 → Agent 联网搜索 → 汇总提炼 → 生成 **Markdown 报告** → 界面内预览 → **一键导出 Word**。

示例：输入「调研 2026 年储能行业趋势，输出一份简要报告」

### 4.2 界面构成

- 左侧：对话流（用户消息 / Agent 回复）
- 右侧：任务执行面板（实时步骤、工具调用、命令输出）
- 常用任务模板（首版：「信息调研」模板，引导用户填写调研主题）
- 历史会话管理（存档、回看、复用）
- 设置页（模型配置、工作目录、权限策略）

### 4.3 关键交互

- **完整过程可视化**：思考过程、步骤清单、工具调用（搜索/抓取）、命令输出实时展示
- **可暂停 / 中断 / 修改**：执行中可暂停，可中断后修改指令再继续
- **关键节点确认**：写文件、联网、执行命令等敏感操作弹窗征求用户批准（opencode permission: ask）

## 5. 技术架构

```
Electron 桌面应用
├── 主进程：管理 opencode serve 子进程（启动/停止/健康检查/崩溃重启）
├── 渲染进程：React 前端（对话流 + 任务面板 + 设置页 + 报告预览）
└── 桥接层：@opencode-ai/sdk（官方 SDK），HTTP + SSE 与 opencode serve 通信
```

关键依赖与机制：

- `opencode serve`：headless HTTP 服务，暴露 OpenAPI 3.1 REST API + SSE 事件流
- 自定义工具：`.opencode/tools/*.ts`（TS 定义，可调用任意语言脚本）
  - 首版：信息搜集相关工具（如国内可达的搜索工具兜底）
- 内置能力利用：opencode 原生 `websearch` / `webfetch` / `question` / `permission`(allow|deny|ask)
- 会话历史：本地存储（JSON/SQLite）
- Word 导出：本地转换（前端或本地工具，如 docx 库 / pandoc）
- 前端技术栈：Electron + React（TypeScript）

## 6. 验收标准（单场景端到端）

1. 安装启动应用，首启引导页配置模型 Key（双预置可选）
2. 选择「信息调研」模板，输入调研任务
3. 任务面板实时展示搜索步骤与进度（完整过程可视化）
4. 高敏操作（写文件/联网）弹窗确认后继续
5. 生成 Markdown 报告，界面内预览
6. 一键导出 Word 成功；历史记录可回看、可复用

## 7. 已知风险与对策（已逐个验证，2026-08-04 Phase 0 结论）

| # | 风险 | 验证结论与对策 |
|---|------|------|
| 1 | opencode 内置 websearch 在中国大陆可用性 | **已验证**：DuckDuckGo 网络不可达（Transport error）；Bing/百度通过 `webfetch` 可用，模型可自主降级切换。MVP 依赖该自适应能力即可；后续可加自定义 Bing/百度搜索工具提升稳定性 |
| 2 | permission "ask" 的 HTTP API 交互 | **已验证**：权限请求事件会推送至全局事件流（含 `per_...` ID），前端据此弹批准框；响应走 `POST /session/{id}/permissions/{permissionID}`，body `{response: "once"|"always"|"reject"}`，状态码 200 |
| 3 | 实时事件流 | **已验证**：per-session SSE 端点有 bug（收不到事件）；**改用全局事件流 `GET /global/event`**，可收到 session/message/part 更新、流式文本增量（delta）、工具调用、权限请求等全部事件，含完整过程可视化所需数据 |
| 4 | 本机 opencode 安装/版本依赖 | 已确认 npm 全局 shim 未创建，需用完整路径或手动修复安装；应用内需提供版本检测与引导 |
| 5 | Windows 安全软件拦截 | **已发现**：火绒 HIPS 拦截 opencode.exe 写用户目录，导致 serve 启动崩溃。对策：启动 opencode 时重定向环境变量 `XDG_CONFIG_HOME/XDG_STATE_HOME/XDG_DATA_HOME` 到应用数据目录 |
| 6 | 桌面应用与 opencode serve 的进程生命周期管理 | 主进程统一管理，异常退出自动重启（沿用原对策） |
| 7 | opencode 消息发送模式 | **已验证**：`noReply:true` 的消息引擎不会处理（v1.18.11）；必须用**同步 POST** 等待完整回复，实时过程由全局事件流推送 |

## 8. 研发路径

- **Phase 0 技术验证（spike）✅ 已完成**：跑通 `opencode serve` + HTTP API（会话创建/消息收发）；确认实时事件走全局流 `/global/event`；验证 permission ask 全流程（请求→批准→继续执行）；验证搜索可用性。关键技术决策：
  - 架构：B 端为 opencode serve（无头引擎，本地 HTTP 服务），A 端为 Electron 桌面壳（自绘 UI）
  - 实时通道：全局 SSE `/global/event`（不用 per-session 端点）
  - 权限交互：全局流捕获 `per_` 请求 → HTTP 响应批准/拒绝
  - 消息发送：同步 POST 取最终结果 + 全局流做过程可视化
  - opencode 启动：设置 `XDG_*` 环境变量重定向数据目录（规避火绒拦截）
- **Phase 1 项目骨架 ✅ 已完成**：Electron + React + 引擎桥，应用自启动 opencode 并完成收发消息闭环（对话流、流式展示、权限弹框）。开发目录：`app/`，入口 `npm run dev`（设 `XWORK_OPCODE_HOME` 指向引擎数据目录）
- **Phase 2 核心界面 ✅ 已完成**：任务执行面板（完整过程可视化，支持暂停/中断）。交付内容与验证结论：
  - 右侧任务面板：工具调用卡片（状态色 pending/running/completed/error，输入/输出可折叠查看，含命令输出实时刷新）
  - 实时过程可视化：流式文本增量（`message.part.delta`）、思考过程（`reasoning` 折叠）、工具状态机（`pending → running → completed/error`）
  - 停止按钮：采用 **abort 端点**（`POST /session/{id}/abort`，10s 内返回，快速停止；`interrupt` 端点返回 204 但结束有延迟，弃用）
  - 中断结果标记：aborted 徽标（橙色「已停止（输出不完整）」），busy/stopping 状态联动
  - **验证**：e2e-live（等待→执行中 4.4s→完成 完整链路）；e2e-phase2（多工具实时状态 + 停止）；e2e-stop（确定性中断：Start-Sleep 12 执行中点停止 → aborted 徽标出现、busy 复位、停止按钮消失）；`npm run build` 通过
  - 关键事件结构备忘：`message.part.delta` 的 messageID 在顶层；`message.part.updated` 的 messageID 在 `part.messageID` 内部（顶层可能缺失）；工具消息无文本增量时需创建占位消息保证实时渲染
- **Phase 3 信息搜集场景 ✅ 已完成**：调研模板、搜索工具链、Markdown 报告生成与预览。交付内容与验证结论：
  - **调研模板**：空会话时展示「信息调研」模板卡片 → 填写主题 → 一键发起（新建带模板权限的会话 + 发送预设 prompt：多次联网搜索 / 汇总提炼 / 报告结构：现状·趋势·关键数据·来源链接 / ≤600 字）
  - **搜索工具链决策（spike 验证）**：采用**内置自适应方案**，不自定义搜索工具。模型自主探测 Google/Bing/DDG → 抓取权威站点（IEA/BNEF/CNESA/IRENA/Reuters 等）→ 报告含真实数据与来源链接；105.8s 完成。风险表 #1 的自定义 Bing 工具兜底暂不需要
  - **联网自动批准（降低弹窗干扰）**：模板会话登记 `autoApprove: ['webfetch','websearch']`，事件流中 `permission.asked` 直接放行（`{response:'once'}`）；bash 仍弹窗确认。e2e 验证**零权限弹窗**
  - **Markdown 报告渲染**：引入 `marked`（GFM + breaks），文本 part 渲染为 `.md-body`（标题/列表/代码/表格/引用/链接样式）；流式阶段显示光标，完成后定格
  - **多 turn busy 状态修复（关键）**：opencode 同步 POST 只等到一个 step 返回，多 turn 工具任务 POST 返回后引擎继续跑 → 修复为：POST 返回后 2s 权威查询（`messageList` 最后一条 assistant 是否即 POST 返回消息且最终完成）兜底 + `session.idle` 事件驱动复位
  - **监听器累积修复**：preload `onEvent` 返回取消订阅函数 + React useEffect cleanup，避免 HMR 重挂载导致同一 `permission.asked` 被重复响应（404 PermissionNotFoundError）
  - **验证**：e2e-research（真实调研 spike：18 工具调用 105.8s）；e2e-template（模板全流程：busy 保持 true 138s、perm popups 0、报告 h1「2026 年固态电池行业趋势调研」）；e2e-webfetch（普通会话权限弹窗回归）；e2e-stop（abort 回归 ABORT VERIFIED OK）；`npm run build` 通过
- **Phase 4 完善闭环 ✅ 已完成**：一键导出 Word、历史会话管理、设置页（模型双预置）。交付内容与验证结论：
  - **一键导出 Word**：主进程 `md2docx.js`（marked 解析 token 树 → docx 库生成：标题/段落/粗体斜体/行内代码/链接/列表/代码块/引用/表格/分隔线）；消息气泡操作栏「复制 / 导出 Word」；保存对话框（`dialog.showSaveDialog`）。验证：转换器单测 9KB docx 生成成功
  - **历史会话管理**：会话项删除按钮（`DELETE /session/{id}`，确认后删除，删除当前会话自动回到空态）；双击标题重命名（`PATCH /session/{id}`）；点击回看、继续对话即复用。验证：DELETE/PATCH 均返回 200 且列表移除成功
  - **设置页（模型双预置）**：顶栏「设置」按钮 → 面板选择 DeepSeek / OpenAI 兼容自定义
    - DeepSeek：API Key + 模型下拉（`GET /provider` 动态拉取 deepseek 模型列表）
    - 自定义：启用开关 + Base URL + API Key + 模型 ID → 写入 opencode.json 的 `xwork-custom` provider（`npm: @ai-sdk/openai-compatible`，apiKey 用 `{env:XWORK_CUSTOM_API_KEY}` 引用，规避明文落盘）
    - Key 存储：`{xdgHome}/xwork-settings.json` + Electron safeStorage 加密（Windows DPAPI，纯 Node 测试环境降级明文前缀）
    - 生效机制：保存 → 写 opencode.json → 重启引擎（spawn 时注入 `DEEPSEEK_API_KEY` / `XWORK_CUSTOM_API_KEY` 环境变量）；发消息用 `settings.currentModel()` 选择模型
    - 验证：spike 确认自定义 provider 加载 + `{env:VAR}` Key 注入 + 模型注册（`GET /provider` 可见）；settings 逻辑 17 项单测通过（脱敏/掩码不覆盖/env/currentModel/applyToOpencode 保留 permission）
  - **验证**：`npm run build` 通过（settings/md2docx 已列入主进程构建 input）
- **Phase 5 端到端验收 ✅ 已完成**：按第 6 节验收标准逐项验证，全部通过（见下）
  - 验收 1 安装启动 + 模型 Key 配置：✅ 应用启动（引擎 1.18.11 健康）；设置页可配置 Key/模型；Key 加密存储（17 项单测）；deepseek provider 加载可用（4 模型）。差异：**首启引导页未实现**，由设置页（顶栏入口）承担配置模型 Key 的功能
  - 验收 2 信息调研模板：✅ 模板卡片 → 表单填主题 → 一键发起，199s 完成端到端
  - 验收 3 过程实时可视化：✅ 工具调用计数 4→6→12→14→16→18→22→26 逐步增长，busy 保持 true 至 `session.idle`
  - 验收 4 高敏操作弹窗：✅ 普通会话 webfetch 弹窗 →「允许一次」→ 任务继续完成；模板会话联网操作自动批准 78 次（UI 零弹窗，设计决策）
  - 验收 5 Markdown 报告预览：✅ 报告 h1「2026年固态电池行业趋势调研」在界面内渲染
  - 验收 6 导出 Word + 历史回看复用：✅ md→docx 转换（9KB 产物）；消息操作栏「复制 / 导出 Word」（真实保存对话框留待人工点按）；会话列表删除/双击重命名/点击回看复用全部可用
  - 附：修复 UI 引擎状态不刷新（server.connected 事件 + 启动兜底查询）；electron.vite 主进程需将 settings/md2docx 列入构建 input（本地 CommonJS require 不内联）
- **Phase 6 流式输出（打字机）✅ 已完成**：对话框逐字吐字，避免等待时无反馈。交付内容与验证结论：
  - **打字机渲染**：引擎 delta 是 token 级整块推送（非逐字）→ UI 层 `TypewriterText` 组件 setInterval 25ms 每次揭示 2 字符，ref 记录已揭示长度（不随 props 重置）；揭示完成后无缝切换 `md-body` 完整 Markdown 渲染
  - **打字机仅限实时流式**：`message.part.delta`/`part.updated`/settle 产生的实时消息走逐字揭示；从引擎加载（切换会话/回看/任务完成）的消息均为完整内容，直接渲染全文，不再重复打字机动画
  - **后台节流修复（关键）**：Electron 窗口不可见时定时器被后台节流（25ms interval 退化到 ~700ms，打字机几乎卡死）→ BrowserWindow `backgroundThrottling: false`，后台窗口打字机保持实时（验证 80 ticks/2s）
  - **settle/delta 竞态修复**：settle（POST 返回）与 delta 事件先后不确定 → settle 标记 `settled`，delta 分支对已落定消息直接拦截，避免最终文本重复/不一致
  - **验证**：accept-stream（打字机逐字递增 6 次采样 PASS + 思考过程实时展开 PASS + 最终 md 渲染 PASS）；最终消息 md 完整 312 字无重复
- **Phase 7 工作区（Workspace）✅ 已完成**：打开指定文件夹作为工作区，AI 可读取/分析/修改其中文件（复用 opencode 原生工具链）。交付内容与验证结论：
  - **技术事实（决策依据）**：opencode serve 无 `--cwd` 参数，工作区 = 引擎进程启动目录（项目根）；切换工作区必须重启引擎（约几秒）；会话按项目隔离 → 每个工作区有独立会话历史（数据在磁盘，不丢失）；opencode 原生 read/write/edit/apply_patch 工具 + `edit` 权限类型（支持按路径 allow/ask/deny）与 `external_directory`（工作区外默认 ask）
  - **打开文件夹**：侧栏「打开文件夹/切换」按钮 → 系统目录选择对话框 → 持久化到设置（settings.workspace）→ 重启引擎（新 cwd）→ 会话列表/文件树自动刷新（server.connected 事件驱动）
  - **文件树（懒加载）**：侧栏底部显示工作区文件树；目录点击展开（IPC 单层读取）；隐藏常见大目录（node_modules/.git/dist 等）；启动时自动加载上次工作区
  - **勾选文件 → 关注清单**：勾选文件显示「已选 N 个文件」；发送消息时自动注入【工作区文件】相对路径清单，AI 用 read/edit 工具实际操作（不把文件内容塞入 prompt，避免 token 膨胀）
  - **文件修改权限**：会话默认权限新增 `edit: ask`（write/edit/patch 弹窗确认，可「总是允许」）；工作区外文件访问保持 opencode 默认 `external_directory: ask`
  - **验证**：spike（会话级 edit:ask 生效，AI 编辑文件触发 permission.asked 并成功修改）；ws-e2e（文件树展开/勾选 PASS、关注清单注入 PASS、edit 权限弹窗 PASS、AI 创建新文件 PASS）
  - **修复：切换工作区不生效（2026-08-04）**：用户反馈切换后 AI 仍在旧目录工作。根因有三层：① app 初始化与渲染进程 `engine:start` 并发调用 `start()`，各 spawn 一个 opencode 进程争抢同一端口，冲突进程以 code=1 退出；② `exit` 回调无条件 `this.child = null`，冲突进程退出时把真正服务的进程引用清掉，使其成为孤儿，后续 `stop()` 拿不到 child 无法停止；③ `stop()` 不等待进程退出，`start()` 的健康检查命中残留旧进程直接复用（cwd 不生效）。修复：`start()` 加启动互斥（并发调用复用同一 promise，避免双进程）；`exit` 回调按引用匹配才清 `this.child`；`stop()` 等待 `exit` 事件（超时 SIGKILL 兜底）；`start(force)` 强制换进程并先回收残留 child。**验证**：`ws-switch-check` 回归（切换后 `engineStatus().workspace` 与 AI 实际工作目录一致、AI 能读到新目录文件，全部 PASS）；启动日志确认仅 spawn 一次
- **Phase 8 设置总览 + 亮色主题 ✅ 已完成**：设置面板重构为「左侧导航 + 右侧内容」总览式（模型设置 / 界面设置两个 tab），新增亮色主题（`:root[data-theme='light']` CSS 变量覆盖，含硬编码深色值逐项适配）
- **Phase 9 设置页固定底部按钮栏 ✅ 已完成**：设置面板右下角常驻「取消」「保存」；模型设置 tab 另保留「保存并重启引擎」（任务执行中禁用）；保存不重启时引擎 pid 不变已验证
- **Phase 10 模型组（多服务多模型）+ 聊天框选模型 ✅ 已完成**：模型设置改版为「添加模型组」，每次添加可配置同一 URL 下的多个模型 ID，并支持在聊天框选择本次对话的模型。交付内容与验证结论：
  - **数据模型重构**：`xwork-settings.json` 改为 `modelGroups: [{id, name, baseURL, apiKey, models[]}]`，旧 `provider/custom` 字段保存时自动清理；组 id 用 `xgroup-` 前缀（opencode.json provider key，会话绑定后保持稳定），主进程保存时校验格式
  - **模型组添加流程**：设置面板「+ 添加模型组」表单（组名 / Base URL / API Key / 模型 ID 每行一个）→ 可多次添加（如 DeepSeek 2 模型 + Kimi 3 模型）；组卡片展示 baseURL 与模型列表，可**编辑**（表单预填、id 与 Key 保持不变、取消还原）与删除；「保存并重启引擎」后生效（opencode 配置不热加载）；DeepSeek 默认模型为文本输入框（任意模型 ID）
  - **Key 安全**：每组独立环境变量 `XWORK_KEY_<GROUP_ID>`，opencode.json 写 `{env:...}` 引用，明文 Key 存 safeStorage DPAPI 加密
  - **聊天框模型选择**：整个下部输入区改为圆角矩形输入框，发送按钮（圆形 ↑，执行中变 ■ 停止）位于右下角，其左侧为模型选择按钮（点击后**向上**弹出选项列表，选后关闭、点外部关闭）；选择后发送消息绑定到该会话（POST message 带 model 参数，主进程透传）；切换会话自动恢复其绑定模型（`GET /session` 的 model 字段）；模型组被删除后自动回退引擎默认；保存/重启后自动刷新下拉（server.connected 事件驱动）
  - **验证**：e2e-modelgroups 20 项全 PASS（分 2 次添加 2+3 模型 → 保存并重启 pid 变化 → opencode.json 2 个 xgroup provider 且 apiKey 为 `{env:XWORK_KEY_...}` → 引擎注册 5 模型 → 下拉 10 项含 5 组模型 → 选组模型真实 API 调用成功（env 注入生效）→ 会话 model 绑定 `{providerID:xgroup-*, id:deepseek-chat}` → 切会话下拉恢复）；回归 6 项 PASS（footer 三按钮 / 界面设置 tab / 删除组 UI）
  - **修复：「保存并重启引擎」未真正重启（2026-08-04）**：`settings:save` 原逻辑 `if (before !== after && restart)` 只在配置变化时才重启。未改动配置时点按钮不会重启，但 toast 仍提示已重启。修复：restart=true（「保存并重启引擎」）时无条件 `engine.stop()+start()`，不以配置是否变化为条件——按钮语义即显式重启
  - **移除「导出 Word」功能（2026-08-04）**：删除按钮、exportReport、`report:export-docx` 处理器、md2docx.js 转换器与 electron.vite 入口
  - **「复制」按钮移至 AI 气泡右下角（2026-08-04）**：`.msg-actions` 改 `justify-content: flex-end`，仅保留复制按钮
  - **文件树实时刷新（2026-08-04）**：`message.part.updated` 中工具状态到达 `completed` 时调用 `refreshWsTree()`（重列根目录 + 已展开目录；经 workspaceRef/expandedRef 取最新值避免闭包过期），AI 新建/编辑文件后左侧列表立即可见

## 9. 后续规划（不在 MVP 内）

- 办公文档场景（Word/PPT/Excel 生成）
- 数据分析场景（本地数据文件读取、清洗、图表报告）
- 软件开发辅助场景（复用 opencode 原生编码能力）
- 任务模板开放自定义
