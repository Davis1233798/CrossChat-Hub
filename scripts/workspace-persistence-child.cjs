'use strict';
// Disposable Electron integration test. Provider navigation is intercepted before
// any renderer can request it and replaced with the owned loopback fixture.
const { app, BrowserWindow, session, dialog } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { createWorkspaceState } = require('../desktop/workspace-state.cjs');
const profile = process.env.CROSSCHAT_WORKSPACE_PROFILE;
const origin = process.env.CROSSCHAT_WORKSPACE_ORIGIN;
const phase = process.env.CROSSCHAT_WORKSPACE_PHASE;
if (!profile || !path.isAbsolute(profile) || path.resolve(path.dirname(profile)) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('crosschat-workspace-smoke-') ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !['seed', 'restore-clear', 'cleared'].includes(phase)) throw Error('Disposable fixture arguments required');
app.setPath('userData', profile);
const expected = 'https://app.slack.com/client/TTEST123';
const preference = createWorkspaceState(path.join(profile, 'workspace-state'));
const requested = [];
app.on('web-contents-created', (_event, contents) => {
  const load = contents.loadURL.bind(contents);
  contents.loadURL = (url, options) => {
    if (contents.session === session.fromPartition('persist:crosschat-slack')) requested.push(url);
    return load(/^https?:/.test(url) ? origin : url, options);
  };
});
require('../desktop/main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => failTest(Error('Workspace smoke timed out')), 20000);
app.whenReady().then(async () => {
  let window;
  for (let attempt = 0; attempt < 100; attempt++) {
    window = BrowserWindow.getAllWindows()[0];
    if (window?.isVisible()) break;
    await delay(50);
  }
  assert.equal(window?.isVisible(), true);
  if (process.env.CROSSCHAT_WORKSPACE_ASSERT_FAILURE === '1') assert.fail('Intentional workspace smoke assertion failure');
  await window.webContents.executeJavaScript('window.crosschatDesktop.switchTab("slack")');
  const contents = window.contentView.children[0].webContents;
  if (contents.isLoading()) await new Promise(resolve => contents.once('did-stop-loading', resolve));
  assert.equal(new URL(contents.getURL()).origin, origin);
  assert.equal(requested[0], phase === 'restore-clear' ? expected : 'https://slack.com/signin');
  if (phase === 'seed') {
    // Simulate a provider success event on the real main-owned WebContents.
    // No Slack network, session or authentication participates in this test.
    contents.emit('did-navigate', {}, `${expected}/CTEST456?token=synthetic#ignored`, 200, 'OK');
    contents.emit('did-navigate-in-page', {}, 'https://app.slack.com/client/TWRONG123', false, 0, 0);
    assert.equal(preference.read(), expected, 'Subframes must not overwrite the main workspace');
  } else if (phase === 'restore-clear') {
    assert.equal(preference.read(), expected);
    dialog.showMessageBox = async () => ({ response: 1 });
    assert.deepEqual(await window.webContents.executeJavaScript('window.crosschatDesktop.clearProfile("slack")'), { state: 'cleared' });
    assert.equal(preference.read(), null);
    assert.equal(requested.at(-1), 'https://slack.com/signin');
  } else assert.equal(preference.read(), null);
  console.log(`PASS: workspace ${phase}; real Electron main, intercepted synthetic provider navigation`);
  clearTimeout(deadline);
  window.close();
}).catch(failTest);
function failTest(error) {
  console.error(error);
  // app.exit closes windows; the production window-all-closed shutdown must
  // not replace this test's assertion failure with a successful exit code.
  app.removeAllListeners('window-all-closed');
  app.removeAllListeners('before-quit');
  for (const window of BrowserWindow.getAllWindows()) {
    window.removeAllListeners('close');
    window.removeAllListeners('closed');
  }
  app.exit(1);
}
