# XWork 打包指南

将 XWork 打包为 Windows 安装程序（NSIS 向导式安装器），发给他人安装后即可直接使用（纯新系统也无需安装 Node.js / opencode）。

> **引擎版本要求（V1 → V2 迁移后）**：XWork 现依赖 opencode **V2**（npm 包 `opencode2`）。
> V1 引擎（`opencode-ai`，如 1.18.x）**不再兼容**：缺少 `/api/info`、无强制 Basic Auth、prompt 为同步语义，
> 随包分发会导致应用无法工作。`build-dist.mjs` 会在复制后校验版本号，非 V2 直接中止打包。

## 产出物

| 产物 | 说明 |
| --- | --- |
| `app/release/XWork-Installer-<版本>.exe` | NSIS 向导式安装器（含 V2 引擎，**实测 205 MB**），安装后带桌面/开始菜单快捷方式，可自定义安装目录 |
| `app/release/win-unpacked/` | 免安装版（绿色版），`XWork.exe` 可直接运行 |

安装包内含：
- Electron 33 运行时 + XWork 渲染层/主进程
- opencode **V2** 引擎（`resources/engine/opencode.exe`，实际为 opencode2.exe 重命名；196 MB，随包分发，无需目标机器预装）
- 内置 MinGit（`resources/git`，引擎快照/回退依赖）

> 体积说明：V2 引擎单文件 196 MB（V1 约 171 MB）。安装包由 V1 时代的约 123 MB 增至 **约 205 MB**（+82 MB），
> 发版说明与更新提示中应向用户告知（差分更新 blockmap 仍可用，老用户实际下载量小于全量）。

## 前置环境

- Windows x64（当前仅打包 win x64）
- Node.js 18+ 与 npm（本机已验证）
- **opencode V2 引擎来源**（三选一，脚本按下述顺序探测）：
  1. 环境变量 `XWORK_OPENCODE_PATH` 指向 `opencode2.exe`
  2. npm 全局 `opencode2`（`%APPDATA%\npm\node_modules\opencode2\...`）
  3. npm 全局平台包 `opencode2-windows-x64`
  国内网络安装：`npm i -g opencode2 --registry=https://registry.npmmirror.com`
- 网络：脚本内已固化国内镜像，默认不依赖 GitHub；若个别二进制仍需联网，可开代理

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `app/package.json` | electron-builder 配置源（`build` 字段：产物名、图标、NSIS 选项、`electronDist` 指向本地 zip） |
| `app/scripts/build-dist.mjs` | 一键打包脚本：构建 → 图标 → 探测并校验 V2 引擎 → 复制 → 打包，并在开头固化镜像环境变量 |
| `app/build/electron-dist.zip` | 本地 Electron zip（打包时从它解包，完全绕开 Electron 网络下载） |
| `app/build/icon.ico` | 应用图标（缺失时脚本自动生成） |
| `app/src/main/engine.js` | 打包版引擎查找：优先 `process.resourcesPath/engine/opencode.exe`；负责 Basic Auth 密码派生与 `OPENCODE_SERVER_PASSWORD` 注入 |

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
3. 探测 opencode **V2** 引擎（`XWORK_OPENCODE_PATH` → npm 全局 `opencode2` → 平台包 `opencode2-windows-x64`），
   **校验版本号为 v2.x**（非 V2 直接中止），复制为 `resources/engine/opencode.exe`
3.5 内置 MinGit（`resources/git`）缺失时从 npmmirror 下载并解压（引擎快照/回退依赖 git）
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
2. 确认 `app/release/win-unpacked/resources/engine/opencode.exe` 存在且为 V2：
   `.\release\win-unpacked\resources\engine\opencode.exe --version` → 应输出 `opencode v2.x.x`
