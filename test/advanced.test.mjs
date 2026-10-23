import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { createOAuthManager } from '../src/oauth.mjs';
import { createApp } from '../src/app.mjs';
import { normalizeDiscordGatewayMessage, processIncoming, flushOutbox } from '../src/bridge.mjs';
import { DiscordGatewayManager } from '../src/gateway.mjs';

const K = 'f'.repeat(64), ADMIN = '1'.repeat(64);
const database = () => createStore(':memory:', K);
const token = { token: 'test', webhook_secret: 'secretSecretValue123' };
const slackCredentials = { token: 'xoxb-demo', signing_secret: 'signature' };
const discordCreds = { token: 'discord-test', public_key: 'a'.repeat(64), gateway_enabled: true, message_content_intent: true };

test('bidirectional bridge rules only forward subscribed rooms, ignore webhook duplicate and self-loops', () => {
  const db = database();
  try {
    const a = db.addConnection('telegram', 'A', token);
    const b = db.addConnection('slack', 'B', slackCredentials);
    db.addBridgeRule(a.id, '-100', b.id, 'C123');
    db.addBridgeRule(b.id, 'C123', a.id, '-100');
    assert.equal(db.listBridgeRules().length, 2);
    assert.deepEqual(processIncoming(db, { connectionId: a.id, platform: 'telegram', eventId: 'evt1', roomId: '-100', authorId: 'human', text: 'hello' }), { stored: true, enqueued: 1 });
    assert.equal(db.nextDeliveries()[0].target_kind, 'room');
    assert.equal(db.nextDeliveries()[0].target_id, 'C123');
    assert.equal(processIncoming(db, { connectionId: a.id, platform: 'telegram', eventId: 'evt1', roomId: '-100', authorId: 'human', text: 'hello' }).enqueued, 0);
    assert.equal(processIncoming(db, { connectionId: b.id, platform: 'slack', eventId: 'evt2', roomId: 'C123', authorId: 'other', text: 'reply' }).enqueued, 1);
    assert.equal(processIncoming(db, { connectionId: b.id, platform: 'slack', eventId: 'evt3', roomId: 'C999', authorId: 'other', text: 'private' }).enqueued, 0);
    assert.equal(db.listDeliveries().length, 2);
    assert.equal(db.removeBridgeRule(db.listBridgeRules()[0].id), true);
  } finally { db.close(); }
});

test('Slack OAuth installation requires state, exchanges code, and persists encrypted bot token', async () => {
  const db = database();
  try {
    const calls = [];
    const oauth = createOAuthManager({ store: db, env: {
      OAUTH_CALLBACK_BASE_URL: 'https://auth.example.com', SLACK_CLIENT_ID: '111', SLACK_CLIENT_SECRET: 'secret',
      SLACK_SIGNING_SECRET: 'signingSecret',
    }, fetchFn: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, access_token: 'xoxb-real-secret', team: { id: 'T1', name: 'Team one' } }) };
    } });
    const url = new URL(oauth.begin('slack', { name: 'Workspace 1' }));
    assert.equal(url.hostname, 'slack.com');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://auth.example.com/oauth/slack/callback');
    const state = url.searchParams.get('state');
    await assert.rejects(oauth.complete('slack', { state: 'tampered', code: 'abc' }), /state/);
    const result = await oauth.complete('slack', { state, code: 'correct' });
    assert.equal(result.connection.name, 'Workspace 1');
    assert.equal(db.getConnection(result.connection.id).credentials.token, 'xoxb-real-secret');
    assert.ok(!JSON.stringify(db.listConnections()).includes('xoxb-real-secret'));
    assert.equal(calls[0].options.body.get('code'), 'correct');
    await assert.rejects(oauth.complete('slack', { state, code: 'replay' }), /state/);
  } finally { db.close(); }
});

test('Discord OAuth verifies user, links only selected Discord bot identity and discards user token', async () => {
  const db = database();
  try {
    const bot = db.addConnection('discord', 'discord', discordCreds);
    const identity = db.addIdentity('alice', 'Alice');
    const oauth = createOAuthManager({ store: db, env: {
      OAUTH_CALLBACK_BASE_URL: 'https://example.com', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'secret',
    }, fetchFn: async url => ({ ok: true, json: async () => url.endsWith('/token') ?
      { access_token: 'PRIVATE_USER_TOKEN', token_type: 'Bearer' } : { id: '123456789012345678', username: 'alice' } }) });
    const url = new URL(oauth.begin('discord', { identity_id: identity.id, connection_id: bot.id }));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const result = await oauth.complete('discord', { state: url.searchParams.get('state'), code: 'ok' });
    assert.equal(result.account.external_user_id, '123456789012345678');
    assert.equal(db.listAddresses()[0].verified_at != null, true);
    assert.ok(!JSON.stringify(db.listVerifiedAccounts()).includes('PRIVATE_USER_TOKEN'));
    assert.equal(new URL(oauth.discordInstallUrl()).searchParams.get('scope'), 'bot applications.commands');
  } finally { db.close(); }
});

