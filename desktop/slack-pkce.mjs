import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const AUTHORIZE_ENDPOINT = 'https://slack.com/oauth/v2/authorize';
const TOKEN_ENDPOINT = 'https://slack.com/api/oauth.v2.access';
const CALLBACK_PATH = '/slack/oauth/callback';
const SCOPE = 'chat:write';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CODE_LENGTH = 4096;
const MAX_STATE_LENGTH = 256;

function validClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9.]{3,256}$/.test(value);
}

function validRedirectUri(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' || url.hostname !== 'localhost' || !url.port ||
      url.username || url.password || url.pathname !== CALLBACK_PATH || url.search || url.hash) return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { href: `http://localhost:${port}${CALLBACK_PATH}`, port };
}

function randomUrlToken(randomBytesFn, size) {
  return randomBytesFn(size).toString('base64url');
}

function safeFailure(reason) {
  return Object.freeze({ status: 'failed', reason });
}

async function readJsonBounded(response, maxBytes) {
  const type = String(response.headers?.get?.('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json' && !type.endsWith('+json')) throw new Error('bad-content-type');
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('response-too-large');
  if (!response.body?.getReader) throw new Error('unbounded-response-body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('response-too-large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function validateTokenReply(value) {
  const user = value?.authed_user;
  const team = value?.team;
  if (!value || value.ok !== true || typeof user?.id !== 'string' || !/^[UW][A-Z0-9]+$/i.test(user.id) ||
      typeof user.access_token !== 'string' || !user.access_token || user.access_token.length > 8192 ||
      typeof team?.id !== 'string' || !/^T[A-Z0-9]+$/i.test(team.id)) return null;
  const token = {
    accessToken: user.access_token,
    userId: user.id,
    teamId: team.id,
  };
  if (typeof user.refresh_token === 'string' && user.refresh_token.length <= 8192) token.refreshToken = user.refresh_token;
  if (Number.isFinite(Number(user.expires_in)) && Number(user.expires_in) > 0) token.expiresIn = Number(user.expires_in);
  return Object.freeze(token);
}

/**
 * Main-process-only Slack desktop OAuth via the documented public-client PKCE flow.
 * The redirect URI must be registered in Slack and is never selected by a renderer.
 */
export function createSlackPkce({
  clientId,
  registeredLoopbackRedirectUri,
  fetchFn = globalThis.fetch,
  createServerFn = createServer,
  randomBytesFn = randomBytes,
  timeoutMs = 120_000,
  exchangeTimeoutMs = 10_000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  now = Date.now,
} = {}) {
  const redirect = validRedirectUri(registeredLoopbackRedirectUri);
  const isConfigured = validClientId(clientId) && Boolean(redirect) && typeof fetchFn === 'function' &&
    typeof createServerFn === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 &&
    Number.isSafeInteger(exchangeTimeoutMs) && exchangeTimeoutMs > 0 &&
    Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0;
  let active = null;

  async function exchange(code, verifier, redirectUri, abortSignal) {
    const body = new URLSearchParams({
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    try {
      const response = await fetchFn(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
        signal: AbortSignal.any([abortSignal, AbortSignal.timeout(exchangeTimeoutMs)]),
      });
      if (!response?.ok) return safeFailure('token-exchange-failed');
      let payload;
      try { payload = await readJsonBounded(response, maxResponseBytes); }
      catch { return safeFailure('token-exchange-failed'); }
      const token = validateTokenReply(payload);
      return token ? { status: 'authorized', token } : safeFailure('token-exchange-failed');
    } catch {
      return safeFailure('token-exchange-failed');
    }
  }

  async function begin() {
    if (!isConfigured) return { status: 'unavailable', reason: 'slack-oauth-not-configured' };
    if (active) return { status: 'unavailable', reason: 'slack-oauth-already-active' };

    const verifier = randomUrlToken(randomBytesFn, 32);
    const state = randomUrlToken(randomBytesFn, 32);
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirect.href);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('scope', '');
    authorizeUrl.searchParams.set('user_scope', SCOPE);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const servers = [createServerFn(), createServerFn()];
    let timer = null;
    let settle;
    let resolveReady;
    let readyResolved = false;
    const transaction = { servers, abortController: new AbortController(), settled: false };
    const completion = new Promise(resolve => { settle = resolve; });
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const settleReady = result => {
      if (readyResolved) return;
      readyResolved = true;
      resolveReady(result);
    };
    function closeServer(server) {
      if (server.listening) server.close();
      else server.once('listening', () => { if (server.listening) server.close(); });
    }
    function closeServers() {
      for (const server of servers) closeServer(server);
    }
    const finish = async (result, shouldExchange = false, code = null) => {
      if (transaction.settled) return;
      transaction.settled = true;
      clearTimeout(timer);
      closeServers();
      if (!shouldExchange) transaction.abortController.abort();
      if (!readyResolved) settleReady({ status: 'unavailable', reason: result?.reason ?? 'loopback-listener-failed' });
      const output = shouldExchange
        ? await exchange(code, verifier, redirect.href, transaction.abortController.signal)
        : result;
      if (active === transaction) active = null;
      settle(output);
    };
    const rejectRequest = (response, status, text) => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
      response.end(text);
    };

    const handleRequest = (request, response) => {
      if (transaction.settled) return rejectRequest(response, 410, 'This sign-in request is no longer active.');
      const peer = request.socket.remoteAddress;
      const peerIsLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
      if (!peerIsLoopback || request.headers.host !== `localhost:${redirect.port}`) return rejectRequest(response, 403, 'This request is not valid.');
      if (request.method !== 'GET') return rejectRequest(response, 405, 'This request is not valid.');
      if (request.url.length > MAX_CODE_LENGTH + MAX_STATE_LENGTH + 1024 ||
          Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding']) {
        return rejectRequest(response, 400, 'This request is not valid.');
      }
      let callback;
      try { callback = new URL(request.url, redirect.href); } catch { return rejectRequest(response, 400, 'This request is not valid.'); }
      if (now() - startedAt > timeoutMs) return rejectRequest(response, 410, 'This sign-in request is no longer active.');
      if (callback.origin !== `http://localhost:${redirect.port}` || callback.pathname !== CALLBACK_PATH || callback.username || callback.password || callback.hash) {
        return rejectRequest(response, 404, 'This request is not valid.');
      }
      if ([...callback.searchParams.keys()].some(key => !['state', 'code', 'error'].includes(key))) return rejectRequest(response, 400, 'This request is not valid.');
      const states = callback.searchParams.getAll('state');
      const codes = callback.searchParams.getAll('code');
      const errors = callback.searchParams.getAll('error');
      if (states.length !== 1 || states[0].length > MAX_STATE_LENGTH || states[0] !== state) return rejectRequest(response, 400, 'This request is not valid.');
      if (codes.length === 1 && errors.length === 0 && codes[0].length > 0 && codes[0].length <= MAX_CODE_LENGTH) {
        const code = codes[0];
        rejectRequest(response, 200, 'Slack authorization is complete. You can return to CrossChat Hub.');
        void finish(null, true, code);
        return;
      }
      if (codes.length === 0 && errors.length === 1 && errors[0].length <= 128) {
        rejectRequest(response, 200, 'Slack authorization was not completed. You can return to CrossChat Hub.');
        void finish(safeFailure('authorization-denied'));
        return;
      }
      rejectRequest(response, 400, 'This request is not valid.');
    };
    const login = {
      status: 'ready',
      authorizeUrl: authorizeUrl.toString(),
      redirectUri: redirect.href,
      completion,
      cancel: () => {
        transaction.abortController.abort();
        void finish(safeFailure('authorization-cancelled'));
      },
    };
    for (const server of servers) {
      server.on('request', handleRequest);
      server.on('error', () => { void finish(safeFailure('loopback-listener-failed')); });
    }
    const startedAt = now();
    transaction.finish = finish;
    active = transaction;
    timer = setTimeout(() => { void finish(safeFailure('authorization-timeout')); }, timeoutMs);
    timer.unref?.();
    const listeners = [
      { server: servers[0], options: { port: redirect.port, host: '127.0.0.1' } },
      { server: servers[1], options: { port: redirect.port, host: '::1', ipv6Only: true } },
    ];
    const bindPromises = listeners.map(({ server, options }) => new Promise((resolve, reject) => {
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      const onError = error => { server.removeListener('listening', onListening); reject(error); };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(options);
    }));
    const allBound = Promise.all(bindPromises).then(() => true, () => false);
    const bound = await allBound;
    if (!bound) {
      void finish(safeFailure('loopback-listener-failed'));
      settleReady({ status: 'unavailable', reason: 'loopback-listener-failed' });
    } else {
      settleReady(transaction.settled ? { status: 'unavailable', reason: 'loopback-listener-failed' } : login);
    }
    return ready;
  }

  function close() {
    if (active) {
      active.abortController.abort();
      void active.finish(safeFailure('authorization-cancelled'));
    }
  }

  return Object.freeze({ begin, close, isConfigured });
}
