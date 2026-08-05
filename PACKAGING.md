# XWork 打包指南

将 XWork 打包为 Windows 安装程序（NSIS 向导式安装器），发给他人安装后即可直接使用（纯新系统也无需安装 Node.js / opencode）。

## 产出物

| 产物 | 说明 |
| --- | --- |
| `app/release/XWork-Installer-0.1.0.exe` | NSIS 向导式安装器（约 123 MB），安装后带桌面/开始菜单快捷方式，可自定义安装目录 |
| `app/release/win-unpacked/` | 免安装版（绿色版），`XWork.exe` 可直接运行 |

安装包内含：
- Electron 33 运行时 + XWork 渲染层/主进程
- opencode 引擎（`resources/engine/opencode.exe`，随包分发，无需目标机器预装）

## 前置环境

- Windows x64（当前仅打包 win x64）
- Node.js 18+ 与 npm（本机已验证）
- 网络：脚本内已固化国内镜像，默认不依赖 GitHub；若个别二进制仍需联网，可开代理

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `app/package.json` | electron-builder 配置源（`build` 字段：产物名、图标、NSIS 选项、`electronDist` 指向本地 zip） |
| `app/scripts/build-dist.mjs` | 一键打包脚本：构建 → 图标 → 复制引擎 → 打包，并在开头固化镜像环境变量 |
| `app/build/electron-dist.zip` | 本地 Electron zip（打包时从它解包，完全绕开 Electron 网络下载） |
| `app/build/icon.ico` | 应用图标（缺失时脚本自动生成） |
| `app/src/main/engine.js` | 打包版引擎查找：优先 `process.resourcesPath/engine/opencode.exe` |

## 首次准备（一次性）

### 1. 安装依赖

```powershell
cd app
npm install
# 关键：electron-builder 的二进制依赖包，npm 常规安装可能漏装，
# 缺失时打包会卡死在 "unpacking default Electron distribution"
npm install -D app-builder-bin
```

### 2. 准备本地 Electron zip（强烈推荐，避免网络超时）

electron-builder 默认联网下载 Electron（约 115 MB，国内网络容易超时）。

- 已缓存位置：`%LOCALAPPDATA%\electron\Cache\electron-v33.4.11-win32-x64.zip`
- 复制到 `app/build/electron-dist.zip`（脚本/配置已通过 `electronDist` 指向它）

> 若升级 Electron 版本，需按新版本重新放置 zip，并核对 `package.json` 中 `electronDist` 文件名。

### 3. 预下载 NSIS 二进制（可选，加速首次打包）

放到 `%LOCALAPPDATA%\electron-builder\Cache\`：

```
nsis-3.0.4.1\nsis-3.0.4.1.7z
nsis-resources-3.4.1\nsis-resources-3.4.1.7z
```

## 日常打包（每次打包执行）

```powershell
cd app
npm run build:dist
```

脚本自动完成：
1. `electron-vite build` 构建渲染层/主进程/预加载到 `out/`
2. 图标 `build/icon.ico` 存在则跳过生成
3. 从 npm 全局 `opencode-ai` 安装目录探测 `opencode.exe` 并复制到 `resources/engine/`（环境变量 `XWORK_OPENCODE_PATH` 可显式指定来源）
4. `electron-builder --win nsis`（默认 `--publish never`，仅本地产出，不上传）生成安装包到 `release/`

任一步失败脚本立即中止（非零退出码）。

## 发布到 GitHub Releases（供「检查更新」使用）

应用内置的「检查更新」（electron-updater）通过 GitHub Releases 读取 `latest.yml` 元数据并下载新安装包。因此**每次发新版本都要把产物发布到 Releases**。

### 前置：GitHub Token

- GitHub → Settings → Developer settings → Personal access tokens 创建 token
- 权限：Classic token 勾选 `repo`；或 Fine-grained token 授予仓库 `Contents: Read and write`
- 在发布终端设置环境变量（或 `setx GH_TOKEN "..."` 永久写入后重开终端）：

```powershell
$env:GH_TOKEN = "你的token"
```

### 发布步骤

1. 修改 `app/package.json` 的 `version`（如 `0.2.0`）
2. 发布打包（自动上传安装包 + blockmap + latest.yml 到 GitHub Releases）：

```powershell
cd app
$env:GH_TOKEN = "你的token"
$env:XWORK_PUBLISH = "always"
npm run build:dist
```

- electron-builder 自动创建（或复用）tag `v0.2.0` 的 Release 并上传资产；同一版本不要重复发布（已存在则报 422/追加失败）
- 产物对应关系：

| Release 资产 | 客户端用途 |
| --- | --- |
| `XWork-Installer-0.2.0.exe` | 下载并安装的新版本安装包 |
| `XWork-Installer-0.2.0.exe.blockmap` | 差分更新（只下载差异部分，加速更新） |
| `latest.yml` | 更新元数据，客户端检查更新时读取 |

3. 打开 GitHub Releases 页，编辑该版本的更新说明

### 版本对比规则

- tag 统一命名 `v<版本号>`（electron-updater 会自动去掉 `v` 前缀对比版本）
- 仅当 Release tag 版本**高于**已安装版本时，客户端「检查更新」才会提示

### 验证发布

- GitHub Releases 页能看到新 Release 与三个资产
- 已安装旧版本的应用 → 设置 → 关于 → 检查更新 → 发现新版本 → 立即下载 → 重启并安装（向导式安装器会弹出安装界面，属正常）

## 验证

1. 运行 `app/release/win-unpacked/XWork.exe`，确认窗口出现、进程存活（Electron 会有多个 XWork 进程属正常）
2. 确认 `app/release/win-unpacked/resources/engine/opencode.exe` 存在
3. 有干净机器时，安装 `XWork-Installer-0.1.0.exe` 后直接使用

## 版本号 / 引擎更新

- 版本号：修改 `app/package.json` 的 `version` 字段，安装器文件名随之变为 `XWork-Installer-<版本>.exe`
- 引擎更新：`npm install -g opencode-ai` 更新到新版本后重新打包（脚本自动复制最新 `opencode.exe`）

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 打包卡在 "unpacking default Electron distribution" | `npm install -D app-builder-bin` 补充二进制依赖 |
| 下载超时（got 600s / 网络停滞） | 确认 `app/build/electron-dist.zip` 存在（已指向本地 zip）；或开代理后重跑 |
| 提示找不到 opencode.exe | 设置环境变量 `XWORK_OPENCODE_PATH` 指向 opencode.exe 后重跑 |
| 打包报 `GitHub Personal Access Token is not set` | 本地产包误设了 `XWORK_PUBLISH=always`（默认 never 不需要 token）；若确要发布，按上文配置 `GH_TOKEN` |
| 发布报 422（release 已存在） | 该版本已发布过；需提升 `version` 或删除旧 Release 对应 tag 后重试 |
| `npm prefix -w` exited code=1 | 无碍，可忽略 |
