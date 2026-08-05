# XWork

基于 [opencode](https://opencode.ai) 的桌面端可视化 AI 工作台（Electron + React）。

以 opencode 为执行引擎，提供对话式交互 + 任务执行全过程可视化 + 关键节点人机确认，让 AI 的每一步操作透明可控。

## 功能

- 对话式 AI 交互，支持 DeepSeek 与任意 OpenAI 兼容模型（可配置多个模型组）
- 任务执行面板：思考过程、工具调用、命令输出实时可视化
- 关键操作（写文件 / 执行命令等）按权限策略弹窗确认，权限可在设置中按「允许 / 询问 / 禁止」自定义
- 历史会话管理（新建 / 重命名 / 删除 / 回看）
- 任务模板一键发起、工作区文件树
- 界面主题（暗色 / 亮色）、设置页含「关于」信息

## 环境要求

- Windows x64
- Node.js 18+ 与 npm
- opencode 引擎（见下文）

## 运行

```powershell
cd app
npm install
npm run dev
```

## opencode 引擎

XWork 以 opencode 为执行引擎，启动时按以下顺序探测可执行文件：

1. 打包版：应用 `resources/engine/opencode.exe`
2. 环境变量 `XWORK_OPENCODE_PATH`（指向 opencode.exe）
3. npm 全局安装目录（`opencode-ai`）

开发模式推荐全局安装：

```powershell
npm install -g opencode-ai
```

## 打包

完整打包流程见 [PACKAGING.md](PACKAGING.md)。产物为 Windows NSIS 安装器（`app/release/XWork-Installer-<版本>.exe`），安装包内含 opencode 引擎，目标机器无需预装 Node.js。

## 项目结构

```
app/                 Electron 应用（源码 + 构建配置）
  src/main/          主进程（引擎生命周期、IPC、设置存储）
  src/preload/       contextBridge 桥接层
  src/renderer/      React 前端
  scripts/           构建脚本（dev / build-dist / gen-icon）
PACKAGING.md         打包指南
PRD.md               产品需求文档
```

## 许可

MIT
