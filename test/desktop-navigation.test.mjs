import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { navigationTarget, protectContents } = require('../desktop/navigation.cjs');
const service = { id: 'slack', title: 'Slack', partition: 'persist:crosschat-slack' };
class Contents extends EventEmitter {
  setWindowOpenHandler(handler) { this.open = handler; }
  getURL() { return 'https://accounts.google.com/login'; }
}
function event() { return { prevented: false, preventDefault() { this.prevented = true; } }; }

test('navigation separates official/auth origins, external links, and unsafe URLs', () => {
  for (const url of ['https://app.slack.com/client', 'https://workspace.slack.com/', 'https://accounts.google.com/login']) {
    assert.equal(navigationTarget('slack', url), 'internal');
  }
  for (const url of ['https://slack.com.evil.test/', 'https://accounts.google.com.evil.test/', 'https://example.com/']) {
    assert.equal(navigationTarget('slack', url), 'external');
  }
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'https://user:secret@slack.com/', 'https://slack.com:8443/', 'http://slack.com/', 'about:blank', 'invalid']) {
    assert.equal(navigationTarget('slack', url), 'deny');
  }
  assert.equal(navigationTarget('discord', 'https://accounts.google.com/'), 'external');
});

test('top-level navigation and redirects are blocked before leaving allowed origins', () => {
  const contents = new Contents();
  const opened = [];
  protectContents(contents, service, { openExternal: url => opened.push(url) });
  for (const type of ['will-navigate', 'will-redirect']) {
    const external = event();
    contents.emit(type, external, 'https://example.com/', false, true);
    assert.equal(external.prevented, true);
    const internal = event();
    contents.emit(type, internal, 'https://app.slack.com/client', false, true);
    assert.equal(internal.prevented, false);
    const unsafe = event();
    contents.emit(type, unsafe, 'file:///secret', false, true);
    assert.equal(unsafe.prevented, true);
  }
  assert.equal(opened.length, 2);
  const iframe = event();
  contents.emit('will-redirect', iframe, 'https://cdn.example.com/', false, false);
  assert.equal(iframe.prevented, false);
});

test('Slack Google authentication keeps the exact YouTube accounts host inside its isolated flow', () => {
  const accountUrl = 'https://accounts.youtube.com/accounts/SetSID';
  assert.equal(navigationTarget('slack', accountUrl), 'internal');
  assert.equal(navigationTarget('slack', 'https://accounts.youtube.com:443/'), 'internal');
  for (const id of ['discord', 'telegram', 'whatsapp', 'line', 'unknown']) {
    assert.equal(navigationTarget(id, accountUrl), 'external');
  }
  for (const url of [
    'https://youtube.com/', 'https://www.youtube.com/', 'https://m.youtube.com/',
    'https://accounts.youtube.com.evil.test/', 'https://evil.accounts.youtube.com/',
    'https://accounts-youtube.com/',
  ]) assert.equal(navigationTarget('slack', url), 'external');
  for (const url of [
    'http://accounts.youtube.com/', 'https://accounts.youtube.com:8443/',
    'https://user:secret@accounts.youtube.com/',
  ]) assert.equal(navigationTarget('slack', url), 'deny');

  const contents = new Contents();
  const opened = [];
  protectContents(contents, service, { openExternal: url => opened.push(url) });
  for (const type of ['will-navigate', 'will-redirect']) {
    const navigation = event();
    contents.emit(type, navigation, accountUrl, false, true);
    assert.equal(navigation.prevented, false);
  }
  const popup = contents.open({ url: accountUrl });
  assert.equal(popup.action, 'allow');
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.partition, service.partition);
  const child = new Contents();
  contents.emit('did-create-window', { webContents: child, isDestroyed: () => false, setTitle() {} });
  const redirect = event();
  child.emit('will-redirect', redirect, accountUrl, false, true);
  assert.equal(redirect.prevented, false);
  assert.equal(child.open({ url: accountUrl }).action, 'allow');
  assert.equal(child.open({ url: 'https://www.youtube.com/' }).action, 'deny');
  assert.deepEqual(opened, ['https://www.youtube.com/']);
});

test('nested popups inherit isolation and navigation guards and show authentication origin', () => {
  const contents = new Contents();
  const opened = [];
  protectContents(contents, service, { openExternal: url => opened.push(url) });
  assert.deepEqual(contents.open({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(contents.open({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/']);
  const allowed = contents.open({ url: 'https://accounts.google.com/login' });
  assert.equal(allowed.action, 'allow');
  assert.deepEqual(allowed.overrideBrowserWindowOptions.webPreferences, {
    partition: service.partition, sandbox: true, nodeIntegration: false,
    contextIsolation: true, webSecurity: true, allowRunningInsecureContent: false,
  });
  const child = new Contents();
  let title;
  contents.emit('did-create-window', { webContents: child, isDestroyed: () => false, setTitle: value => { title = value; } });
  assert.equal(title, 'Slack · https://accounts.google.com');
  const change = event();
  child.emit('page-title-updated', change, 'Trusted bank');
  assert.equal(change.prevented, true);
  assert.deepEqual(child.open({ url: 'https://evil.test/' }), { action: 'deny' });
  const redirect = event();
  child.emit('will-redirect', redirect, 'file:///secret', false, true);
  assert.equal(redirect.prevented, true);
});
