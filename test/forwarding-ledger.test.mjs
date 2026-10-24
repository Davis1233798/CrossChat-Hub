import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createForwardingLedger } from '../desktop/forwarding-ledger.cjs';
import { executeForward, prepareForward, parseChatRoute } from '../src/forwarding.mjs';
const key = 'a'.repeat(64);
const fixture = t => { const dir = mkdtempSync(join(tmpdir(), 'crosschat-ledger-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const receipt = { messageId: 'm1', target: { platform: 'line', accountId: 'a1', chatId: 'c1' } };

test('reservation survives restart and abandoned pending becomes unknown', t => {
  const dir = fixture(t), first = createForwardingLedger(dir);
  assert.equal(first.claim(key), true);
  assert.equal(first.get(key).status, 'pending');
  const restarted = createForwardingLedger(dir);
  assert.equal(restarted.get(key).status, 'unknown');
  assert.equal(restarted.claim(key), false);
  assert.throws(() => restarted.settle(key, { status: 'submitted', receipt }), /not owned/);
});
test('submission persists allowlisted metadata; duplicate settle cannot overwrite', t => {
  const dir = fixture(t), ledger = createForwardingLedger(dir);
  ledger.claim(key);
  ledger.settle(key, { status: 'submitted', receipt: { ...receipt, text: 'SECRET', token: 'TOKEN' }, text: 'SECRET' });
  const restored = createForwardingLedger(dir);
  assert.equal(restored.get(key).status, 'submitted');
  assert.deepEqual(restored.get(key).receipt, receipt);
  assert.equal(restored.claim(key), false);
  assert.doesNotThrow(() => ledger.settle(key, { status: 'submitted', receipt }));
  assert.throws(() => ledger.settle(key, { status: 'unknown' }), /not owned/);
  assert.doesNotMatch(readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf8')).join(''), /SECRET|TOKEN/);
});
test('unknown persists and malformed interrupted files never free a reservation', t => {
  const dir = fixture(t), ledger = createForwardingLedger(dir);
  ledger.claim(key); ledger.settle(key, { status: 'unknown' });
  assert.equal(createForwardingLedger(dir).get(key).status, 'unknown');
  const broken = 'b'.repeat(64);
  writeFileSync(join(dir, `${broken}.claim`), '{');
  writeFileSync(join(dir, `${broken}.outcome`), '{');
  assert.equal(createForwardingLedger(dir).get(broken).status, 'unknown');
  assert.equal(ledger.claim(broken), false);
});
test('separate processes compete for one atomic claim', async t => {
  const dir = fixture(t);
  const modulePath = createRequire(import.meta.url).resolve('../desktop/forwarding-ledger.cjs');
  const script = 'const {createForwardingLedger}=require(process.argv[1]);process.stdout.write(String(createForwardingLedger(process.argv[2]).claim(process.argv[3])))';
  const attempt = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', script, modulePath, dir, key], { windowsHide: true });
    let out = ''; p.stdout.on('data', data => out += data); p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`claim process exited ${code}`)));
  });
  const results = await Promise.all(Array.from({ length: 5 }, attempt));
  assert.equal(results.filter(v => v === 'true').length, 1);
  assert.equal(results.filter(v => v === 'false').length, 4);
  assert.equal(createForwardingLedger(dir).get(key).status, 'unknown');
});
test('ledger I/O failure prevents executeForward from calling adapter', async t => {
  const dir = fixture(t), blocked = join(dir, 'not-a-directory'); writeFileSync(blocked, 'file');
  let calls = 0;
  const adapter = { platform: 'line', accountKind: 'personal', capabilities: { sendText: true },
    resolveChat: async () => [receipt.target], execute: async () => { calls++; return receipt; } };
  const prepared = await prepareForward({ source: { kind: 'compose', draftId: 'draft1' }, route: parseChatRoute('@line:測試 Hello') }, adapter);
  await assert.rejects(executeForward(prepared, adapter, createForwardingLedger(blocked)));
  assert.equal(calls, 0);
});
test('settle write failure leaves reservation blocked across restart', t => {
  const dir = fixture(t), ledger = createForwardingLedger(dir);
  ledger.claim(key); writeFileSync(join(dir, `${key}.outcome`), '{');
  assert.throws(() => ledger.settle(key, { status: 'submitted', receipt }), { code: 'EEXIST' });
  const restored = createForwardingLedger(dir);
  assert.equal(restored.get(key).status, 'unknown'); assert.equal(restored.claim(key), false);
  assert.throws(() => ledger.claim('../bad'), /Invalid delivery key/);
});
test('fsync failure never grants a successful claim or executes a send', async t => {
  const dir = fixture(t);
  let calls = 0;
  const adapter = { platform: 'line', accountKind: 'personal', capabilities: { sendText: true },
    resolveChat: async () => [receipt.target], execute: async () => { calls++; return receipt; } };
  const prepared = await prepareForward({ source: { kind: 'compose', draftId: 'draft2' }, route: parseChatRoute('@line:測試 Hello') }, adapter);
  const ledger = createForwardingLedger(dir);
  const mock = t.mock.method(fs, 'fsyncSync', () => { throw new Error('Injected disk flush failure'); });
  await assert.rejects(executeForward(prepared, adapter, ledger), /disk flush failure/);
  mock.mock.restore();
  assert.equal(calls, 0);
  assert.equal(createForwardingLedger(dir).claim(prepared.plan.dedupeKey), false);
  assert.equal(createForwardingLedger(dir).get(prepared.plan.dedupeKey).status, 'unknown');
});

test('outcome flush failure never publishes submitted, and retry cannot overwrite an outcome', t => {
  const dir = fixture(t), ledger = createForwardingLedger(dir);
  ledger.claim(key);
  const mock = t.mock.method(fs, 'fsyncSync', () => { throw new Error('Injected outcome flush failure'); });
  assert.throws(() => ledger.settle(key, { status: 'submitted', receipt }), /outcome flush failure/);
  mock.mock.restore();
  assert.equal(ledger.get(key).status, 'unknown');
  const restarted = createForwardingLedger(dir);
  assert.equal(restarted.get(key).status, 'unknown');
  assert.equal(restarted.claim(key), false);
  assert.deepEqual(readdirSync(dir), [`${key}.claim`]);
  // A failed settlement relinquishes ownership and cannot be blindly retried.
  assert.throws(() => ledger.settle(key, { status: 'submitted', receipt }), /not owned/);
  // Existing outcomes must never be replaced by a new settlement either.
  const second = 'c'.repeat(64);
  ledger.claim(second);
  const existing = { version: 1, status: 'unknown', settledAt: 1 };
  writeFileSync(join(dir, `${second}.outcome`), JSON.stringify(existing));
  assert.throws(() => ledger.settle(second, { status: 'submitted', receipt }), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${second}.outcome`), 'utf8')), existing);
  assert.equal(ledger.get(second).status, 'unknown');
});
