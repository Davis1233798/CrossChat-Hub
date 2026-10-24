import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { createSlackPkce } from '../desktop/slack-pkce.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function callbackRequest(port, path, { method = 'GET', host = `localhost:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('Slack desktop OAuth uses registered localhost redirect, user scope, S256 and no client secret', async () => {
  const port = await freePort();
  const redirectUri = `http://localhost:${port}/slack/oauth/callback`;
  const calls = [];
  let randomValue = 0x61;
  const client = createSlackPkce({
    clientId: '12345.67890',
    registeredLoopbackRedirectUri: redirectUri,
    randomBytesFn: size => Buffer.alloc(size, randomValue++),
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true, team: { id: 'T123' }, authed_user: { id: 'U456', access_token: 'oauth-user-token' } });
    },
  });
  const login = await client.begin();
  assert.equal(login.status, 'ready');
  assert.equal(login.redirectUri, redirectUri);
  const authorize = new URL(login.authorizeUrl);
  assert.equal(authorize.origin + authorize.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(authorize.searchParams.get('scope'), '');
  assert.equal(authorize.searchParams.get('user_scope'), 'chat:write');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.has('client_secret'), false);
  assert.equal(authorize.searchParams.has('scope') && authorize.searchParams.get('scope') !== '', false);
  const verifier = Buffer.alloc(32, 0x61).toString('base64url');
  const verifierChallenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  assert.equal(authorize.searchParams.get('code_challenge'), verifierChallenge);

  // State remains the only callback correlation input. Invalid requests cannot consume the flow.
  assert.equal((await callbackRequest(port, `${new URL(redirectUri).pathname}?state=wrong&code=c`)).status, 400);
  assert.equal((await callbackRequest(port, `${new URL(redirectUri).pathname}?state=${authorize.searchParams.get('state')}&code=c`, { host: `127.0.0.1:${port}` })).status, 403);
  assert.equal((await callbackRequest(port, `${new URL(redirectUri).pathname}?state=${authorize.searchParams.get('state')}&code=c`, { method: 'POST' })).status, 405);
  assert.equal((await callbackRequest(port, `${new URL(redirectUri).pathname}?state=${authorize.searchParams.get('state')}&code=a&code=b`)).status, 400);

  const callback = await callbackRequest(port, `${new URL(redirectUri).pathname}?state=${authorize.searchParams.get('state')}&code=one-time-code`);
  assert.equal(callback.status, 200);
  assert.match(callback.body, /authorization is complete/i);
  const result = await login.completion;
  assert.equal(result.status, 'authorized');
  assert.deepEqual(result.token, { accessToken: 'oauth-user-token', userId: 'U456', teamId: 'T123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/oauth.v2.access');
  assert.equal(calls[0].options.redirect, 'error');
  const tokenBody = new URLSearchParams(calls[0].options.body);
  assert.equal(tokenBody.get('client_id'), '12345.67890');
  assert.equal(tokenBody.get('code'), 'one-time-code');
  assert.equal(tokenBody.get('redirect_uri'), redirectUri);
  assert.equal(tokenBody.get('grant_type'), 'authorization_code');
  assert.ok(tokenBody.get('code_verifier').length >= 43);
  assert.equal(tokenBody.has('client_secret'), false);
  client.close();
});

test('PKCE configuration rejects arbitrary hosts, paths, ports and missing client IDs', async () => {
  for (const redirectUri of [
    'http://127.0.0.1:43210/slack/oauth/callback',
    'https://localhost:43210/slack/oauth/callback',
    'http://localhost/slack/oauth/callback',
    'http://localhost:0/slack/oauth/callback',
    'http://localhost:43210/other',
    'http://localhost:43210/slack/oauth/callback?extra=1',
    'http://user@localhost:43210/slack/oauth/callback',
  ]) {
    assert.equal((await createSlackPkce({ clientId: '12345.67890', registeredLoopbackRedirectUri: redirectUri }).begin()).status, 'unavailable');
  }
  assert.equal((await createSlackPkce({ registeredLoopbackRedirectUri: 'http://localhost:43210/slack/oauth/callback' }).begin()).status, 'unavailable');
});

test('one authorization can be active at a time and cancellation closes the listener', async () => {
  const port = await freePort();
  const client = createSlackPkce({ clientId: '12345.67890', registeredLoopbackRedirectUri: `http://localhost:${port}/slack/oauth/callback` });
  const first = await client.begin();
  assert.equal((await client.begin()).reason, 'slack-oauth-already-active');
  first.cancel();
  assert.equal((await first.completion).reason, 'authorization-cancelled');
  client.close();
});

test('a busy registered callback port fails closed before returning an authorization URL', async () => {
  const port = await freePort();
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', resolve);
  });
  try {
    const client = createSlackPkce({ clientId: '12345.67890', registeredLoopbackRedirectUri: `http://localhost:${port}/slack/oauth/callback` });
    const result = await client.begin();
    assert.deepEqual(result, { status: 'unavailable', reason: 'loopback-listener-failed' });
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});

test('authorization timeout and token endpoint failures return redacted outcomes', async () => {
  const timeoutPort = await freePort();
  const timeoutClient = createSlackPkce({ clientId: '12345.67890', registeredLoopbackRedirectUri: `http://localhost:${timeoutPort}/slack/oauth/callback`, timeoutMs: 20 });
  const timed = await timeoutClient.begin();
  assert.equal((await timed.completion).reason, 'authorization-timeout');

  const port = await freePort();
  const failedClient = createSlackPkce({
    clientId: '12345.67890',
    registeredLoopbackRedirectUri: `http://localhost:${port}/slack/oauth/callback`,
    fetchFn: async () => { throw new Error('secret code and private token must not escape'); },
  });
  const login = await failedClient.begin();
  const authorize = new URL(login.authorizeUrl);
  await callbackRequest(port, `${new URL(login.redirectUri).pathname}?state=${authorize.searchParams.get('state')}&code=once`);
  const result = await login.completion;
  assert.deepEqual(result, { status: 'failed', reason: 'token-exchange-failed' });
  assert.doesNotMatch(JSON.stringify(result), /secret code|private token|once/);
});
