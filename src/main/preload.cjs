const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cloudMusicDesktop', {
  platform: process.platform,
  versions: { electron: process.versions.electron },
  acquireNeteaseAccount: () => ipcRenderer.invoke('cloudmusic:acquire-netease-account'),
  getSavedCookie: () => ipcRenderer.invoke('cloudmusic:get-saved-cookie'),
  browseLibrary: (currentPath) => ipcRenderer.invoke('cloudmusic:browse-library', currentPath),
  minimizeWindow: () => ipcRenderer.invoke('cloudmusic:window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('cloudmusic:window-toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('cloudmusic:window-close')
});
