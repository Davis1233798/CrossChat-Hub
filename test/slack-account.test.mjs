import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const { createSlackAccountService, isFixedAuthorizeUrl } = createRequire(import.meta.url)('../desktop/slack-account.cjs');
const identity = { platform: 'slack', accountKind: 'personal', accountId: 'slack:T123:U456', teamId: 'T123', userId: 'U456' };
const clientId = '12345.67890';
const redirectUri = 'http://localhost:43210/slack/oauth/callback';
const authorizeUrl = `https://slack.com/oauth/v2/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state: 'A'.repeat(43), scope: '', user_scope: 'chat:write', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256' })}`;
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
    async begin() { return { status: 'ready', authorizeUrl, completion: new Promise(resolve => { resolveCompletion = resolve; }), cancel() { cancelled++; } }; },
    close() {},
  };
  const calls = [];
  const userApi = options.userApi || { async verifyAccount(value) { calls.push(value); return { status: 'verified', account: identity }; } };
  const service = createSlackAccountService({ pkce, userApi, safeStorage, filePath, clientId, registeredLoopbackRedirectUri: redirectUri, fsPromises: options.fsPromises, now: options.now || (() => 1000) });
  return { dir, filePath, safeStorage, service, calls, resolve: (...args) => resolveCompletion?.(...args), get cancelled() { return cancelled; } };
}

test('safeStorage unavailable fails closed without writing account material', async t => {
  const f = await fixture({ safeStorage: mockStorage({ available: false }) });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.equal((await f.service.reload()).state, 'secure-storage-unavailable');
  assert.equal((await f.service.connect(async () => assert.fail('must not open Slack'))).state, 'secure-storage-unavailable');
  assert.deepEqual(await readdir(f.dir), []);
});

