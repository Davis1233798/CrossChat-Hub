import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createForwardingLedger } = createRequire(import.meta.url)('../desktop/forwarding-ledger.cjs');
const { registerForwardingIpc } = createRequire(import.meta.url)('../desktop/forwarding-ipc.cjs');
const key = n => n.toString(16).padStart(64, '0');

test('recent ledger history survives restart, classifies pending/corrupt as unknown and never releases claims', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crosschat-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = createForwardingLedger(dir);
  const pending = key(1), done = key(2), broken = key(3);
  assert.equal(first.claim(pending, { version: 1, platform: 'slack', teamId: 'T123', chatId: 'C999' }), true);
  assert.equal(first.claim(done), true);
  await first.settle(done, { status: 'submitted', receipt: { messageId: 'm1', target: { platform: 'slack', accountId: 'acct', chatId: 'C123' } } });
  assert.equal(first.claim(broken), true);
  const brokenName = (await readdir(dir)).find(n => n.startsWith(broken) && n.endsWith('.claim'));
  await writeFile(path.join(dir, brokenName), '{bad json');
  const before = (await readdir(dir)).sort();
  const second = createForwardingLedger(dir);
  const rows = second.listRecent(20);
  assert.equal(rows.length, 3);
  assert.equal(rows.find(r => r.platform === 'slack').targetChatId, 'C123');
  assert.equal(rows.filter(r => r.status === 'unknown').length, 2);
  const unknownSlack = rows.find(r => r.status === 'unknown' && r.openSlack);
  assert.equal(unknownSlack.targetChatId, 'C999');
  assert.deepEqual(second.resolveHistorySlackRoute(unknownSlack.id), { teamId: 'T123', chatId: 'C999' });
  assert.equal(second.resolveHistorySlackRoute('forged'), null);
  for (const row of rows) assert.equal('id' in row && row.id.length < 64, true);
  assert.equal(second.claim(pending), false);
  assert.equal(second.claim(broken), false);
  assert.deepEqual((await readdir(dir)).sort(), before);
  assert.throws(() => second.listRecent(1001));
});

test('history IPC accepts only the trusted shell and zero arguments', async () => {
  const handlers = new Map();
  const wc = { isDestroyed: () => false, mainFrame: { url: 'file:///shell.html' } };
  const ipc = { handle: (name, fn) => handlers.set(name, fn) };
  const drafts = { listHistory: () => [{ id: 'opaque', status: 'unknown', time: null }] };
  let openedRef = null;
  registerForwardingIpc(ipc, () => ({ isDestroyed: () => false, webContents: wc }), 'file:///shell.html', drafts, null, null, null, ref => { openedRef = ref; return true; });
  const handler = handlers.get('crosschat:forward-history-list');
  const event = { sender: wc, senderFrame: wc.mainFrame };
  assert.deepEqual(handler(event), [{ id: 'opaque', status: 'unknown', time: null }]);
  assert.throws(() => handler(event, 'extra'));
  assert.throws(() => handler({ ...event, sender: {} }));
  const open = handlers.get('crosschat:forward-history-open-slack');
  assert.equal(open(event, 'opaque-id'), true);
  assert.equal(openedRef, 'opaque-id');
  assert.throws(() => open(event, 'opaque-id', 'https://evil.example'));
});
