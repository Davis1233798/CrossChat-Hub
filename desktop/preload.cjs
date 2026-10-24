'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('crosschatDesktop', Object.freeze({
  switchTab: id => ipcRenderer.invoke('crosschat:tab-switch', id),
  reloadTab: id => ipcRenderer.invoke('crosschat:tab-reload', id),
  clearProfile: id => ipcRenderer.invoke('crosschat:profile-clear', id),
  openInBrowser: id => ipcRenderer.invoke('crosschat:open-browser', id),
  openLineOfficial: kind => ipcRenderer.invoke('crosschat:line-official', kind),
  onTabStatus: callback => {
    ipcRenderer.on('crosschat:tab-status', (_event, data) => callback(data));
  },
  quit: () => ipcRenderer.invoke('crosschat:quit'),
  prepareDraft: input => ipcRenderer.invoke('crosschat:draft-prepare', input),
  executeDraft: (draftId, revision) => ipcRenderer.invoke('crosschat:draft-execute', draftId, revision),
}));
