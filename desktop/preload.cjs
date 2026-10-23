const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('crosschatDesktop', Object.freeze({
  adminKey: () => ipcRenderer.invoke('crosschat:admin-key'),
}));
