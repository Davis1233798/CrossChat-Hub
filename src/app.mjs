import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { equal, verifySlack, verifyTelegram, verifyLine, verifyDiscord } from './crypto.mjs';
import { PLATFORMS, normalizeEvents, processIncoming } from './bridge.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '../public');
const MAX_BODY = 131072;
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const problem = (code, message) => Object.assign(new Error(message), { status: code });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validText = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const validSlackChannel = v => typeof v === 'string' && /^[A-Z0-9]{3,32}$/.test(v);

async function slackRequest(connection, method, params, fetchFn) {
  const url = new URL(`https://slack.com/api/${method}`);
  const isPost = method === 'chat.postMessage';
  if (!isPost) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const response = await fetchFn(url.toString(), { method: isPost ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${connection.credentials.token}`, ...(isPost ? { 'content-type': 'application/json' } : {}) },
    ...(isPost ? { body: JSON.stringify(params) } : {}),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw problem(502, `Slack HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw problem(502, `Slack API: ${String(result.error ?? 'failed').slice(0, 80)}`);
  return result;
}

async function readBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw problem(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function decodeJson(raw) {
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw problem(400, 'Invalid JSON'); }
}
function cleanCredentials(platform, obj) {
  if (!obj || typeof obj !== 'object') throw problem(400, 'Missing credentials');
  const token = obj.token;
  if (!validText(token, 512)) throw problem(400, 'Missing bot token');
  if (platform === 'slack' && !validText(obj.signing_secret, 256)) throw problem(400, 'Slack signing_secret is required');
  if (platform === 'telegram' && !(typeof obj.webhook_secret === 'string' && /^[a-zA-Z0-9_-]{16,256}$/.test(obj.webhook_secret))) throw problem(400, 'Telegram webhook_secret must be 16-256 URL-safe characters');
  if (platform === 'line' && !validText(obj.channel_secret, 256)) throw problem(400, 'LINE channel_secret is required');
  if (platform === 'discord' && !/^[0-9a-f]{64}$/i.test(obj.public_key ?? '')) throw problem(400, 'Discord public_key must be 64 hex characters');
  return {
    token,
    ...(platform === 'slack' ? { signing_secret: obj.signing_secret } : {}),
    ...(platform === 'telegram' ? { webhook_secret: obj.webhook_secret } : {}),
    ...(platform === 'line' ? { channel_secret: obj.channel_secret } : {}),
    ...(platform === 'discord' ? { public_key: obj.public_key, gateway_enabled: obj.gateway_enabled === true, message_content_intent: obj.message_content_intent === true } : {}),
  };
}

export function createApp({ store, adminKey, oauth = null, gateway = null, demo = null, telegramUser = null, fetchFn = fetch }) {
  if (!/^[a-f0-9]{64}$/i.test(adminKey ?? '')) throw new Error('ADMIN_API_KEY must be a 32-byte hex string');
  const handle = async (req, res) => {
    Object.entries(securityHeaders).forEach(([k, v]) => res.setHeader(k, v));
    const respond = (code, value) => { res.writeHead(code, jsonHeaders); res.end(JSON.stringify(value)); };
    try {
      const requestURL = new URL(req.url, 'http://localhost');
      const path = requestURL.pathname;
      const method = req.method;
      if (method === 'GET' && (path === '/' || path === '/index.html' || path === '/app.js' || path === '/style.css')) {
        const filename = path === '/' ? 'index.html' : path.slice(1);
        res.writeHead(200, { 'content-type': filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(readFileSync(join(WEB, filename)));
        return;
      }
      if (method === 'GET' && path === '/healthz') return respond(200, { ok: true });
      const webhook = path.match(/^\/webhooks\/(slack|telegram|line|discord)\/([a-zA-Z0-9_-]{1,128})$/);
      if (method === 'POST' && webhook) {
        const [, platform, connectionId] = webhook;
        const connection = store.getConnection(connectionId);
        if (!connection || connection.platform !== platform) throw problem(404, 'Connection not found');
        const raw = await readBody(req);
        const c = connection.credentials;
        const authenticated = platform === 'slack' ? verifySlack(raw, req.headers, c.signing_secret)
          : platform === 'telegram' ? verifyTelegram(req.headers, c.webhook_secret)
          : platform === 'line' ? verifyLine(raw, req.headers, c.channel_secret)
          : verifyDiscord(raw, req.headers, c.public_key);
        if (!authenticated) throw problem(401, 'Invalid webhook signature');
        const body = decodeJson(raw);
        if (platform === 'slack' && body.type === 'url_verification') return respond(200, { challenge: body.challenge });
        if (platform === 'discord' && body.type === 1) return respond(200, { type: 1 });
        let enqueued = 0;
        for (const event of normalizeEvents(platform, body, connectionId)) {
          enqueued += processIncoming(store, event).enqueued;
        }
        // Discord interactions require a prompt acknowledgment; sending is queued, not guaranteed.
        if (platform === 'discord') return respond(200, { type: 4, data: { content: enqueued ? `CrossChat queued ${enqueued} notification(s).` : 'No mapped recipient found; nothing was queued.', flags: 64 } });
        return respond(200, { ok: true });
      }

      const oauthCallback = path.match(/^\/oauth\/(slack|discord|line)\/callback$/);
      if (method === 'GET' && oauthCallback && oauth) {
        try {
          await oauth.complete(oauthCallback[1], Object.fromEntries(requestURL.searchParams));
          res.writeHead(302, { location: '/?oauth=success', 'cache-control': 'no-store' }); res.end();
        } catch (e) {
          res.writeHead(302, { location: '/?oauth=error', 'cache-control': 'no-store' }); res.end();
        }
        return;
      }
      if (!path.startsWith('/api/')) throw problem(404, 'Not found');
      if (!equal(req.headers.authorization, `Bearer ${adminKey}`)) throw problem(401, 'Invalid admin credential');
      if (path === '/api/demo/state' && method === 'GET') return respond(200, { available: demo?.enabled ?? false, active: demo?.enabled && store.demoEnabled() || false });
      if (path === '/api/demo/login' && method === 'POST') {
        if (!demo) throw problem(404, 'Demo disabled');
        return respond(200, demo.login());
      }
      if (path === '/api/demo/rooms' && method === 'GET') return respond(200, demo?.rooms() ?? []);
      if (path === '/api/demo/messages' && method === 'GET') return respond(200, demo?.messages(requestURL.searchParams.get('room')) ?? []);
      if (path === '/api/demo/messages' && method === 'POST') {
        if (!demo) throw problem(404, 'Demo disabled');
        const input = decodeJson(await readBody(req));
        return respond(201, demo.send(input.room, input.text));
      }
      if (path === '/api/user/telegram/config' && method === 'GET') return respond(200, { ready: telegramUser?.configured() ?? false });
      if (path === '/api/user/telegram/start' && method === 'POST') {
        if (!telegramUser) throw problem(503, 'Telegram unavailable');
        const input = decodeJson(await readBody(req));
        return respond(200, await telegramUser.begin(input.phone));
      }
      if (path === '/api/user/telegram/complete' && method === 'POST') {
        if (!telegramUser) throw problem(503, 'Telegram unavailable');
        const input = decodeJson(await readBody(req));
        return respond(200, await telegramUser.complete(input.login_id,input.code,input.password));
      }
      if (path === '/api/user/telegram/rooms' && method === 'GET') return respond(200, { rooms: await telegramUser.withSession(requestURL.searchParams.get('connection_id'), 'rooms') });
      if (path === '/api/user/telegram/messages' && method === 'GET') return respond(200, { messages: await telegramUser.withSession(requestURL.searchParams.get('connection_id'), 'messages', requestURL.searchParams.get('room')) });
      if (path === '/api/user/telegram/messages' && method === 'POST') {
        const input = decodeJson(await readBody(req));
        if (!validText(input.text,3500)) throw problem(400,'Invalid text');
        return respond(200, { message: await telegramUser.withSession(input.connection_id, 'send', input.room, input.text) });
      }
      const slackAccount = path === '/api/user/slack/rooms' || path === '/api/user/slack/messages';
      if (slackAccount) {
        const payload = method === 'POST' ? decodeJson(await readBody(req)) : Object.fromEntries(requestURL.searchParams);
        const conn = store.getConnection(payload.connection_id);
        if (!conn || conn.platform !== 'slack' || conn.credentials.kind !== 'user') throw problem(404, 'Authorized Slack user account not found');
        const account = oauth ? await oauth.refreshSlack(conn) : conn;
        if (path.endsWith('/rooms') && method === 'GET') {
          const result = await slackRequest(account, 'conversations.list', {
            types: 'public_channel,private_channel,im,mpim', limit: '200', exclude_archived: 'true',
          }, fetchFn);
          return respond(200, { rooms: (result.channels ?? []).map(c => ({ id: c.id, name: c.name ?? c.user ?? c.id,
            is_private: Boolean(c.is_private), is_im: Boolean(c.is_im), unread_count: c.unread_count ?? 0 })) });
        }
        if (!validSlackChannel(payload.channel)) throw problem(400, 'Invalid Slack channel ID');
        if (method === 'GET') {
          const result = await slackRequest(account, 'conversations.history', { channel: payload.channel, limit: 50 }, fetchFn);
          return respond(200, { messages: (result.messages ?? []).map(m => ({ ts: m.ts, user: m.user ?? 'Unknown', text: m.text ?? '' })) });
        }
        if (method === 'POST') {
          if (!validText(payload.text, 3500)) throw problem(400, 'Message text is required');
          const result = await slackRequest(account, 'chat.postMessage', { channel: payload.channel, text: payload.text, unfurl_links: false }, fetchFn);
          return respond(200, { ok: true, ts: result.ts });
        }
        throw problem(405, 'Unsupported method');
      }
      if (method === 'GET') {
        if (path === '/api/connections') return respond(200, store.listConnections());
        if (path === '/api/identities') return respond(200, store.listIdentities());
        if (path === '/api/addresses') return respond(200, store.listAddresses());
        if (path === '/api/messages') return respond(200, store.listMessages());
        if (path === '/api/deliveries') return respond(200, store.listDeliveries());
        if (path === '/api/bridge-rules') return respond(200, store.listBridgeRules());
        if (path === '/api/verified-accounts') return respond(200, store.listVerifiedAccounts());
        if (path === '/api/gateway') return respond(200, gateway?.status() ?? []);
        if (path === '/api/oauth/config') return respond(200, { slack: oauth?.configured('slack') ?? false, discord: oauth?.configured('discord') ?? false, line: oauth?.configured('line') ?? false });
        if (path === '/api/oauth/discord/install' && oauth) { try { return respond(200, { url: oauth.discordInstallUrl() }); } catch { throw problem(400, 'Discord application is not configured'); } }
      }
      if (method === 'DELETE') {
        const del = path.match(/^\/api\/bridge-rules\/([a-zA-Z0-9_-]{1,128})$/);
        if (del) return respond(store.removeBridgeRule(del[1]) ? 200 : 404, { ok: true });
      }
      if (method !== 'POST') throw problem(404, 'Not found');
      const data = decodeJson(await readBody(req));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw problem(400, 'Expected object');
      if (path === '/api/connections') {
        if (!PLATFORMS.includes(data.platform) || !validText(data.name, 80)) throw problem(400, 'Invalid platform/name');
        const created = store.addConnection(data.platform, data.name, cleanCredentials(data.platform, data.credentials));
        gateway?.sync();
        return respond(201, created);
      }
      if (path === '/api/identities') {
        if (!/^[a-z][a-z0-9_.-]{1,31}$/.test(data.alias ?? '') || !validText(data.display_name, 80)) throw problem(400, 'Invalid alias/display_name');
        return respond(201, store.addIdentity(data.alias, data.display_name));
      }
      if (path === '/api/addresses') {
        if (!validId(data.identity_id) || !validId(data.connection_id) || !validText(data.external_user_id, 128)) throw problem(400, 'Invalid identity/connection/external_user_id');
        if (!store.getConnection(data.connection_id) || !store.listIdentities().some(i => i.id === data.identity_id)) throw problem(400, 'Identity or connection does not exist');
        return respond(201, store.addAddress(data.identity_id, data.connection_id, data.external_user_id));
      }
      if (path === '/api/bridge-rules') {
        if (![data.source_connection_id,data.target_connection_id].every(validId) ||
            !validText(data.source_room_id,128) || !validText(data.target_room_id,128)) throw problem(400, 'Invalid bridge rule');
        if (!store.getConnection(data.source_connection_id) || !store.getConnection(data.target_connection_id)) throw problem(400, 'Unknown connection');
        if (data.source_connection_id === data.target_connection_id && data.source_room_id === data.target_room_id) throw problem(400, 'A room cannot be bridged to itself');
        return respond(201, store.addBridgeRule(data.source_connection_id, data.source_room_id, data.target_connection_id, data.target_room_id));
      }
      if (path === '/api/oauth/slack/start' || path === '/api/oauth/discord/start' || path === '/api/oauth/line/start') {
        if (!oauth) throw problem(503, 'OAuth is unavailable');
        const provider = path.split('/')[3];
        try { return respond(200, { url: oauth.begin(provider, data) }); }
        catch { throw problem(400, 'OAuth is not configured or inputs invalid'); }
      }
      if (path === '/api/send') {
        if (!/^(slack|telegram|line|discord):[a-z][a-z0-9_.-]{1,31}$/.test(data.recipient ?? '') || !validText(data.text, 3500)) throw problem(400, 'Use recipient platform:alias and nonempty text');
        const [platform, alias] = data.recipient.split(':');
        const addresses = store.findAddresses(alias, platform);
        if (!addresses.length) throw problem(404, 'Recipient has no mapped connection on this platform');
        for (const addr of addresses) store.queueDelivery(addr.connection_id, addr.external_user_id, `[CrossChat | admin]\n${data.text}`, null, addr.id);
        return respond(202, { queued: addresses.length });
      }
      throw problem(404, 'Not found');
    } catch (err) {
      let status = err.status ?? 500;
      if (/^UNIQUE constraint failed/.test(err.message)) { status = 409; }
      if (/^FOREIGN KEY constraint failed/.test(err.message)) { status = 400; }
      // Do not expose tokens, stack traces or upstream auth details to clients.
      respond(status, { error: status === 500 ? 'Internal server error' : err.status ? err.message : status === 409 ? 'Duplicate resource' : 'Invalid reference' });
    }
  };
  return createServer(handle);
}
