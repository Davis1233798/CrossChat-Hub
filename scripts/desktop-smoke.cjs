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
  const composer = await window.webContents.executeJavaScript(`(async () => {
    const draft = await window.crosschatDesktop.prepareDraft({text:'@line:測試群:小明 Hello'});
    const attempt = await window.crosschatDesktop.executeDraft(draft.draftId,draft.revision);
    const input = document.getElementById('compose-text'); input.focus();
    const bounds = document.getElementById('composer').getBoundingClientRect();
    return {status:draft.status,member:draft.preview?.memberName,attempt:attempt.status,
      privatePlan:!draft.plan&&!draft.target,disabled:document.getElementById('compose-send').disabled,
      focused:document.activeElement===input,top:bounds.top,bottom:bounds.bottom,height:innerHeight};
  })()`);
  if (composer.status !== 'unsupported' || composer.member !== '小明' || composer.attempt !== 'unsupported' ||
      !composer.privatePlan || !composer.disabled || !composer.focused || composer.bottom > composer.height) throw new Error('Composer IPC/private unsupported state failed');
  const selection = await window.webContents.executeJavaScript(`(async () => {
    const api=window.crosschatDesktop;
    const capture=await api.captureSelection({text:'隔離測試單則文字',platform:'line',chatName:'合成來源'});
    const ref={selectionId:capture.selectionId,captureRevision:capture.captureRevision};
    const preview=await api.prepareSelection({...ref,routeText:'@slack:合成目的'});
    const malformed=await api.captureSelection({text:'x',platform:'line',chatName:'x',selectionId:'fake'});
    const mixed=await api.prepareSelection({...ref,routeText:'@slack:目的 冒充原文'});
    const noSend=await api.executeDraft(preview.draftId,preview.revision);
    await api.revokeSelection(ref);
    const revoked=await api.executeDraft(preview.draftId,preview.revision);
    document.getElementById('compose-mode').value='selection';
    document.getElementById('compose-mode').dispatchEvent(new Event('change'));
    document.getElementById('compose-text').value='隔離UI原文';
    document.getElementById('source-chat').value='合成來源群';
    document.getElementById('compose-route').value='@slack:合成頻道';
    document.getElementById('compose-preview').click();
    return {status:preview.status,text:preview.preview?.text,provenance:preview.source?.provenance,
      malformed:malformed.status,mixed:mixed.status,noSend:noSend.status,revoked:revoked.status};
  })()`);
  if (selection.status!=='unsupported'||selection.text!=='隔離測試單則文字'||selection.provenance!=='user-confirmed-selection'||selection.malformed!=='rejected'||selection.mixed!=='rejected'||selection.noSend!=='unsupported'||selection.revoked!=='rejected') throw new Error('Selection IPC isolation failed');
  await delay(100);
  if (!await window.webContents.executeJavaScript('document.getElementById("compose-status").textContent.includes("人工確認，未經平台驗證") && document.getElementById("compose-status").textContent.includes("合成頻道") && document.getElementById("compose-send").disabled')) throw new Error('Selection renderer preview failed');
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
  const composerTop = await window.webContents.executeJavaScript('document.getElementById("composer").getBoundingClientRect().top');
  const remoteBounds = views[0].getBounds();
  if (remoteBounds.y + remoteBounds.height > composerTop) throw new Error('Remote view overlaps composer');
  if (contents.getLastWebPreferences().nodeIntegration !== false) throw new Error('Remote Node integration enabled');
  console.log('PASS: visible native window, keyboard tab state, LINE limitation panel, isolated remote view; requesting normal close');
  clearTimeout(deadline);
  window.close();
}).catch(error => { console.error(error); app.exit(1); });
