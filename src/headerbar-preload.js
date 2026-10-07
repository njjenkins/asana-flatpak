const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('headerAPI', {
  newTab: () => ipcRenderer.send('tab-new'),
  activateTab: (id) => ipcRenderer.send('tab-activate', id),
  closeTab: (id) => ipcRenderer.send('tab-close', id),
  moveTab: (id, toIndex) => ipcRenderer.send('tab-move', id, toIndex),
  minimize: () => ipcRenderer.send('window-minimize'),
  toggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  close: () => ipcRenderer.send('window-close'),
  getButtonLayout: () => ipcRenderer.invoke('get-button-layout'),
  onTabsUpdated: (callback) => ipcRenderer.on('tabs-updated', (_event, data) => callback(data)),
  onWindowState: (callback) => ipcRenderer.on('window-state', (_event, data) => callback(data)),
});
