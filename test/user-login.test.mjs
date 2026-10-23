import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../src/store.mjs';
import { createOAuthManager } from '../src/oauth.mjs';
import { createApp } from '../src/app.mjs';

const KEY = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);
const settings = {
  OAUTH_CALLBACK_BASE_URL: 'https://login.example.test',
  LINE_CLIENT_ID: '12345', LINE_CLIENT_SECRET: 'line-secret',
  SLACK_CLIENT_ID: '1111', SLACK_CLIENT_SECRET: 'slack-secret',
  DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'discord-secret',
};

const openStore = () => createStore(':memory:', KEY);
test('LINE Login verifies profile with provider; OAuth credentials are never stored or granted chat rights', async () => {
  const store = openStore();
  try {
    const calls = [];
    const oauth = createOAuthManager({ store, env: settings, fetchFn: async (url, opts) => {
      calls.push([url,opts]);
      return { ok: true, json: async () => url.endsWith('/token')
        ? { access_token: 'PRIVATE_LINE_ACCESS_TOKEN' }
        : { userId: `U${'1'.repeat(32)}`, displayName: 'Alice' } };
    } });
    const url = new URL(oauth.begin('line'));
    assert.equal(url.hostname, 'access.line.me');
    assert.equal(url.searchParams.get('scope'), 'profile openid');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://login.example.test/oauth/line/callback');
    await assert.rejects(oauth.complete('line', { code: 'foo', state: 'untrusted' }), /state/);
    const first = await oauth.complete('line', { code: 'correct', state: url.searchParams.get('state') });
    assert.equal(first.account.display_name, 'Alice');
    assert.equal(store.listConnections().length, 0); // identity ≠ chat session
    assert.equal(store.listVerifiedAccounts().length, 1);
    assert.equal(JSON.stringify(store.listVerifiedAccounts()).includes('PRIVATE_LINE_ACCESS_TOKEN'), false);
    assert.equal(calls[1][1].headers.authorization, 'Bearer PRIVATE_LINE_ACCESS_TOKEN');
    const repeat = new URL(oauth.begin('line'));
    await oauth.complete('line', { code: 'different', state: repeat.searchParams.get('state') });
    assert.equal(store.listVerifiedAccounts().length, 1);
  } finally { store.close(); }
});

test('Discord user login does not require a bot connection or gain chat access', async () => {
  const store = openStore();
  try {
    const oauth = createOAuthManager({ store, env: settings, fetchFn: async url => ({
      ok: true, json: async () => url.endsWith('/token')
        ? { access_token: 'PRIVATE_DISCORD_TOKEN', token_type: 'Bearer' }
        : { id: '123456789012345678', username: 'jane' },
    }) });
    const authURL = new URL(oauth.begin('discord'));
    assert.equal(authURL.searchParams.get('scope'), 'identify');
    const result = await oauth.complete('discord', { code: 'success', state: authURL.searchParams.get('state') });
    assert.equal(result.account.external_user_id, '123456789012345678');
    assert.equal(store.listConnections().length, 0);
    assert.equal(store.listAddresses().length, 0);
    assert.equal(JSON.stringify(store.listVerifiedAccounts()).includes('PRIVATE_DISCORD_TOKEN'), false);
  } finally { store.close(); }
});

test('Slack user OAuth grants an encrypted user connection instead of requiring manual bot token', async () => {
  const store = openStore();
  try {
    const oauth = createOAuthManager({ store, env: settings, fetchFn: async () => ({ ok: true, json: async () => ({
      ok: true, team: { id: 'T123', name: 'Engineering' },
      authed_user: { id: 'U123', access_token: 'PRIVATE_SLACK_USER_TOKEN' },
    }) }) });
    const url = new URL(oauth.begin('slack', { mode: 'user' }));
    assert.ok(url.searchParams.has('user_scope'));
    assert.equal(url.searchParams.has('scope'), false);
    const result = await oauth.complete('slack', { state: url.searchParams.get('state'), code: 'ok' });
    assert.equal(store.getConnection(result.connection.id).credentials.kind, 'user');
    assert.equal(store.getConnection(result.connection.id).credentials.token, 'PRIVATE_SLACK_USER_TOKEN');
    assert.ok(!JSON.stringify(store.listConnections()).includes('PRIVATE_SLACK_USER_TOKEN'));
    assert.equal(store.listVerifiedAccounts()[0].external_user_id, 'U123');
  } finally { store.close(); }
});

test('HTTP login providers and homepage keep sensitive fields outside the primary user onboarding', async t => {
  const store = openStore();
  const oauth = createOAuthManager({ store, env: settings, fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  const app = createApp({ store, oauth, adminKey: ADMIN });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const html = await (await fetch(base)).text();
  assert.match(html, /登入你的聊天帳號/);
  assert.match(html, /<details class="advanced"/);
  assert.match(html, /data-login="line"/);
  assert.equal((await fetch(`${base}/api/oauth/config`)).status, 401);
  const headers = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
  const flags = await (await fetch(`${base}/api/oauth/config`, { headers })).json();
  assert.deepEqual(flags, { slack: true, discord: true, line: true });
  const start = await fetch(`${base}/api/oauth/line/start`, { method: 'POST', headers, body: '{}' });
  assert.equal(start.status, 200);
  assert.equal(new URL((await start.json()).url).hostname, 'access.line.me');
});

test('Slack user chat endpoints enforce authorization and only use an OAuth user connection', async t => {
  const store = openStore();
  const user = store.addConnection('slack', 'my Slack', { token: 'user-oauth-secret', kind: 'user' });
  const bot = store.addConnection('slack', 'service bot', { token: 'bot-secret', signing_secret: 'secret' });
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.authorization, 'Bearer user-oauth-secret');
    if (url.includes('conversations.list')) return { ok: true, json: async () => ({ ok: true, channels: [ { id: 'C123456', name: 'general' } ] }) };
    if (url.includes('conversations.history')) return { ok: true, json: async () => ({ ok: true, messages: [ { ts: '171.2', user: 'U42', text: 'hello' } ] }) };
    return { ok: true, json: async () => ({ ok: true, ts: '171.3' }) };
  };
  const server = createApp({ store, adminKey: ADMIN, fetchFn: mockFetch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/user/slack/rooms?connection_id=${user.id}`)).status, 401);
  assert.equal((await fetch(`${base}/api/user/slack/rooms?connection_id=${bot.id}`, { headers })).status, 404);
  const rooms = await (await fetch(`${base}/api/user/slack/rooms?connection_id=${user.id}`, { headers })).json();
  assert.deepEqual(rooms.rooms.map(x => x.name), ['general']);
  assert.equal((await fetch(`${base}/api/user/slack/messages?connection_id=${user.id}&channel=bad!`, { headers })).status, 400);
  const messages = await (await fetch(`${base}/api/user/slack/messages?connection_id=${user.id}&channel=C123456`, { headers })).json();
  assert.equal(messages.messages[0].text, 'hello');
  const response = await fetch(`${base}/api/user/slack/messages`, { method: 'POST', headers,
    body: JSON.stringify({ connection_id: user.id, channel: 'C123456', text: 'Hi' }) });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[2].options.body).channel, 'C123456');
  assert.equal(JSON.parse(calls[2].options.body).text, 'Hi');
});
