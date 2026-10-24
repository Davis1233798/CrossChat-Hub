import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { registerForwardingIpc } from '../desktop/forwarding-ipc.cjs';
import { createForwardingDrafts } from '../desktop/forwarding-drafts.mjs';

test('preload IPC traverses main-frame guard into private draft service', async () => {
  const handlers = new Map(), url = 'file:///owned/shell.html';
  const frame = { url }, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
  const arming = { arm: async input => ({ status: 'prepared', armId: 'opaque' }), activate: input => ({ status: 'armed', armId: input.armId }),
    acknowledge: () => ({ status: 'accepted' }), cancel: input => ({ status: 'cancelled' }), close() {} };
  const slackDestinations = {
    inspectCurrent: () => ({ status: 'identified', teamId: 'T123', conversationId: 'C456', label: null, labelStatus: 'unknown-from-url' }),
    selectCurrent: () => ({ status: 'identified', teamId: 'T123', conversationId: 'C456', label: null, labelStatus: 'unknown-from-url', selectionId: 'opaque' }),
    validateSelection: id => id === 'opaque' ? { status: 'identified', teamId: 'T123', conversationId: 'C456', label: null, labelStatus: 'unknown-from-url', selectionId: id } : { status: 'stale' },
  };
  registerForwardingIpc({ handle: (key, fn) => handlers.set(key, fn) }, () => window, url, createForwardingDrafts(), null, arming, slackDestinations);
  let exposed;
  const event = { sender: contents, senderFrame: frame };
  vm.runInNewContext(readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return {
      contextBridge: { exposeInMainWorld: (_name, api) => exposed = api },
      ipcRenderer: { invoke: (key, ...args) => handlers.get(key)(event, ...args) },
    }; },
  });
  const result = await exposed.prepareDraft({ text: '@line:研發群:小明 Hello' });
  assert.equal(result.status, 'unsupported'); assert.equal(result.preview.memberName, '小明');
  assert.equal(result.plan, undefined); assert.equal(result.target, undefined);
  const slackDestination = await exposed.selectCurrentSlackDestination();
  assert.equal(slackDestination.selectionId, 'opaque');
  assert.equal(slackDestination.conversationId, 'C456');
  assert.equal('target' in slackDestination, false);
  assert.equal((await exposed.validateSlackDestination('opaque')).status, 'identified');
  assert.equal((await exposed.executeDraft(result.draftId, result.revision)).status, 'unsupported');
  assert.equal(exposed.captureObservedSelection, undefined);
  const capture = await exposed.captureSelection({ text: '單則原文', platform: 'line', chatName: '來源群' });
  const ref = { selectionId: capture.selectionId, captureRevision: capture.captureRevision };
  const forward = await exposed.prepareSelection({ ...ref, routeText: '@slack:目標頻道' });
  assert.equal(forward.status, 'unsupported'); assert.equal(forward.preview.text, '單則原文');
  assert.equal(forward.source.provenance, 'user-confirmed-selection');
  assert.equal((await exposed.captureSelection({ text: 'x', platform: 'line', chatName: '群', selectionId: 'forged' })).status, 'rejected');
  assert.equal((await exposed.prepareSelection({ ...ref, routeText: '@slack:頻道 偷換內容' })).status, 'rejected');
  assert.equal((await exposed.revokeSelection(ref)).status, 'revoked');
  assert.equal((await exposed.armSelectionCapture({ platform: 'line', chatName: '合成來源' })).status, 'prepared');
  assert.equal((await exposed.activateSelectionCapture({ armId: 'opaque' })).status, 'armed');
  assert.equal((await exposed.cancelSelectionCapture({ armId: 'opaque' })).status, 'cancelled');
  assert.equal((await exposed.acknowledgeSelectionCapture({ armId: 'opaque', selectionId: 'sel', captureRevision: 1 })).status, 'accepted');
  assert.equal((await exposed.executeDraft(forward.draftId, forward.revision)).status, 'rejected');
  for (const bad of [
    { sender: {}, senderFrame: frame }, // remote view or popup
    { sender: contents, senderFrame: { url } }, // iframe, including same-origin
    { sender: contents, senderFrame: null },
  ]) for (const channel of ['draft-prepare', 'selection-capture', 'selection-prepare', 'selection-revoke', 'selection-arm', 'selection-arm-activate', 'selection-arm-cancel', 'selection-arm-ack', 'slack-destination-current', 'slack-destination-select', 'slack-destination-validate']) assert.throws(() => handlers.get(`crosschat:${channel}`)(bad, { text: 'x' }), /Untrusted/);
  frame.url = 'https://example.com/';
  assert.throws(() => handlers.get('crosschat:draft-prepare')(event, { text: 'x' }), /Untrusted/);
});
test('shell composer uses text-only previews and reserves space below external views', () => {
  const html = readFileSync(new URL('../desktop/shell.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../desktop/shell.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(html, /id="compose-send" disabled/);
  assert.match(html, /id="history-scope"/);
  assert.match(js, /僅顯示掃描範圍，可能不是最新/);
  assert.match(html, /textarea id="compose-text"/);
  assert.match(js, /prepareDraft\(input\)/); assert.match(js, /executeDraft\(/); assert.doesNotMatch(js, /innerHTML/);
  assert.match(html, /id="selection-arm"/); assert.match(js, /armSelectionCapture/); assert.match(js, /onObservedSelection/);
  assert.match(html, /id="slack-destination-select"/); assert.match(js, /selectCurrentSlackDestination/);
  assert.match(js, /未發送/);
  assert.doesNotMatch(readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8'), /captureObservedSelection/);
  assert.match(main, /height - HEADER_HEIGHT - COMPOSER_HEIGHT/);
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'forwarding-ledger'\)/);
});