test('Discord Gateway READY/MESSAGE_CREATE ingests with content intent and ignores bot messages', async () => {
  const db = database();
  try {
    const bot = db.addConnection('discord', 'gateway', discordCreds);
    const tg = db.addConnection('telegram', 'dest', token);
    db.addBridgeRule(bot.id, 'channel1', tg.id, '-100');
    const sockets = [];
    class FakeSocket {
      constructor(url) { this.url = url; this.readyState = 1; this.listeners = {}; this.sent = []; sockets.push(this); }
      addEventListener(name, fn) { this.listeners[name] = fn; }
      send(payload) { this.sent.push(JSON.parse(payload)); }
      close() { this.readyState = 3; }
      emit(message) { this.listeners.message({ data: JSON.stringify(message) }); }
    }
    const manager = new DiscordGatewayManager({ store: db, WebSocketClass: FakeSocket,
      fetchFn: async () => ({ ok: true, json: async () => ({ url: 'wss://gateway.discord.gg/' }) }), onError() {} });
    manager.sync();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sockets.length, 1);
    const ws = sockets[0];
    ws.emit({ op: 10, d: { heartbeat_interval: 10000 } });
    assert.equal(ws.sent[0].op, 2);
    assert.equal(ws.sent[0].d.intents & (1 << 15), 1 << 15);
    ws.emit({ op: 0, t: 'READY', s: 1, d: { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg', user: { id: 'bot' } } });
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm1', channel_id: 'channel1', author: { id: 'human' }, content: 'hello' } });
    ws.emit({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: 'm2', channel_id: 'channel1', author: { id: 'bot', bot: true }, content: 'loop' } });
    assert.equal(db.listMessages().length, 1);
    assert.equal(db.listDeliveries().length, 1);
    assert.equal(normalizeDiscordGatewayMessage(bot.id, { id: 'm', channel_id: 'c', author: { id: 'bot', bot: true }, content: 'outgoing' }), null);
    manager.stop();
    assert.equal(manager.status().length, 0);
  } finally { db.close(); }
});

test('HTTP admin bridge rule management is authenticated and available to the dashboard', async t => {
  const db = database();
  const app = createApp({ store: db, adminKey: ADMIN });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
  const a = db.addConnection('telegram', 'source', token), b = db.addConnection('slack', 'dest', slackCredentials);
  const payload = { source_connection_id: a.id, source_room_id: 'source-room', target_connection_id: b.id, target_room_id: 'dest-room' };
  assert.equal((await fetch(`${base}/api/bridge-rules`)).status, 401);
  assert.equal((await fetch(`${base}/api/bridge-rules`, { method: 'POST', headers, body: JSON.stringify(payload) })).status, 201);
  assert.equal((await (await fetch(`${base}/api/bridge-rules`, { headers })).json()).length, 1);
  assert.equal((await fetch(`${base}/api/bridge-rules`, { method: 'POST', headers, body: JSON.stringify(payload) })).status, 409);
  assert.equal((await fetch(`${base}/api/bridge-rules`, { method: 'POST', headers, body: JSON.stringify({ ...payload, target_connection_id: a.id, target_room_id: 'source-room' }) })).status, 400);
});

test('room bridge uses channel delivery rather than DM', async () => {
  const db = database();
  try {
    const a = db.addConnection('telegram', 'source', token);
    const b = db.addConnection('slack', 'dest', slackCredentials);
    db.addBridgeRule(a.id, '11', b.id, 'C99');
    processIncoming(db, { connectionId: a.id, platform: 'telegram', eventId: 'e1', roomId: '11', authorId: '99', text: 'ping' });
    const urls = [];
    const result = await flushOutbox(db, async (url, options) => {
      urls.push(url);
      assert.equal(JSON.parse(options.body).channel, 'C99');
      return { ok: true, json: async () => ({ ok: true }) };
    });
    assert.deepEqual(result, { sent: 1, failed: 0 });
    assert.equal(urls.length, 1); // must not call conversations.open for a room target
  } finally { db.close(); }
});
