'use strict';
function registerForwardingIpc(ipcMain, getWindow, shellUrl, drafts, lineBinding = null) {
  const trusted = event => {
    const window = getWindow();
    return window && !window.isDestroyed() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === shellUrl;
  };
  ipcMain.handle('crosschat:draft-prepare', (event, input) => {
    if (!trusted(event)) throw new Error('Untrusted composer sender');
    return drafts.prepare(input);
  });
  ipcMain.handle('crosschat:draft-execute', (event, id, revision) => {
    if (!trusted(event)) throw new Error('Untrusted composer sender');
    if (typeof id !== 'string' || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid draft reference');
    return drafts.execute(id, revision);
  });
  for (const [channel, method] of [['selection-capture', 'captureSelection'], ['selection-observe', 'captureObservedSelection'], ['selection-prepare', 'prepareSelection'], ['selection-revoke', 'revokeSelection']]) {
    ipcMain.handle(`crosschat:${channel}`, (event, input) => {
      if (!trusted(event)) throw new Error('Untrusted composer sender');
      return drafts[method](input);
    });
  }
  if (lineBinding) {
    ipcMain.handle('crosschat:line-bind-list', (event, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted LINE binding sender');
      if (args.length) throw new Error('Invalid LINE candidate request');
      return lineBinding.list();
    });
    ipcMain.handle('crosschat:line-bind-confirm', (event, input, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted LINE binding sender');
      if (args.length) throw new Error('Invalid LINE confirmation request');
      return lineBinding.bind(input);
    });
    ipcMain.handle('crosschat:line-bind-clear', (event, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted LINE binding sender');
      if (args.length) throw new Error('Invalid LINE unbind request');
      return lineBinding.unbind();
    });
  }
}
module.exports = { registerForwardingIpc };
