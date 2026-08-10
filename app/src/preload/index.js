// preload：通过 contextBridge 向渲染进程暴露安全 API
const { contextBridge, ipcRenderer, clipboard } = require('electron')

// 渲染进程 console → 主进程日志（经 IPC 转发落盘）
// 打包版仅转发 warn/error（避免 Vite/React 等第三方 log 噪音）；开发模式全量转发便于调试
const IS_DEV = !!process.env.ELECTRON_RENDERER_URL
const LOG_LEVELS = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' }
for (const [name, level] of Object.entries(LOG_LEVELS)) {
  const fn = console[name]
  if (typeof fn !== 'function') continue
  console[name] = (...args) => {
    if (IS_DEV || level !== 'INFO') {
      try {
        const text = args
          .map((a) => {
            if (typeof a === 'string') return a
            if (a instanceof Error) return a.stack || String(a)
            try {
              return JSON.stringify(a)
            } catch {
              return String(a)
            }
          })
          .join(' ')
        ipcRenderer.send('log:write', { level, text })
      } catch {
        /* 转发失败不影响页面 */
      }
    }
    fn.apply(console, args)
  }
}

contextBridge.exposeInMainWorld('xwork', {
  engineStart: () => ipcRenderer.invoke('engine:start'),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  engineRestart: () => ipcRenderer.invoke('engine:restart'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  logOpen: () => ipcRenderer.invoke('log:open'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionCreate: (title, permission) => ipcRenderer.invoke('session:create', { title, permission }),
  sessionDelete: (sessionID) => ipcRenderer.invoke('session:delete', sessionID),
  sessionRename: (sessionID, title) => ipcRenderer.invoke('session:rename', sessionID, title),
  providerList: () => ipcRenderer.invoke('provider:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings, restart) => ipcRenderer.invoke('settings:save', settings, restart),
  getTheme: () => ipcRenderer.invoke('settings:get-theme'),
  applyTheme: (theme) => ipcRenderer.invoke('settings:apply-theme', theme),
  applyCloseAction: (action) => ipcRenderer.invoke('settings:apply-close-action', action),
  applyNotifyTask: (on) => ipcRenderer.invoke('settings:apply-notify-task', on),
  messageSend: (sessionID, text, model, agent) => ipcRenderer.invoke('message:send', sessionID, text, model, agent),
  messageList: (sessionID) => ipcRenderer.invoke('message:list', sessionID),
  messageAbort: (sessionID) => ipcRenderer.invoke('message:abort', sessionID),
  compactSession: (sessionID, model) => ipcRenderer.invoke('session:compact', sessionID, model),
  permissionRespond: (sessionID, permissionID, response) =>
    ipcRenderer.invoke('permission:respond', { sessionID, permissionID, response }),
  questionReply: (requestID, answers) => ipcRenderer.invoke('question:reply', requestID, answers),
  questionReject: (requestID) => ipcRenderer.invoke('question:reject', requestID),
  workspacePick: () => ipcRenderer.invoke('workspace:pick'),
  workspaceSwitch: (dir) => ipcRenderer.invoke('workspace:switch', dir),
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  workspaceDelete: (dir) => ipcRenderer.invoke('workspace:delete', dir),
  frequentModel: () => ipcRenderer.invoke('settings:frequent-model'),
  modelTest: (opts) => ipcRenderer.invoke('model:test', opts),
  workspaceListDir: (dir) => ipcRenderer.invoke('workspace:list-dir', dir),
  fileOpen: (abs) => ipcRenderer.invoke('file:open', abs),
  fileShowInFolder: (abs) => ipcRenderer.invoke('file:show-in-folder', abs),
  skillList: () => ipcRenderer.invoke('skill:list'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  skillInstall: (id) => ipcRenderer.invoke('skill:install', id),
  skillInstalled: () => ipcRenderer.invoke('skill:installed'),
  skillUninstall: (slug) => ipcRenderer.invoke('skill:uninstall', slug),
  copyText: (text) => clipboard.writeText(text),
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  onEvent: (cb) => {
    // 返回取消订阅函数，避免 HMR/重挂载时监听器累积导致事件被重复处理
    const handler = (_e, evt) => cb(evt)
    ipcRenderer.on('engine:event', handler)
    return () => ipcRenderer.removeListener('engine:event', handler)
  }
})
