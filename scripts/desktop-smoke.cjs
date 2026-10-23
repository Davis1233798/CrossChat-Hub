'use strict';
// Developer/CI smoke only. Never uses the user's messenger profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crosschat-smoke-'));
app.setPath('userData', profile);
require('../desktop/main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  let window;
  for (let attempt = 0; attempt < 100; attempt++) {
    window = BrowserWindow.getAllWindows()[0];
    if (window?.isVisible()) break;
    await delay(100);
  }
  if (!window?.isVisible()) throw new Error('No visible desktop window');
  const selected = () => window.webContents.executeJavaScript('document.querySelector("[data-tab][aria-selected=true]").dataset.tab');
  const choose = async key => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['control'] });
    await delay(200);
  };
  await choose('5');
  if (await selected() !== 'line') throw new Error('Keyboard tab selection did not update the shell');
  if (!await window.webContents.executeJavaScript('!document.getElementById("line").hidden')) throw new Error('LINE limitation panel hidden');
  if (!await window.webContents.executeJavaScript('document.getElementById("clear-profile").hidden')) throw new Error('Unsupported LINE exposes profile clearing');
  if (process.env.CROSSCHAT_SMOKE_SCREENSHOT) {
    const image = await window.webContents.capturePage();
    fs.writeFileSync(process.env.CROSSCHAT_SMOKE_SCREENSHOT, image.toPNG());
  }
  await choose('1');
  if (await selected() !== 'telegram') throw new Error('Web tab selection did not update the shell');
  window.setSize(920, 620);
  await delay(100);
  if (!await window.webContents.executeJavaScript(`(() => {
    const button = document.getElementById('clear-profile');
    const bounds = button.getBoundingClientRect();
    return !button.hidden && !button.disabled && bounds.width > 0 && bounds.right <= innerWidth;
  })()`)) throw new Error('Local profile clearing control is not usable at minimum window width');
  const views = window.contentView.children;
  if (views.length !== 1) throw new Error(`Expected one attached remote view, got ${views.length}`);
  const contents = views[0].webContents;
  if (contents.getLastWebPreferences().nodeIntegration !== false) throw new Error('Remote Node integration enabled');
  console.log('PASS: visible native window, keyboard tab state, LINE limitation panel, isolated remote view; requesting normal close');
  clearTimeout(deadline);
  window.close();
}).catch(error => { console.error(error); app.exit(1); });
