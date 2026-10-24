import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const { createSlackAccountService } = createRequire(import.meta.url)('../desktop/slack-account.cjs');
const identity = { platform: 'slack', accountKind: 'personal', accountId: 'slack:T123:U456', teamId: 'T123', userId: 'U456' };
function mockStorage({ available = true, failEncrypt = false } = {}) {
  const key = randomBytes(32);
  return {
    async isAsyncEncryptionAvailable() { return available; },
    async encryptStringAsync(text) {
      if (failEncrypt) throw new Error('encryption unavailable');
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(blob) {
      const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString(), shouldReEncrypt: false };
    },
  };
}
async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crosschat-slack-account-'));
  const filePath = path.join(dir, 'account.enc');
  const safeStorage = options.safeStorage || mockStorage();
  let resolveCompletion;
  let cancelled = 0;
  const pkce = options.pkce || {
    isConfigured: true,
    async begin() { return { status: 'ready', authorizeUrl: 'https://slack.com/oauth/v2/authorize?test=1', completion: new Promise(resolve => { resolveCompletion = resolve; }), cancel() { cancelled++; } }; },
    close() {},
  };
  const calls = [];
  const userApi = options.userApi || { async verifyAccount(value) { calls.push(value); return { status: 'verified', account: identity }; } };
  const service = createSlackAccountService({ pkce, userApi, safeStorage, filePath, now: options.now || (() => 1000) });
  return { dir, filePath, safeStorage, service, calls, resolve: (...args) => resolveCompletion?.(...args), get cancelled() { return cancelled; } };
}

test('safeStorage unavailable fails closed without writing account material', async t => {
  const f = await fixture({ safeStorage: mockStorage({ available: false }) });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.equal((await f.service.reload()).state, 'secure-storage-unavailable');
  assert.equal((await f.service.connect(async () => assert.fail('must not open Slack'))).state, 'secure-storage-unavailable');
  assert.deepEqual(await readdir(f.dir), []);
});

test('authorized account is verified, stored atomically as ciphertext, and reverified on restart', async t => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.equal((await f.service.reload()).state, 'signed-out');
  const opened = [];
  assert.equal((await f.service.connect(async url => opened.push(url))).state, 'connecting');
  assert.match(opened[0], /^https:\/\/slack\.com\/oauth\/v2\/authorize/);
  f.resolve({ status: 'authorized', token: { accessToken: 'user-access-secret', refreshToken: 'not-retained', expiresIn: 60, userId: 'U456', teamId: 'T123' } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.service.getStatus().state, 'connected');
  assert.deepEqual(f.service.getStatus().account, identity);
  const ciphertext = await readFile(f.filePath);
  assert.equal(ciphertext.includes(Buffer.from('user-access-secret')), false);
  assert.equal(ciphertext.includes(Buffer.from('not-retained')), false);
  assert.equal((await readdir(f.dir)).filter(name => name.endsWith('.tmp')).length, 0);

  const restarted = createSlackAccountService({ pkce: { isConfigured: true }, userApi: { async verifyAccount(value) { assert.equal(value, 'user-access-secret'); return { status: 'verified', account: identity }; } }, safeStorage: f.safeStorage, filePath: f.filePath, now: () => 2000 });
  assert.equal((await restarted.reload()).state, 'connected');
  assert.deepEqual(restarted.getStatus().account, identity);
  restarted.close();
});

test('encryption error refuses to claim a connected or persisted account', async t => {
  const f = await fixture({ safeStorage: mockStorage({ failEncrypt: true }) });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.service.reload();
  await f.service.connect(async () => {});
  f.resolve({ status: 'authorized', token: { accessToken: 'secret', expiresIn: 60 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.service.getStatus().state, 'storage-unavailable');
  assert.equal(f.service.getStatus().account, null);
  assert.deepEqual(await readdir(f.dir), []);
});

test('disconnect cancels pending OAuth and a late completion cannot restore the account', async t => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.service.reload();
  await f.service.connect(async () => {});
  assert.equal((await f.service.disconnect()).state, 'signed-out');
  f.resolve({ status: 'authorized', token: { accessToken: 'late-secret', expiresIn: 60 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.cancelled, 1);
  assert.equal(f.service.getStatus().state, 'signed-out');
  assert.equal(f.service.getStatus().account, null);
  await assert.rejects(readFile(f.filePath), { code: 'ENOENT' });
  const restarted = createSlackAccountService({ pkce: { isConfigured: true }, userApi: { async verifyAccount() { assert.fail('tombstoned token must not be read'); } }, safeStorage: f.safeStorage, filePath: f.filePath });
  assert.equal((await restarted.reload()).state, 'signed-out');
  restarted.close();
});

test('expired saved authorization is not sent to auth.test and requires reauthorization', async t => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.service.reload(); await f.service.connect(async () => {});
  f.resolve({ status: 'authorized', token: { accessToken: 'expires', expiresIn: 1 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  const expired = createSlackAccountService({ pkce: { isConfigured: true }, userApi: { async verifyAccount() { assert.fail('expired tokens must not be used'); } }, safeStorage: f.safeStorage, filePath: f.filePath, now: () => 10_000 });
  assert.equal((await expired.reload()).state, 'reauthorization-required');
  expired.close();
});