3. 应用启动后确认引擎就绪（左下角状态「就绪」），V2 引擎数据落在 `<userData>\opencode\data\opencode2\`（含 `opencode.db`）
4. 有干净机器时，安装 `XWork-Installer-<版本>.exe` 后直接使用
5. **主进程模块完整性（必做，0.6.4 曾因此事故）**：确认包内包含全部主进程模块：

   ```powershell
   cd app
   node scripts/test-main-build-manifest.cjs     # 源码 require 与 electron.vite.config.mjs 的 input 清单一致性
   npx asar list release\win-unpacked\resources\app.asar | Select-String '^\\out\\main'
   ```

   `app/electron.vite.config.mjs` 的主进程 `input` 是**显式清单**——新增 `src/main/*.js` 模块若漏登记，
   构建不会报错、单元测试也不会失败，但**装上去一启动就报 `Cannot find module './<模块名>'`**。
   上述检查已纳入 `node scripts/test-agents-bridge-all.cjs`（打包前跑一遍即可拦住）。

> V2 引擎强制 HTTP Basic Auth（用户名 `opencode`，密码由 XWork 按数据目录派生并注入 `OPENCODE_SERVER_PASSWORD`）。
> 手动用 curl/浏览器访问引擎接口时必须带 `Authorization: Basic base64(opencode:<密码>)`，否则一律 401。

## 版本号 / 引擎更新

- 版本号：修改 `app/package.json` 的 `version` 字段，安装器文件名随之变为 `XWork-Installer-<版本>.exe`
- 引擎更新：`npm i -g opencode2 --registry=https://registry.npmmirror.com` 更新到新版本后重新打包（脚本自动复制并校验 V2 版本号）
- 引擎数据目录：V2 使用 `opencode2` 子目录（`config/opencode2`、`data/opencode2`），与 V1 的 `opencode` 目录并存互不干扰 ——
  升级后 V1 时代的会话历史不会出现在 V2 中（引擎不支持自动迁移），降级回 V1 亦不受影响
- **升级引擎后必须重跑 `.agents` 桥接回归**（本功能依赖引擎的符号链接跟随语义与 location 查询口径，均可能随引擎版本变化）：

  ```bash
  cd app
  node scripts/test-agents-bridge-all.cjs
  ```

  全绿方可发布引擎升级。各项失败的含义与处置：
  | 失败项 | 含义 | 处置 |
  | --- | --- | --- |
  | 设置存储 | 与引擎升级无关（settings.js 自测） | 按报错修实现或断言 |
  | 单测 T-A*/T-B* | 联接判定或**命名推导公式**变了 | 对照新引擎二进制核对 `decode()` 的前缀剥离规则，更新 `collectMdNames` |
  | 单测 T-C*/T-D* / T-F* | git 防污染判据失效（忽略语义或 `check-ignore` 行为变化） | 勿发布：会造成 `.agents` 内容泄漏进仓库 |
  | 集成 I-2* | **引擎不再跟随联接**，或 `location` 查询口径变了 | 勿发布：本功能整体失效，需回到 loader 插件方案或等上游 PR #54594 |
  | 自检 S-3/S-4 | location 参数形态或**响应回显**变了 | 核对 `v2-openapi.json` 的 `location` 参数定义并更新 `locationQuery` |

  > 背景与全部实测依据见 [功能设计文档/agents目录junction桥接设计.md](功能设计文档/agents目录junction桥接设计.md) §2（证据分层）与 §7（测试方案）。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 打包卡在 "unpacking default Electron distribution" | `npm install -D app-builder-bin` 补充二进制依赖 |
| 下载超时（got 600s / 网络停滞） | 确认 `app/build/electron-dist.zip` 存在（已指向本地 zip）；或开代理后重跑 |
| 提示找不到 opencode V2 引擎 | `npm i -g opencode2`（国内加 `--registry=https://registry.npmmirror.com`）或设置 `XWORK_OPENCODE_PATH` 指向 `opencode2.exe` |
| 提示「引擎版本非 V2」 | 本机全局装的是 V1（`opencode-ai`）；改指 V2 的 `opencode2.exe`，不要用 V1 打包 |
| 应用启动后引擎一直未就绪 | 检查日志中是否 401（密码/鉴权）或 `EADDRINUSE`；V2 会用派生密码接管端口，若端口被其他程序占用会自动结束占用者 |
| 模型调用报 `DEPTH_ZERO_SELF_SIGNED_CERT` | 企业零信任客户端（如 aTrust）拦截了引擎的 HTTPS 请求：导出企业根证书并让引擎加载（`NODE_EXTRA_CA_CERTS`），或将引擎进程与模型域名加入放行清单 |
| 打包报 `GitHub Personal Access Token is not set` | 本地产包误设了 `XWORK_PUBLISH=always`（默认 never 不需要 token）；若确要发布，按上文配置 `GH_TOKEN` |
| 发布报 422（release 已存在） | 该版本已发布过；需提升 `version` 或删除旧 Release 对应 tag 后重试 |
| `npm prefix -w` exited code=1 | 无碍，可忽略 |
