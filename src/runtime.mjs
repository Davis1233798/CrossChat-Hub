import { createStore } from './store.mjs';
import { createApp } from './app.mjs';
import { createOAuthManager } from './oauth.mjs';
import { DiscordGatewayManager } from './gateway.mjs';
import { flushOutbox } from './bridge.mjs';

export async function startHub({ env = process.env, host = '127.0.0.1', port = 8787, fetchFn = fetch, WebSocketClass = globalThis.WebSocket } = {}) {
  const store = createStore(env.DATABASE_PATH ?? './data/crosschat.sqlite', env.ENCRYPTION_KEY);
  let app, gateway, interval;
  try {
    const oauth = createOAuthManager({ store, env, fetchFn });
    gateway = new DiscordGatewayManager({ store, fetchFn, WebSocketClass });
    app = createApp({ store, adminKey: env.ADMIN_API_KEY, oauth, gateway, fetchFn });
    await new Promise((resolve, reject) => { app.once('error', reject); app.listen(port, host, resolve); });
    const actualPort = app.address().port;
    if (!env.OAUTH_CALLBACK_BASE_URL) env.OAUTH_CALLBACK_BASE_URL = `http://${host}:${actualPort}`;
    gateway.sync();
    let working = false;
    interval = setInterval(async () => {
      if (working) return;
      working = true;
      try { await flushOutbox(store, fetchFn, c => c.platform === 'slack' ? oauth.refreshSlack(c) : c); }
      catch (error) { console.error('Outbox worker:', error.message); }
      finally { working = false; }
    }, Math.max(500, Number(env.OUTBOX_INTERVAL_MS ?? 2000)));
    let closed = false;
    return {
      port: actualPort, app, store, oauth, gateway,
      async close() {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        gateway.stop();
        await new Promise((resolve, reject) => app.close(err => err ? reject(err) : resolve()));
        store.close();
      },
    };
  } catch (error) {
    clearInterval(interval); gateway?.stop();
    if (app?.listening) await new Promise(resolve => app.close(resolve));
    store.close();
    throw error;
  }
}
