import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { parseSlackDestinationUrl, createSlackDestinationSnapshots } = createRequire(import.meta.url)('../desktop/slack-destination.cjs');
const { registerForwardingIpc } = createRequire(import.meta.url)('../desktop/forwarding-ipc.cjs');

test('Slack destination parser accepts only official client workspace/conversation URLs', () => {
  assert.deepEqual(parseSlackDestinationUrl('https://app.slack.com/client/T123ABC/C456DEF'), {
    teamId: 'T123ABC', conversationId: 'C456DEF',
  });
  assert.deepEqual(parseSlackDestinationUrl('https://app.slack.com/client/T123ABC/D456DEF?x=ignored#private'), {
    teamId: 'T123ABC', conversationId: 'D456DEF',
  });
  for (const url of [
    'https://app.slack.com/client/T123ABC',
    'https://app.slack.com/client/E123ABC/C456DEF',
    'https://app.slack.com/client/T123ABC/U456DEF',
    'https://app.slack.com.evil.test/client/T123ABC/C456DEF',
    'http://app.slack.com/client/T123ABC/C456DEF',
    'https://evil.slack.com/client/T123ABC/C456DEF',
    'https://user@app.slack.com/client/T123ABC/C456DEF',
    'https://app.slack.com/signin?team=T123ABC',
  ]) assert.equal(parseSlackDestinationUrl(url), null, url);
});

test('snapshot requires completed current Slack view, active selection, and same identity/revision', () => {
  let active = true, time = 100, invalidations = 0;
  const wc = { id: 77, url: '', destroyed: false, getURL() { return this.url; }, isDestroyed() { return this.destroyed; } };
  const view = { webContents: wc };
  const service = createSlackDestinationSnapshots({
    getSlackView: () => view,
    getActiveSlackView: () => active ? view : null,
    getPartition: () => 'persist:crosschat-slack',
    now: () => time,
    ttlMs: 30,
    makeId: () => 'opaque-selection',
    onInvalidate: () => invalidations++,
  });
  wc.url = 'https://app.slack.com/client/T123ABC/C456DEF';
  assert.equal(service.inspectCurrent().status, 'unknown');
  assert.equal(service.navigationCompleted(wc, wc.url), true);
  const chosen = service.selectCurrent();
  assert.deepEqual(chosen, { status: 'identified', teamId: 'T123ABC', conversationId: 'C456DEF',
    label: null, labelStatus: 'unknown-from-url', source: 'official-slack-tab-url', selectionId: 'opaque-selection' });
  assert.equal(service.validateSelection(chosen.selectionId).status, 'identified');
  active = false;
  assert.equal(service.inspectCurrent().status, 'unknown');
  assert.equal(service.validateSelection(chosen.selectionId).status, 'identified', 'selected snapshot survives switching to another tab');
  active = true;
  service.navigationStarted(wc, true);
  assert.equal(service.validateSelection(chosen.selectionId).status, 'stale');
  wc.url = 'https://app.slack.com/client/T123ABC/C999999';
  assert.equal(service.navigationCompleted(wc, wc.url), true);
  const next = service.selectCurrent();
  assert.equal(next.conversationId, 'C999999');
  wc.url = 'https://app.slack.com/signin';
  assert.equal(service.navigationCompleted(wc, wc.url), false);
  assert.equal(service.validateSelection(next.selectionId).status, 'stale');
  wc.url = 'https://app.slack.com/client/T123ABC/C456DEF';
  service.navigationCompleted(wc, wc.url);
  const expires = service.selectCurrent();
  time += 31;
  assert.equal(service.validateSelection(expires.selectionId).status, 'stale');
  assert.ok(invalidations >= 2);
});

test('late completion from a different webContents cannot replace the Slack snapshot', () => {
  const wc = { id: 7, url: 'https://app.slack.com/client/T1/C1', getURL() { return this.url; }, isDestroyed() { return false; } };
  const other = { ...wc, id: 8 };
  const view = { webContents: wc };
  const service = createSlackDestinationSnapshots({ getSlackView: () => view, getActiveSlackView: () => view, getPartition: () => 'persist:crosschat-slack' });
  assert.equal(service.navigationCompleted(other, other.url), false);
  assert.equal(service.inspectCurrent().status, 'unknown');
});

test('trusted composer IPC exposes only a user-selected public snapshot, never view identity or delivery target', () => {
  const handlers = new Map();
  const wc = { id: 9, url: 'https://app.slack.com/client/T1/C2', getURL() { return this.url; }, isDestroyed() { return false; } };
  const view = { webContents: wc };
  const snapshots = createSlackDestinationSnapshots({ getSlackView: () => view, getActiveSlackView: () => view,
    getPartition: () => 'persist:crosschat-slack', makeId: () => 'opaque' });
  snapshots.navigationCompleted(wc, wc.url);
  const frame = { url: 'file:///owned/shell.html' };
  const contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  registerForwardingIpc({ handle: (key, fn) => handlers.set(key, fn) }, () => window, frame.url, {}, null, null, snapshots);
  const event = { sender: contents, senderFrame: frame };
  const selected = handlers.get('crosschat:slack-destination-select')(event);
  assert.deepEqual(selected, { status: 'identified', teamId: 'T1', conversationId: 'C2', label: null,
    labelStatus: 'unknown-from-url', source: 'official-slack-tab-url', selectionId: 'opaque' });
  assert.equal('target' in selected, false);
  assert.equal('partition' in selected, false);
  assert.equal('webContentsId' in selected, false);
  assert.equal(handlers.get('crosschat:slack-destination-validate')(event, 'opaque').status, 'identified');
  assert.throws(() => handlers.get('crosschat:slack-destination-select')({ sender: {}, senderFrame: frame }), /Untrusted/);
  wc.url = 'https://app.slack.com/signin';
  snapshots.navigationStarted(wc, true);
  assert.equal(handlers.get('crosschat:slack-destination-validate')(event, 'opaque').status, 'stale');
});