test('authorize URL validator pins canonical endpoint, every query field and unique PKCE values', () => {
  const expected = { clientId, registeredLoopbackRedirectUri: redirectUri };
  assert.equal(isFixedAuthorizeUrl(authorizeUrl, expected), true);
  for (const bad of [
    authorizeUrl.replace('https://slack.com/', 'https://slack.com:444/'),
    `${authorizeUrl}&extra=1`, `${authorizeUrl}&state=${'A'.repeat(43)}`,
    authorizeUrl.replace(`client_id=${clientId}`, 'client_id=attacker'),
    authorizeUrl.replace(encodeURIComponent(redirectUri), encodeURIComponent('http://evil.test/slack/oauth/callback')),
    authorizeUrl.replace('user_scope=chat%3Awrite', 'user_scope=channels%3Ahistory'),
    authorizeUrl.replace(`code_challenge=${'A'.repeat(43)}`, 'code_challenge=short'),
    authorizeUrl.replace('scope=&', 'scope=bot%3Awrite&'),
    authorizeUrl.replace('https://slack.com/', 'https://slack.com.evil.test/'),
  ]) assert.equal(isFixedAuthorizeUrl(bad, expected), false, bad);
  assert.equal(isFixedAuthorizeUrl(authorizeUrl, { ...expected, clientId: 'other' }), false);
  assert.equal(isFixedAuthorizeUrl(authorizeUrl, { ...expected, registeredLoopbackRedirectUri: 'http://localhost:45678/slack/oauth/callback' }), false);
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

test('disconnect filesystem failures leave no in-session token, block reload and new connect, and allow retry', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crosschat-slack-disconnect-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'account.enc');
  const safeStorage = mockStorage();
  let failMarker = false, failFallbackRename = false, begins = 0;
  const guardedFs = {
    ...fsPromises,
    async open(target, flags, mode) {
      if (failMarker && target === `${filePath}.disabled` && flags === 'wx') throw Object.assign(new Error('marker denied'), { code: 'EACCES' });
      return fsPromises.open(target, flags, mode);
    },
    async rename(from, to) {
      if (failFallbackRename && from === filePath && to === `${filePath}.disabled`) throw Object.assign(new Error('rename denied'), { code: 'EACCES' });
      return fsPromises.rename(from, to);
    },
  };
  const pkce = { isConfigured: true, async begin() { begins++; return { status: 'ready', authorizeUrl, completion: new Promise(() => {}), cancel() {} }; } };
  const service = createSlackAccountService({ pkce, userApi: { async verifyAccount() { return { status: 'verified', account: identity }; } }, safeStorage,
    filePath, clientId, registeredLoopbackRedirectUri: redirectUri, fsPromises: guardedFs });
  await service.reload();
  // Seed one encrypted record through a successful OAuth completion.
  let resolveLogin;
  pkce.begin = async () => { begins++; return { status: 'ready', authorizeUrl, completion: new Promise(resolve => { resolveLogin = resolve; }), cancel() {} }; };
  await service.connect(async () => {});
  resolveLogin({ status: 'authorized', token: { accessToken: 'must-not-return', userId: 'U456', teamId: 'T123', expiresIn: 300 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(service.getStatus().state, 'connected');
  failMarker = true; failFallbackRename = true;
  const failed = await service.disconnect();
  assert.equal(failed.state, 'disconnect-incomplete');
  assert.equal(service.getStatus().account, null);
  assert.equal(service.getStatus().state, 'disconnect-incomplete');
  assert.equal((await service.connect(async () => assert.fail('incomplete disconnect must block new OAuth'))).state, 'disconnect-incomplete');
  assert.equal((await service.reload()).state, 'disconnect-incomplete');
  assert.equal(begins, 1);
  const ui = await fsPromises.readFile(new URL('../desktop/shell.js', import.meta.url), 'utf8');
  assert.match(ui, /解除尚未完成，重啟可能重新載入，請重試/);
  assert.match(ui, /重試解除/);
  failMarker = false; failFallbackRename = false;
  assert.equal((await service.disconnect()).state, 'signed-out');
  assert.equal(service.getStatus().account, null);
  const restarted = createSlackAccountService({ pkce: { isConfigured: true }, userApi: { async verifyAccount() { assert.fail('cleaned token must not be reloaded'); } }, safeStorage,
    filePath, clientId, registeredLoopbackRedirectUri: redirectUri });
  assert.equal((await restarted.reload()).state, 'signed-out');
  restarted.close(); service.close();
});

test('disconnect during async safeStorage decrypt prevents stale reload auth.test', async t => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.service.reload(); await f.service.connect(async () => {});
  f.resolve({ status: 'authorized', token: { accessToken: 'race-token', expiresIn: 60, userId: 'U456', teamId: 'T123' } });
  await new Promise(resolve => setTimeout(resolve, 30));
  let enteredDecrypt;
  const decryptEntered = new Promise(resolve => { enteredDecrypt = resolve; });
  let releaseDecrypt;
  const safeStorage = { ...f.safeStorage, async decryptStringAsync(blob) { enteredDecrypt(); await new Promise(resolve => { releaseDecrypt = resolve; }); return f.safeStorage.decryptStringAsync(blob); } };
  let authCalls = 0;
  const service = createSlackAccountService({ pkce: { isConfigured: true }, userApi: { async verifyAccount() { authCalls++; return { status: 'verified', account: identity }; } },
    safeStorage, filePath: f.filePath, clientId, registeredLoopbackRedirectUri: redirectUri });
  const loading = service.reload();
  await decryptEntered;
  assert.equal((await service.disconnect()).state, 'signed-out');
  releaseDecrypt();
  await loading;
  assert.equal(authCalls, 0);
  assert.equal(service.getStatus().state, 'signed-out');
  service.close();
});

test('disconnect during deferred encryption availability prevents PKCE begin', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crosschat-slack-storage-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let resolveAvailability, beginCalls = 0;
  const safeStorage = { ...mockStorage(), isAsyncEncryptionAvailable: () => new Promise(resolve => { resolveAvailability = resolve; }) };
  const service = createSlackAccountService({ pkce: { isConfigured: true, async begin() { beginCalls++; throw new Error('must not begin'); } },
    userApi: { async verifyAccount() { assert.fail('no token is available'); } }, safeStorage,
    filePath: path.join(dir, 'account.enc'), clientId, registeredLoopbackRedirectUri: redirectUri });
  const connecting = service.connect(async () => assert.fail('must not open authorize URL'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getStatus().state, 'connecting');
  assert.equal((await service.disconnect()).state, 'signed-out');
  resolveAvailability(true);
  assert.equal((await connecting).state, 'signed-out');
  assert.equal(service.getStatus().state, 'signed-out');
  assert.equal(beginCalls, 0);
  service.close();
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
