'use strict';
const { app, BrowserWindow, session, dialog } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const profile = process.env.CROSSCHAT_STORAGE_PROFILE;
const origin = process.env.CROSSCHAT_STORAGE_ORIGIN;
const phase = process.env.CROSSCHAT_STORAGE_PHASE;
if (!profile || !path.isAbsolute(profile) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !['seed', 'verify', 'clear', 'resume-clear', 'verify-cleared'].includes(phase)) {
  throw new Error('Only a disposable profile and loopback test origin are accepted');
}
app.setPath('userData', profile);
// Resolve test web views to the loopback fixture before the real entrypoint
// imports configuration. Production configuration and navigation policy stay
// unchanged; no competing live-provider navigation can race fixture inspection.
const configPath = require.resolve('../desktop/tab-config.cjs');
const config = require(configPath);
const fixtureServices = config.SERVICES.map(service => service.kind === 'web' ? { ...service, url: origin } : service);
require.cache[configPath].exports = { ...config, SERVICES: fixtureServices, getService: id => fixtureServices.find(service => service.id === id) || null };
require('../desktop/main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function loadFixture(contents) {
  // Startup/recreated views may already be navigating to this same fixture.
  // Wait for that navigation rather than aborting it with a second loadURL.
  if (contents.isLoading()) await new Promise(resolve => contents.once('did-stop-loading', resolve));
  if (contents.getURL() !== origin && contents.getURL() !== origin + '/') await loadFixture(contents);
}
app.whenReady().then(async () => {
  let window;
  for (let attempt = 0; attempt < 100; attempt++) {
    window = BrowserWindow.getAllWindows()[0];
    if (window?.isVisible() && (window.contentView.children.length || phase === 'resume-clear')) break;
    await delay(100);
  }
  assert.equal(window?.isVisible(), true);
  const shell = window.webContents;
  if (phase === 'seed') {
    await shell.executeJavaScript('window.crosschatDesktop.switchTab("slack")');
  } else {
    assert.equal(await shell.executeJavaScript('localStorage.getItem("crosschat-last-tab")'), 'slack');
  }
  if (phase === 'resume-clear') {
    assert.equal(window.contentView.children.length, 0, 'Incomplete reset must remain blocked after restart');
    assert.equal(await shell.executeJavaScript('document.getElementById("profile-state").hidden'), false);
    const originalDialog = dialog.showMessageBox;
    try {
      dialog.showMessageBox = async () => ({ response: 1 });
      assert.deepEqual(await shell.executeJavaScript('window.crosschatDesktop.clearProfile("slack")'), { state: 'cleared' });
    } finally { dialog.showMessageBox = originalDialog; }
    assert.equal(await shell.executeJavaScript('document.getElementById("profile-state").hidden'), true);
  }
  const contents = window.contentView.children[0].webContents;
  assert.equal(contents.session, session.fromPartition('persist:crosschat-slack'));
  await loadFixture(contents);
  assert.equal(new URL(contents.getURL()).origin, origin);
  // Script inspection is restricted to the synthetic loopback fixture above.
  // No script is injected into a messenger provider or any real account.
  if (phase === 'seed') {
    await contents.session.cookies.set({ url: origin, name: 'crosschat-test', value: 'synthetic', expirationDate: Math.floor(Date.now() / 1000) + 3600 });
    await contents.executeJavaScript(`(async () => {
      localStorage.setItem('crosschat-test', 'synthetic');
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('crosschat-test', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('state');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite');
        tx.objectStore('state').put('synthetic', 'marker');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    })()`);
    console.log('PASS: synthetic storage seeded; requesting normal native window close');
    window.close();
  } else if (phase === 'verify') {
    const cookies = await contents.session.cookies.get({ url: origin, name: 'crosschat-test' });
    assert.equal(cookies[0]?.value, 'synthetic');
    assert.equal(await contents.executeJavaScript('localStorage.getItem("crosschat-test")'), 'synthetic');
    const marker = await contents.executeJavaScript(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('crosschat-test', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise((resolve, reject) => {
        const request = db.transaction('state').objectStore('state').get('marker');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return value;
    })()`);
    assert.equal(marker, 'synthetic');
    const other = session.fromPartition('persist:crosschat-discord');
    assert.deepEqual(await other.cookies.get({ url: origin, name: 'crosschat-test' }), []);
    await shell.executeJavaScript('window.crosschatDesktop.switchTab("discord")');
    const otherContents = window.contentView.children[0].webContents;
    await loadFixture(otherContents);
    assert.equal(new URL(otherContents.getURL()).origin, origin);
    assert.equal(await otherContents.executeJavaScript('localStorage.getItem("crosschat-test")'), null);
    await other.cookies.set({ url: origin, name: 'crosschat-test', value: 'other-provider', expirationDate: Math.floor(Date.now() / 1000) + 3600 });
    await otherContents.executeJavaScript('localStorage.setItem("crosschat-test", "other-provider")');
    await shell.executeJavaScript('window.crosschatDesktop.switchTab("slack")');
    console.log('PASS: synthetic cookie, DOM storage, IndexedDB and partition isolation verified; requesting application quit');
    app.quit();
  } else {
    assert.equal(await shell.executeJavaScript('localStorage.getItem("crosschat-last-tab")'), 'slack');
    if (phase === 'clear') {
      assert.equal((await contents.session.cookies.get({ url: origin, name: 'crosschat-test' }))[0]?.value, 'synthetic');
      const originalDialog = dialog.showMessageBox;
      try {
        // Only the native confirmation answer is mocked. IPC, view teardown,
        // Chromium clearing APIs, disk writes and process restart are real.
        let confirmations = 0;
        dialog.showMessageBox = async (_parent, options) => {
          confirmations++;
          assert.equal(options.cancelId, 0);
          assert.match(options.title, /Slack/);
          return { response: 0 };
        };
        await shell.executeJavaScript('document.getElementById("clear-profile").click()');
        for (let attempt = 0; attempt < 50; attempt++) {
          if (confirmations && !await shell.executeJavaScript('document.getElementById("clear-profile").disabled')) break;
          await delay(20);
        }
        assert.equal(confirmations, 1);
        assert.equal(await shell.executeJavaScript('document.getElementById("clear-profile").disabled'), false);
        assert.equal(contents.isDestroyed(), false);
        assert.equal((await contents.session.cookies.get({ url: origin, name: 'crosschat-test' }))[0]?.value, 'synthetic');
        // Exercise a real provider-owned auth popup, not a manually tracked mock.
        await contents.executeJavaScript('window.open("https://slack.com/", "crosschat-smoke-auth"); null', true);
        let popup;
        for (let attempt = 0; attempt < 50; attempt++) {
          popup = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
          if (popup) break;
          await delay(20);
        }
        assert.ok(popup, 'Authentication popup was not created');
        popup.webContents.stop();
        assert.equal(popup.webContents.session, contents.session);
        dialog.showMessageBox = async () => ({ response: 1 });
        const isolatedSession = contents.session;
        const originalClear = isolatedSession.clearData;
        try {
          isolatedSession.clearData = async () => { throw new Error('Synthetic deletion failure'); };
          assert.deepEqual(await shell.executeJavaScript('window.crosschatDesktop.clearProfile("slack")'), { state: 'reset-error' });
          assert.equal(await shell.executeJavaScript('document.getElementById("profile-state").hidden'), false);
          await shell.executeJavaScript('window.crosschatDesktop.switchTab("slack")');
          assert.equal(window.contentView.children.length, 0, 'Failed reset reopened remote content');
          assert.equal((await isolatedSession.cookies.get({ url: origin, name: 'crosschat-test' }))[0]?.value, 'synthetic');
          if (process.env.CROSSCHAT_STORAGE_SCREENSHOT) {
            window.setSize(920, 620);
            await delay(100);
            require('node:fs').writeFileSync(process.env.CROSSCHAT_STORAGE_SCREENSHOT, (await shell.capturePage()).toPNG());
          }
        } finally { isolatedSession.clearData = originalClear; }
        assert.equal(contents.isDestroyed(), true);
        assert.equal(popup.isDestroyed(), true);
        console.log('PASS: cancellation preserved storage; injected deletion failure kept the target blocked and closed its auth popup; closing before retry');
        window.close();
        return;
      } finally { dialog.showMessageBox = originalDialog; }
    }
    const target = window.contentView.children[0].webContents;
    await loadFixture(target);
    assert.equal(new URL(target.getURL()).origin, origin);
    assert.deepEqual(await target.session.cookies.get({ url: origin, name: 'crosschat-test' }), []);
    assert.equal(await target.executeJavaScript('localStorage.getItem("crosschat-test")'), null);
    assert.deepEqual(await target.executeJavaScript('indexedDB.databases().then(items => items.map(item => item.name))'), []);
    await shell.executeJavaScript('window.crosschatDesktop.switchTab("discord")');
    const other = window.contentView.children[0].webContents;
    await loadFixture(other);
    assert.equal(new URL(other.getURL()).origin, origin);
    assert.equal((await other.session.cookies.get({ url: origin, name: 'crosschat-test' }))[0]?.value, 'other-provider');
    assert.equal(await other.executeJavaScript('localStorage.getItem("crosschat-test")'), 'other-provider');
    await shell.executeJavaScript('window.crosschatDesktop.switchTab("slack")');
    console.log(`PASS: ${phase} verified target data absent and other provider preserved; requesting normal close`);
    window.close();
  }
}).catch(error => { console.error(error); app.exit(1); });
