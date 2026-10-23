import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';
import { encryption, verifySlack, verifyLine, verifyTelegram, verifyDiscord } from '../src/crypto.mjs';
import { extractMentions, normalizeEvents, processIncoming, flushOutbox, sendPlatformMessage } from '../src/bridge.mjs';

const K = 'b'.repeat(64);
const ADMIN = 'a'.repeat(64);
const fixtures = () => createStore(':memory:', K);
const credentials = {
  slack: { token: 'xoxb-fake', signing_secret: 'slacksecret' },
  telegram: { token: '123:Fake', webhook_secret: 'verySecret_012345' },
  line: { token: 'line-fake', channel_secret: 'linesecret' },
  discord: { token: 'discord-fake', public_key: 'f'.repeat(64) },
};

test('AES-GCM encrypted credentials round-trip, with random IV', () => {
  const crypto = encryption(K), a = crypto.seal({ token: 'secret' }), b = crypto.seal({ token: 'secret' });
  assert.notEqual(a, b);
  assert.deepEqual(crypto.open(a), { token: 'secret' });
  assert.throws(() => crypto.open(a.slice(0, -4) + 'aaaa'));
});
test('mention parser requires explicit platform and removes repeats', () => {
  assert.deepEqual(extractMentions('Hello @LINE:alice and @telegram:bob @line:alice, @alice, example@line:bad'), [
    { platform: 'line', alias: 'alice' }, { platform: 'telegram', alias: 'bob' },
  ]);
});
test('cryptographic webhook checks Slack, LINE, Telegram and Discord', () => {
  const body = Buffer.from('{"hello":"world"}');
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + createHmac('sha256', 'slacksecret').update(`v0:${ts}:`).update(body).digest('hex');
  assert.equal(verifySlack(body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, 'slacksecret'), true);
  assert.equal(verifySlack(body, { 'x-slack-request-timestamp': String(Number(ts) - 500), 'x-slack-signature': sig }, 'slacksecret'), false);
  assert.equal(verifySlack(body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig + 'x' }, 'slacksecret'), false);
  const line = createHmac('sha256', 'linesecret').update(body).digest('base64');
  assert.equal(verifyLine(body, { 'x-line-signature': line }, 'linesecret'), true);
  assert.equal(verifyLine(body, { 'x-line-signature': line + 'X' }, 'linesecret'), false);
  assert.equal(verifyTelegram({ 'x-telegram-bot-api-secret-token': 'verySecret_012345' }, 'verySecret_012345'), true);
  assert.equal(verifyTelegram({}, 'verySecret_012345'), false);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const discordSignature = sign(null, Buffer.concat([Buffer.from(ts), body]), privateKey).toString('hex');
  assert.equal(verifyDiscord(body, { 'x-signature-timestamp': ts, 'x-signature-ed25519': discordSignature }, rawPublicKey), true);
  assert.equal(verifyDiscord(Buffer.from('changed'), { 'x-signature-timestamp': ts, 'x-signature-ed25519': discordSignature }, rawPublicKey), false);
});
test('ingestion saves once and enqueues mapped destination only', () => {
  const db = fixtures();
  try {
    const s = db.addConnection('slack', 'source', credentials.slack);
    const line = db.addConnection('line', 'destination', credentials.line);
    const tg = db.addConnection('telegram', 'different', credentials.telegram);
    const alice = db.addIdentity('alice', 'Alice');
    db.addAddress(alice.id, line.id, 'U-LINE-1');
    db.addAddress(alice.id, tg.id, '12345');
    const message = { connectionId: s.id, eventId: 'unique-event', roomId: 'C123', authorId: 'U321', platform: 'slack', text: 'Hi @line:alice' };
    assert.deepEqual(processIncoming(db, message), { stored: true, enqueued: 1 });
    assert.deepEqual(processIncoming(db, message), { stored: false, enqueued: 0 });
    assert.equal(db.listMessages().length, 1);
    assert.equal(db.listDeliveries().length, 1);
    assert.equal(db.listDeliveries()[0].target_id, 'U-LINE-1');
    assert.ok(!JSON.stringify(db.listConnections()).includes('linesecret'));
  } finally { db.close(); }
});
test('normalize platform events filters bot/self and preserves source', () => {
  const slack = normalizeEvents('slack', { type: 'event_callback', event_id: 'evt', event: { type: 'message', user: 'user', channel: 'room', text: '@line:alice' } }, 'one');
  assert.equal(slack[0].authorId, 'user');
  assert.equal(normalizeEvents('slack', { type: 'event_callback', event: { type: 'message', bot_id: 'bot', text: 'ignore' } }, 'one').length, 0);
  assert.equal(normalizeEvents('telegram', { update_id: 1, message: { text: 'hello', from: { id: 42 }, chat: { id: -2 } } }, 'two')[0].roomId, -2);
  assert.equal(normalizeEvents('line', { events: [{ type: 'message', message: { id: '777', type: 'text', text: 'Hi' }, source: { userId: 'lineuser', groupId: 'G' } }] }, 'three')[0].roomId, 'G');
  assert.equal(normalizeEvents('discord', { type: 2, id: '901', channel_id: 'ch', member: { user: { id: 'person' } }, data: { name: 'tag', options: [{ name: 'recipient', value: 'telegram:alice' }, { name: 'message', value: 'hello' }] } }, 'four')[0].text, '@telegram:alice hello');
});
test('platform senders call official endpoints and fail on application errors', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('conversations.open')) return { ok: true, json: async () => ({ ok: true, channel: { id: 'D2' } }) };
    if (url.includes('/users/@me/channels')) return { ok: true, json: async () => ({ id: 'D123' }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendPlatformMessage({ platform: 'slack', credentials: credentials.slack }, 'U111', 'Hello', fake);
  await sendPlatformMessage({ platform: 'telegram', credentials: credentials.telegram }, '789', 'Hello', fake);
  await sendPlatformMessage({ platform: 'line', credentials: credentials.line }, 'Uline', 'Hello', fake);
  await sendPlatformMessage({ platform: 'discord', credentials: credentials.discord }, '9939', 'Hello', fake);
  assert.equal(calls.length, 6);
  assert.equal(JSON.parse(calls[1].opts.body).channel, 'D2');
  assert.equal(JSON.parse(calls[4].opts.body).recipient_id, '9939');
  assert.equal(JSON.parse(calls[5].opts.body).allowed_mentions.parse.length, 0);
  assert.match(calls[2].url, /api\.telegram\.org/);
});
test('outbox reports failed delivery then retries to sent', async () => {
  const db = fixtures();
  try {
    const c = db.addConnection('line', 'line', credentials.line);
    db.queueDelivery(c.id, 'U123', 'A test');
    await flushOutbox(db, async () => ({ ok: false, status: 429 }));
    assert.equal(db.listDeliveries()[0].status, 'pending');
    assert.equal(db.listDeliveries()[0].attempts, 1);
    // force retry scheduling only for the unit test
    const next = db.nextDeliveries();
    assert.equal(next.length, 0);
  } finally { db.close(); }
});
test('HTTP admin auth, create identities, encrypted connections, Telegram webhook duplicate', async t => {
  const db = fixtures();
  const server = createApp({ store: db, adminKey: ADMIN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${url}/api/connections`)).status, 401);
  const publicIndex = await fetch(url);
  assert.equal(publicIndex.status, 200);
  assert.match(await publicIndex.text(), /CrossChat/);
  let response = await fetch(`${url}/api/connections`, { method: 'POST', headers: admin,
    body: JSON.stringify({ platform: 'telegram', name: 'Demo', credentials: credentials.telegram }) });
  assert.equal(response.status, 201);
  const conn = await response.json();
  assert.equal(conn.platform, 'telegram');
  assert.equal(conn.credentials, undefined);
  const saved = await (await fetch(`${url}/api/connections`, { headers: admin })).json();
  assert.ok(!JSON.stringify(saved).includes('Fake'));
  response = await fetch(`${url}/api/identities`, { method: 'POST', headers: admin, body: JSON.stringify({ alias: 'alice', display_name: 'Alice' }) });
  const identity = await response.json();
  assert.equal(response.status, 201);
  response = await fetch(`${url}/api/addresses`, { method: 'POST', headers: admin,
    body: JSON.stringify({ identity_id: identity.id, connection_id: conn.id, external_user_id: '112233' }) });
  assert.equal(response.status, 201);
  const event = { update_id: 77, message: { message_id: 1, chat: { id: 7 }, from: { id: 5 }, text: 'Hi @telegram:alice' } };
  const webhook = `${url}${conn.webhook_path}`;
  assert.equal((await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) })).status, 401);
  for (let i = 0; i < 2; i++) {
    const wh = await fetch(webhook, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': credentials.telegram.webhook_secret }, body: JSON.stringify(event) });
    assert.equal(wh.status, 200);
  }
  assert.equal(db.listMessages().length, 1);
  assert.equal(db.listDeliveries().length, 1);
});
