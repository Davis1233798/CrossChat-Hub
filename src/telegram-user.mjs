import { randomUUID } from 'node:crypto';

// teleproto is loaded only for real Telegram login. Its session string is a full
// credential; it is encrypted with the existing store key and never sent to UI.
export async function teleprotoClient({ apiId, apiHash, session = '' }) {
  const { TelegramClient, Api } = await import('teleproto');
  const { StringSession } = await import('teleproto/sessions');
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
  const roomEntities = new Map();
  await client.connect();
  async function dialogs() {
    const found = await client.getDialogs({ limit: 50 });
    return found.map(d => {
      const id = String(d.id);
      roomEntities.set(id, d.entity);
      return { id, name: String(d.name ?? d.title ?? id), unread_count: d.unreadCount ?? 0 };
    });
  }
  async function entityFor(id) {
    if (!roomEntities.has(id)) await dialogs();
    if (!roomEntities.has(id)) throw Object.assign(new Error('Unknown room'), { status: 404 });
    return roomEntities.get(id);
  }
  return {
    requestCode: phone => client.sendCode({ apiId, apiHash }, phone),
    signInCode: (phone, codeHash, code) => client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: codeHash, phoneCode: code })),
    signInPassword: password => client.signInWithPassword({ apiId, apiHash }, { password: async () => password, onError: error => { throw error; } }),
    getMe: () => client.getMe(),
    session: () => client.session.save(),
    rooms: dialogs,
    async messages(room) {
      const items = await client.getMessages(await entityFor(room), { limit: 50 });
      return items.map(m => ({ id: String(m.id), text: String(m.message ?? ''), author: m.out ? '我' : String(m.senderId ?? '使用者'), date: m.date ? new Date(Number(m.date) * 1000).toISOString() : '' })).reverse();
    },
    async send(room, text) { const sent = await client.sendMessage(await entityFor(room), { message: text, parseMode: undefined }); return { id: String(sent.id), text, author: '我' }; },
    disconnect: () => client.disconnect(),
  };
}

export function createTelegramUser({ store, env = process.env, clientFactory = teleprotoClient, now = Date.now }) {
  const pending = new Map(), sessions = new Map();
  const ttl = 5 * 60 * 1000;
  const configured = () => /^\d{1,12}$/.test(String(env.TELEGRAM_API_ID ?? '')) && /^[a-f\d]{32}$/i.test(env.TELEGRAM_API_HASH ?? '');
  const credentials = () => {
    if (!configured()) throw Object.assign(new Error('Telegram API app is not configured'), { status: 409 });
    return { apiId: Number(env.TELEGRAM_API_ID), apiHash: env.TELEGRAM_API_HASH };
  };
  async function expire() {
    for (const [id, item] of pending) if (now() - item.created > ttl) {
      pending.delete(id);
      await item.client.disconnect().catch(() => {});
    }
  }
  async function begin(phone) {
    if (!/^\+[1-9]\d{6,14}$/.test(phone ?? '')) throw Object.assign(new Error('Use E.164 phone number (+886...)'), { status: 400 });
    await expire();
    if (pending.size >= 3) throw Object.assign(new Error('Too many pending logins'), { status: 429 });
    const cred = credentials();
    const client = await clientFactory({ ...cred });
    try {
      const result = await client.requestCode(phone);
      if (!result?.phoneCodeHash) throw new Error('Telegram did not send a login code');
      const id = randomUUID();
      pending.set(id, { client, phone, codeHash: result.phoneCodeHash, cred, created: now(), attempts: 0 });
      return { login_id: id, expires_in: 300, delivery: result.isCodeViaApp ? 'telegram_app' : 'provider_selected' };
    } catch (error) { await client.disconnect().catch(() => {}); throw error; }
  }
  async function complete(loginId, code, password) {
    await expire();
    const job = pending.get(loginId);
    if (!job) throw Object.assign(new Error('Login expired. Request another code.'), { status: 400 });
    if (++job.attempts > 5) {
      pending.delete(loginId); await job.client.disconnect().catch(() => {});
      throw Object.assign(new Error('Too many attempts'), { status: 429 });
    }
    try {
      if (job.needsPassword) {
        if (typeof password !== 'string' || !password) throw Object.assign(new Error('Two-step password is required'), { status: 400 });
        await job.client.signInPassword(password);
      } else {
        if (!/^\d{4,8}$/.test(code ?? '')) throw Object.assign(new Error('Invalid confirmation code'), { status: 400 });
        try { await job.client.signInCode(job.phone, job.codeHash, code); }
        catch (error) {
          if (/SESSION_PASSWORD_NEEDED/i.test(String(error?.errorMessage ?? error?.message))) {
            job.needsPassword = true;
            return { stage: 'password_required' };
          }
          throw error;
        }
      }
      const me = await job.client.getMe();
      if (me?.id == null) throw new Error('Telegram account not verified');
      const session = job.client.session();
      if (!session) throw new Error('Telegram session could not be saved');
      const connection = store.addConnection('telegram', `Telegram ${me.firstName ?? job.phone}`, { ...job.cred, session, kind: 'user' });
      store.recordVerifiedAccount('telegram', String(me.id), [me.firstName, me.lastName].filter(Boolean).join(' ') || job.phone, null, connection.id);
      sessions.set(connection.id, job.client);
      pending.delete(loginId);
      return { stage: 'authenticated', connection_id: connection.id, display_name: me.firstName ?? job.phone };
    } catch (error) {
      // Never return login passwords, tokens or upstream error internals.
      if (job.attempts >= 5) { pending.delete(loginId); await job.client.disconnect().catch(() => {}); }
      throw Object.assign(new Error('Telegram login failed. Check the code/password or retry.'), { status: 400 });
    }
  }
  async function withSession(connectionId, method, ...args) {
    const conn = store.getConnection(connectionId);
    if (!conn || conn.platform !== 'telegram' || conn.credentials.kind !== 'user') throw Object.assign(new Error('Telegram user account not found'), { status: 404 });
    let client = sessions.get(conn.id);
    if (!client) {
      client = await clientFactory({ apiId: conn.credentials.apiId, apiHash: conn.credentials.apiHash, session: conn.credentials.session });
      const me = await client.getMe();
      if (!me) { await client.disconnect().catch(() => {}); throw Object.assign(new Error('Telegram session expired. Sign in again.'), { status: 401 }); }
      sessions.set(conn.id, client);
    }
    return client[method](...args);
  }
  async function close() {
    for (const p of pending.values()) p.client.disconnect().catch(() => {});
    for (const p of sessions.values()) p.disconnect().catch(() => {});
    pending.clear(); sessions.clear();
  }
  return { configured, begin, complete, withSession, close };
}
