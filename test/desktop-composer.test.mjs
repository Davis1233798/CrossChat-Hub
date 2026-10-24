import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { registerForwardingIpc } from '../desktop/forwarding-ipc.cjs';
import { createForwardingDrafts } from '../desktop/forwarding-drafts.mjs';

test('preload IPC traverses main-frame guard into private draft service', async () => {
  const handlers = new Map(), url = 'file:///owned/shell.html';
  const frame = { url }, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
  registerForwardingIpc({ handle: (key, fn) => handlers.set(key, fn) }, () => window, url, createForwardingDrafts());
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
  assert.equal((await exposed.executeDraft(result.draftId, result.revision)).status, 'unsupported');
  for (const bad of [
    { sender: {}, senderFrame: frame }, // remote view or popup
    { sender: contents, senderFrame: { url } }, // iframe, including same-origin
    { sender: contents, senderFrame: null },
  ]) assert.throws(() => handlers.get('crosschat:draft-prepare')(bad, { text: 'x' }), /Untrusted/);
  frame.url = 'https://example.com/';
  assert.throws(() => handlers.get('crosschat:draft-prepare')(event, { text: 'x' }), /Untrusted/);
});
test('shell composer uses text-only previews and reserves space below external views', () => {
  const html = readFileSync(new URL('../desktop/shell.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../desktop/shell.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(html, /id="compose-send" disabled/);
  assert.match(html, /textarea id="compose-text"/);
  assert.match(js, /prepareDraft\(input\)/); assert.doesNotMatch(js, /executeDraft\(|innerHTML/);
  assert.match(main, /height - HEADER_HEIGHT - COMPOSER_HEIGHT/);
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'forwarding-ledger'\)/);
});
