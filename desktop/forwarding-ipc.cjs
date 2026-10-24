'use strict';
function registerForwardingIpc(ipcMain, getWindow, shellUrl, drafts, lineBinding = null, selectionArming = null, slackDestinations = null) {
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
  for (const [channel, method] of [['selection-capture', 'captureSelection'], ['selection-prepare', 'prepareSelection'], ['selection-revoke', 'revokeSelection']]) {
    ipcMain.handle(`crosschat:${channel}`, (event, input) => {
      if (!trusted(event)) throw new Error('Untrusted composer sender');
      return drafts[method](input);
    });
  }
  if (slackDestinations) {
    ipcMain.handle('crosschat:slack-destination-current', (event, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted composer sender');
      if (args.length) throw new Error('Invalid Slack destination preview request');
      return slackDestinations.inspectCurrent();
    });
    ipcMain.handle('crosschat:slack-destination-select', (event, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted composer sender');
      if (args.length) throw new Error('Invalid Slack destination selection request');
      return slackDestinations.selectCurrent();
    });
    ipcMain.handle('crosschat:slack-destination-validate', (event, selectionId, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted composer sender');
      if (args.length || typeof selectionId !== 'string' || selectionId.length > 128) throw new Error('Invalid Slack destination reference');
      return slackDestinations.validateSelection(selectionId);
    });
  }
  if (selectionArming) {
    ipcMain.handle('crosschat:selection-arm', (event, input, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted selection arm sender');
      if (args.length) throw new Error('Invalid selection arm request');
      return selectionArming.arm(input);
    });
    ipcMain.handle('crosschat:selection-arm-cancel', (event, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted selection arm sender');
      if (args.length > 1) throw new Error('Invalid selection cancel request');
      return selectionArming.cancel(args[0]);
    });
    ipcMain.handle('crosschat:selection-arm-activate', (event, input, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted selection activation sender');
      if (args.length) throw new Error('Invalid selection activation request');
      return selectionArming.activate(input);
    });
    ipcMain.handle('crosschat:selection-arm-ack', (event, input, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted selection acknowledgement sender');
      if (args.length) throw new Error('Invalid selection acknowledgement request');
      return selectionArming.acknowledge(input);
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
      selectionArming?.close();
      return lineBinding.bind(input);
    });
    ipcMain.handle('crosschat:line-bind-clear', (event, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted LINE binding sender');
      if (args.length) throw new Error('Invalid LINE unbind request');
      selectionArming?.close();
      return lineBinding.unbind();
    });
  }
}
module.exports = { registerForwardingIpc };
