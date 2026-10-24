'use strict';
// Developer/CI smoke only. Never uses the user's messenger profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crosschat-smoke-'));
process.env.CROSSCHAT_PRODUCT_SMOKE = '1';
let simulatedHotkey = null, triggerDuringRegistration = false, observedText = '隔離產品 smoke 選取文字', observationStatus = 'observed';
let registeredAccelerator = null, unregisterCount = 0, observationCount = 0, registerCount = 0;
globalThis[Symbol.for('crosschat.productSmokeHooks')] = {
  registerShortcut(accelerator, callback) {
    registerCount++; registeredAccelerator = accelerator; simulatedHotkey = callback;
    if (triggerDuringRegistration) { triggerDuringRegistration = false; callback(); }
    return true;
  },
  unregisterShortcut(accelerator) { if (registeredAccelerator === accelerator) { registeredAccelerator = null; simulatedHotkey = null; unregisterCount++; } },
  async observeSelection(platform) {
    observationCount++;
    if (platform !== 'line' || observationStatus !== 'observed') return { status: 'unsupported', reason: 'synthetic-observation-failure' };
    return { status: 'observed', text: observedText, provenance: 'ui-selected-text-unverified-origin' };
  },
};
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
  await window.webContents.executeJavaScript('document.querySelector("[data-tab=line]").click()');
  await window.webContents.executeJavaScript('document.getElementById("line-candidates-refresh").click()');
  await delay(100);
  const candidateButton = await window.webContents.executeJavaScript('document.querySelector("#line-candidate-list button")?.textContent');
  if (!candidateButton?.includes('第 1 個視窗')) throw new Error('Synthetic LINE candidate list was not rendered');
  await window.webContents.executeJavaScript('document.querySelector("#line-candidate-list button").click()');
  await delay(100);
  if (!await window.webContents.executeJavaScript('document.getElementById("line-binding-status").textContent.includes("已綁定")')) throw new Error('Synthetic LINE candidate confirmation did not bind');
  if (!await window.webContents.executeJavaScript('document.getElementById("line-unbind").hidden === false')) throw new Error('Synthetic binding did not expose unbind');
  triggerDuringRegistration = true;
  await window.webContents.executeJavaScript(`(() => {
    const mode=document.getElementById('compose-mode'); mode.value='selection'; mode.dispatchEvent(new Event('change'));
    document.getElementById('source-platform').value='line';
    document.getElementById('source-platform').dispatchEvent(new Event('change'));
    document.getElementById('source-chat').value='合成來源聊天室';
    document.getElementById('source-chat').dispatchEvent(new Event('input'));
    document.getElementById('compose-text').value='原本人工輸入內容';
    document.getElementById('compose-text').dispatchEvent(new Event('input'));
    document.getElementById('selection-arm').click();
  })()`);
  await delay(100);
  if (registerCount !== 1 || registeredAccelerator !== null || simulatedHotkey !== null) throw new Error('Immediate simulated hotkey did not consume the temporary shortcut exactly once');
  await delay(150);
  if (observationCount !== 1) throw new Error('Immediate simulated hotkey did not produce exactly one observation');
  const observed = await window.webContents.executeJavaScript(`({text:document.getElementById('compose-text').value,
    status:document.getElementById('compose-status').textContent,
    hint:document.getElementById('selection-source-hint').textContent})`);
  if (observed.text !== observedText || !observed.status.includes('已讀取選取文字') || !observed.hint.includes('未經平台驗證')) throw new Error('Observed selection was not captured into the compose draft');
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('compose-text').value='保留的原文';
    document.getElementById('compose-text').dispatchEvent(new Event('input'));
    document.getElementById('selection-arm').click();
  })()`);
  await delay(80);
  observationStatus = 'failure';
  const failHotkey = simulatedHotkey; failHotkey(); await delay(120);
  if (await window.webContents.executeJavaScript('document.getElementById("compose-text").value') !== '保留的原文') throw new Error('Failed selection observation overwrote existing source text');
  if (!unregisterCount) throw new Error('Selection shortcut was not unregistered after capture');
  await window.webContents.executeJavaScript('document.getElementById("line-unbind").click()');
  await delay(80);
  const armAfterUnbind = await window.webContents.executeJavaScript(`window.crosschatDesktop.armSelectionCapture({platform:'line',chatName:'合成來源聊天室'})`);
  if (armAfterUnbind.status !== 'unavailable' || registeredAccelerator !== null) throw new Error('Selection arm remained available after unbind');
  console.log('PASS: mock binding IPC and simulated main-process shortcut capture; selection helper/OS hotkey were not exercised');
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
