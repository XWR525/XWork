// preload：通过 contextBridge 向渲染进程暴露安全 API
const { contextBridge, ipcRenderer, clipboard } = require('electron')

contextBridge.exposeInMainWorld('xwork', {
  engineStart: () => ipcRenderer.invoke('engine:start'),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionCreate: (title, permission) => ipcRenderer.invoke('session:create', { title, permission }),
  sessionDelete: (sessionID) => ipcRenderer.invoke('session:delete', sessionID),
  sessionRename: (sessionID, title) => ipcRenderer.invoke('session:rename', sessionID, title),
  providerList: () => ipcRenderer.invoke('provider:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings, restart) => ipcRenderer.invoke('settings:save', settings, restart),
  getTheme: () => ipcRenderer.invoke('settings:get-theme'),
  applyTheme: (theme) => ipcRenderer.invoke('settings:apply-theme', theme),
  messageSend: (sessionID, text, model) => ipcRenderer.invoke('message:send', sessionID, text, model),
  messageList: (sessionID) => ipcRenderer.invoke('message:list', sessionID),
  messageAbort: (sessionID) => ipcRenderer.invoke('message:abort', sessionID),
  permissionRespond: (sessionID, permissionID, response) =>
    ipcRenderer.invoke('permission:respond', { sessionID, permissionID, response }),
  workspacePick: () => ipcRenderer.invoke('workspace:pick'),
  workspaceSwitch: (dir) => ipcRenderer.invoke('workspace:switch', dir),
  workspaceListDir: (dir) => ipcRenderer.invoke('workspace:list-dir', dir),
  fileOpen: (abs) => ipcRenderer.invoke('file:open', abs),
  fileShowInFolder: (abs) => ipcRenderer.invoke('file:show-in-folder', abs),
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
