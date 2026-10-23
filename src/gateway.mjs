import { normalizeDiscordGatewayMessage, processIncoming } from './bridge.mjs';

const GUILDS = 1 << 0;
const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 12;
const MESSAGE_CONTENT = 1 << 15; // Privileged: explicitly enabled in Discord Developer Portal.
const isValidGateway = value => {
  try { const u = new URL(value); return u.protocol === 'wss:' && (u.hostname === 'gateway.discord.gg' || /^gateway-[a-z0-9-]+\.discord\.gg$/.test(u.hostname)) && (!u.port || u.port === '443'); }
  catch { return false; }
};

// Connection-per-bot Gateway v10 client: heartbeats, ACK watchdog, resume,
// reconnect backoff, message deduplication, and bot/webhook message filtering.
export class DiscordGatewayManager {
  constructor({ store, fetchFn = fetch, WebSocketClass = globalThis.WebSocket, onError = console.error }) {
    this.store = store; this.fetchFn = fetchFn; this.WebSocketClass = WebSocketClass;
    this.onError = onError; this.sessions = new Map(); this.stopped = false;
  }
  sync() {
    if (this.stopped) return;
    const connections = this.store.listConnections().filter(c => c.platform === 'discord');
    const enabled = new Set();
    for (const row of connections) {
      const conn = this.store.getConnection(row.id);
      if (!conn.credentials.gateway_enabled) continue;
      enabled.add(conn.id);
      if (!this.sessions.has(conn.id)) {
        const session = { connectionId: conn.id, seq: null, sessionId: null, resumeUrl: null, reconnectCount: 0,
          closing: false, ack: true, socket: null, heartbeat: null, timer: null, botId: null };
        this.sessions.set(conn.id, session);
        this.connect(session).catch(e => this.retry(session, e));
      }
    }
    for (const [id, session] of this.sessions) if (!enabled.has(id)) this.dispose(session);
  }
  async connect(s) {
    if (this.stopped || s.closing) return;
    const conn = this.store.getConnection(s.connectionId);
    if (!conn?.credentials.gateway_enabled) return this.dispose(s);
    let url = s.resumeUrl;
    if (!url) {
      const reply = await this.fetchFn('https://discord.com/api/v10/gateway/bot', {
        headers: { authorization: `Bot ${conn.credentials.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!reply.ok) throw new Error(`Discord gateway discovery HTTP ${reply.status}`);
      url = (await reply.json()).url;
    }
    if (!isValidGateway(url)) throw new Error('Discord gateway returned an untrusted URL');
    const target = new URL(url);
    target.searchParams.set('v', '10');
    target.searchParams.set('encoding', 'json');
    s.socket = new this.WebSocketClass(target.href);
    s.ack = true;
    const thisSocket = s.socket;
    thisSocket.addEventListener('message', event => {
      if (this.stopped || s.closing || s.socket !== thisSocket) return;
      try { this.handlePacket(s, JSON.parse(String(event.data)), conn.credentials); }
      catch (e) { this.onError('Gateway packet', e.message); }
    });
    thisSocket.addEventListener('close', event => {
      if (this.stopped || s.closing || s.socket !== thisSocket) return;
      // 4004 invalid token, 4013 invalid intents, 4014 disallowed privileged intents
      if ([4004, 4013, 4014].includes(event.code)) return this.dispose(s, `Discord Gateway closed: ${event.code}`);
      if ([4007, 4009].includes(event.code)) { s.sessionId = null; s.seq = null; s.resumeUrl = null; }
      this.retry(s, new Error(`Gateway closed: ${event.code}`));
    });
    thisSocket.addEventListener('error', () => { /* close event triggers recovery */ });
  }
  send(s, op, d) {
    if (s.socket?.readyState === 1) s.socket.send(JSON.stringify({ op, d }));
  }
  handlePacket(s, p, creds) {
    if (p.s != null) s.seq = p.s;
    if (p.op === 10) {
      clearInterval(s.heartbeat);
      const ms = p.d?.heartbeat_interval;
      if (!Number.isFinite(ms) || ms < 1000) throw new Error('Bad gateway heartbeat interval');
      s.ack = true;
      s.heartbeat = setInterval(() => {
        if (!s.ack) { this.retry(s, new Error('Discord heartbeat ACK timeout')); return; }
        s.ack = false;
        this.send(s, 1, s.seq);
      }, ms);
      if (s.sessionId && s.seq != null) this.send(s, 6, { token: creds.token, session_id: s.sessionId, seq: s.seq });
      else this.send(s, 2, {
        token: creds.token, intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | (creds.message_content_intent ? MESSAGE_CONTENT : 0),
        properties: { os: process.platform, browser: 'crosschat-hub', device: 'crosschat-hub' },
      });
    } else if (p.op === 11) s.ack = true;
    else if (p.op === 1) this.send(s, 1, s.seq);
    else if (p.op === 7) this.retry(s, new Error('Gateway RECONNECT'));
    else if (p.op === 9) {
      if (!p.d) { s.sessionId = null; s.seq = null; s.resumeUrl = null; }
      this.retry(s, new Error('INVALID_SESSION'));
    } else if (p.op === 0) {
      if (p.t === 'READY') {
        s.sessionId = p.d.session_id;
        s.resumeUrl = isValidGateway(p.d.resume_gateway_url) ? p.d.resume_gateway_url : null;
        s.botId = p.d.user?.id;
        s.reconnectCount = 0;
      }
      if (p.t === 'MESSAGE_CREATE' && p.d?.author?.id !== s.botId) {
        const msg = normalizeDiscordGatewayMessage(s.connectionId, p.d);
        if (msg) processIncoming(this.store, msg);
      }
    }
  }
  retry(s, error) {
    if (this.stopped || s.closing) return;
    clearInterval(s.heartbeat); s.heartbeat = null;
    clearTimeout(s.timer);
    const socket = s.socket; s.socket = null;
    try { socket?.close(); } catch { /* ignored */ }
    const delay = Math.min(60000, 1000 * 2 ** Math.min(6, s.reconnectCount++));
    s.timer = setTimeout(() => this.connect(s).catch(e => this.retry(s, e)), delay);
    this.onError('Discord Gateway reconnect', s.connectionId, error.message);
  }
  dispose(s, reason) {
    s.closing = true; clearInterval(s.heartbeat); clearTimeout(s.timer);
    try { s.socket?.close(); } catch { /* ignored */ }
    this.sessions.delete(s.connectionId);
    if (reason) this.onError(reason);
  }
  stop() { this.stopped = true; for (const s of [...this.sessions.values()]) this.dispose(s); }
  status() { return [...this.sessions.values()].map(s => ({ connection_id: s.connectionId, connected: s.socket?.readyState === 1, session_ready: !!s.sessionId })); }
}
