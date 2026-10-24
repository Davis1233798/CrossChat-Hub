import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSlackUserApi } from '../desktop/slack-user-api.mjs';
import { createSlackPersonalAdapter } from '../desktop/slack-personal-adapter.mjs';
import { createForwardingDrafts } from '../desktop/forwarding-drafts.mjs';
import { createForwardingLedger } from '../desktop/forwarding-ledger.cjs';
import { createSlackDestinationSnapshots } from '../desktop/slack-destination.cjs';

const { createSlackAccountService } = createRequire(import.meta.url)('../desktop/slack-account.cjs');
const acct = { platform: 'slack', accountKind: 'personal', accountId: 'slack:T123:U456', teamId: 'T123', userId: 'U456' };
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

async function setup(t, { delayPost = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crosschat-slack-forward-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let posts = 0;
  let authGate = null, authGateAt = Infinity, authChecks = 0;
  const api = createSlackUserApi({ fetchFn: async (url, request) => {
    if (url.endsWith('/auth.test')) { authChecks++; if (authGate && authChecks >= authGateAt) await authGate(); return json({ ok: true, team_id: 'T123', user_id: 'U456' }); }
    posts++;
    const body = JSON.parse(request.body);
    assert.equal(request.headers.authorization, 'Bearer private-fixture-token');
    assert.equal(body.channel, 'C789');
    if (delayPost) await delayPost();
    return json({ ok: true, channel: 'C789', ts: '1771862400.000123' });
  } });
  const storage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(text) { return Buffer.from(text); },
    async decryptStringAsync(buffer) { return { result: buffer.toString(), shouldReEncrypt: false }; },
  };
  let finishOAuth;
  const redirectUri = 'http://localhost:43210/slack/oauth/callback';
  const authorizeUrl = `https://slack.com/oauth/v2/authorize?${new URLSearchParams({ client_id: 'cid', redirect_uri: redirectUri, state: randomBytes(32).toString('base64url'), scope: '', user_scope: 'chat:write', code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256' })}`;
  const accountService = createSlackAccountService({ pkce: { isConfigured: true, async begin() { return {
    status: 'ready', authorizeUrl, completion: new Promise(resolve => finishOAuth = resolve), cancel() {},
  }; } }, userApi: api, safeStorage: storage, filePath: path.join(directory, 'account.enc'), clientId: 'cid', registeredLoopbackRedirectUri: redirectUri });
  await accountService.reload();
  await accountService.connect(async () => {});
  finishOAuth({ status: 'authorized', token: { accessToken: 'private-fixture-token', userId: 'U456', teamId: 'T123' } });
  for (let i = 0; i < 20 && accountService.getStatus().state !== 'connected'; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(accountService.getStatus().state, 'connected');

  const webContents = { id: 7, getURL: () => 'https://app.slack.com/client/T123/C789' };
  const view = { webContents, isDestroyed: () => false };
  const destinations = createSlackDestinationSnapshots({ getSlackView: () => view, getActiveSlackView: () => view, getPartition: () => 'persist:slack' });
  destinations.navigationCompleted(webContents, webContents.getURL());
  const selected = destinations.selectCurrent();
  const ledger = createForwardingLedger(path.join(directory, 'ledger'));
  const drafts = createForwardingDrafts({
    validateDestination: id => destinations.resolveSelection(id),
    adapterFor: (platform, destination, sourceValid) => platform === 'slack' && destination ? createSlackPersonalAdapter({
      accountService, userApi: api, destinations, selectionId: destination.selectionId, selectedAccount: accountService.getStatus().account, sourceValid,
    }) : null,
    ledger,
  });
  return { api, accountService, destinations, selected, drafts, ledger, posts: () => posts, authChecks: () => authChecks,
    setAuthGate: (gate, after = 1) => { authGate = gate; authGateAt = authChecks + after; }, webContents, directory };
}

test('verified selected Slack destination sends once and persists the API receipt', async t => {
  const f = await setup(t);
  const draft = await f.drafts.prepare({ text: '@slack:C789 hello', slackDestinationSelectionId: f.selected.selectionId });
  assert.equal(draft.status, 'prepared');
  const result = await f.drafts.execute(draft.draftId, draft.revision);
  assert.equal(result.status, 'submitted'); assert.match(result.summary, /API 回執/);
  assert.equal(f.posts(), 1);
  assert.deepEqual(f.drafts && (await f.drafts.execute(draft.draftId, draft.revision)).status, 'rejected');
});

test('stale destination and renderer supplied IDs cannot prepare or send', async t => {
  const f = await setup(t);
  assert.equal((await f.drafts.prepare({ text: '@slack:general hello', slackDestinationSelectionId: f.selected.selectionId })).status, 'unsupported');
  assert.equal((await f.drafts.prepare({ text: '@slack:C789 hello', slackDestinationSelectionId: 'forged', accountId: acct.accountId })).status, 'rejected');
  const draft = await f.drafts.prepare({ text: '@slack:C789 hello', slackDestinationSelectionId: f.selected.selectionId });
  f.destinations.navigationStarted(f.webContents);
  assert.notEqual((await f.drafts.execute(draft.draftId, draft.revision)).status, 'submitted');
  assert.equal(f.posts(), 0);
});

test('post started before disconnect returns submitted receipt or unknown, never cancellation', async t => {
  let release;
  const gate = new Promise(resolve => release = resolve);
  const f = await setup(t, { delayPost: () => gate });
  const draft = await f.drafts.prepare({ text: '@slack:C789 hello', slackDestinationSelectionId: f.selected.selectionId });
  const sending = f.drafts.execute(draft.draftId, draft.revision);
  while (!f.posts()) await new Promise(resolve => setTimeout(resolve, 0));
  await f.accountService.disconnect();
  release();
  assert.equal((await sending).status, 'submitted');
  assert.equal(f.posts(), 1);
});

test('selected destination is exact ID only and mentions or attachments remain unsupported', async t => {
  const f = await setup(t);
  const invalid = await f.drafts.prepare({ text: '@slack:C789:someone hello', slackDestinationSelectionId: f.selected.selectionId });
  assert.equal(invalid.status, 'unsupported');
  assert.equal(f.posts(), 0);
});

test('destination invalidation during account revalidation stops before POST and before ledger claim', async t => {
  const f = await setup(t);
  const draft = await f.drafts.prepare({ text: '@slack:C789 hello', slackDestinationSelectionId: f.selected.selectionId });
  let release;
  const gate = new Promise(resolve => release = resolve);
  const priorChecks = f.authChecks();
  f.setAuthGate(() => gate);
  const sending = f.drafts.execute(draft.draftId, draft.revision);
  while (f.authChecks() < priorChecks + 1) await new Promise(resolve => setTimeout(resolve, 0));
  f.destinations.navigationStarted(f.webContents);
  release();
  assert.notEqual((await sending).status, 'submitted');
  assert.equal(f.posts(), 0);
  const files = await readdir(path.join(f.directory, 'ledger')).catch(() => []);
  assert.deepEqual(files, []);
});

test('source revocation during account revalidation stops before POST and before ledger claim', async t => {
  const f = await setup(t);
  const source = f.drafts.captureSelection({ text: 'manual source text', platform: 'line', chatName: 'manual source' });
  const sourceRef = { selectionId: source.selectionId, captureRevision: source.captureRevision };
  const draft = await f.drafts.prepareSelection({ ...sourceRef, routeText: '@slack:C789', slackDestinationSelectionId: f.selected.selectionId });
  assert.equal(draft.status, 'prepared');
  let release;
  const gate = new Promise(resolve => release = resolve);
  const priorChecks = f.authChecks();
  f.setAuthGate(() => gate);
  const sending = f.drafts.execute(draft.draftId, draft.revision);
  while (f.authChecks() < priorChecks + 1) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.drafts.revokeSelection(sourceRef).status, 'revoked');
  release();
  assert.notEqual((await sending).status, 'submitted');
  assert.equal(f.posts(), 0);
  assert.deepEqual(await readdir(path.join(f.directory, 'ledger')).catch(() => []), []);
});

test('disconnect during final Slack API auth check stops before POST and leaves conservative unknown claim', async t => {
  const f = await setup(t);
  const draft = await f.drafts.prepare({ text: '@slack:C789 hello', slackDestinationSelectionId: f.selected.selectionId });
  let release;
  const gate = new Promise(resolve => release = resolve);
  const priorChecks = f.authChecks();
  f.setAuthGate(() => gate, 3); // preflight and account callback pass; block inside postPlainText auth.test.
  const sending = f.drafts.execute(draft.draftId, draft.revision);
  while (f.authChecks() < priorChecks + 3) await new Promise(resolve => setTimeout(resolve, 0));
  await f.accountService.disconnect();
  release();
  assert.equal((await sending).status, 'unknown');
  assert.equal(f.posts(), 0);
  const files = await readdir(path.join(f.directory, 'ledger'));
  const outcome = JSON.parse(await readFile(path.join(f.directory, 'ledger', files.find(name => name.endsWith('.outcome'))), 'utf8'));
  assert.equal(outcome.status, 'unknown');
});
