import { randomBytes, createHash } from 'node:crypto';

const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const stateToken = () => randomBytes(32).toString('base64url');
const codeChallenge = v => createHash('sha256').update(v).digest('base64url');
const authorizedHosts = { slack: 'https://slack.com/oauth/v2/authorize', discord: 'https://discord.com/oauth2/authorize', line: 'https://access.line.me/oauth2/v2.1/authorize' };

async function jsonReply(response) {
  if (!response.ok) throw new Error(`OAuth provider HTTP ${response.status}`);
  const data = await response.json();
  if (!data || typeof data !== 'object') throw new Error('Invalid OAuth response');
  return data;
}

export function createOAuthManager({ store, env = process.env, fetchFn = fetch, now = Date.now }) {
  const pending = new Map();
  const callbackBase = (env.OAUTH_CALLBACK_BASE_URL ?? '').replace(/\/$/, '');
  const settings = platform => {
    const prefix = platform.toUpperCase();
    return {
      clientId: env[`${prefix}_CLIENT_ID`], clientSecret: env[`${prefix}_CLIENT_SECRET`],
      redirectUri: `${callbackBase}/oauth/${platform}/callback`,
    };
  };
  const configured = platform => {
    const cfg = settings(platform);
    return Boolean(callbackBase && /^https?:\/\//.test(callbackBase) && cfg.clientId && cfg.clientSecret);
  };
  function begin(platform, { name, identity_id, connection_id, mode = 'bot' } = {}) {
    if (!['slack', 'discord', 'line'].includes(platform) || !configured(platform)) throw new Error(`OAuth not configured for ${platform}`);
    if (name != null && (typeof name !== 'string' || !name.trim() || name.length > 80)) throw new Error('Invalid connection name');
    if (platform === 'discord' && ((identity_id && !validId(identity_id)) || (connection_id && !validId(connection_id)) || Boolean(identity_id) !== Boolean(connection_id))) throw new Error('Invalid optional Discord identity mapping');
    if (platform === 'discord' && connection_id && (store.getConnection(connection_id)?.platform !== 'discord' || !store.listIdentities().some(i => i.id === identity_id))) throw new Error('Invalid Discord identity or bot connection');
    if (platform === 'slack' && !['user','bot'].includes(mode)) throw new Error('Invalid Slack OAuth mode');
    const state = stateToken();
    const verifier = stateToken();
    const { clientId, redirectUri } = settings(platform);
    for (const [key, v] of pending) if (now() - v.createdAt > 600000) pending.delete(key);
    pending.set(state, { platform, createdAt: now(), name: name?.trim(), identity_id, connection_id, verifier, mode });
    const url = new URL(authorizedHosts[platform]);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    if (platform === 'slack') {
      if (mode === 'bot') url.searchParams.set('scope', env.SLACK_OAUTH_SCOPES ?? 'chat:write,im:write,channels:history');
      else url.searchParams.set('user_scope', env.SLACK_USER_OAUTH_SCOPES ?? 'chat:write,channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history');
    } else if (platform === 'line') {
      url.searchParams.set('scope', 'profile openid');
      url.searchParams.set('nonce', stateToken());
    } else {
      url.searchParams.set('scope', 'identify');
      url.searchParams.set('code_challenge', codeChallenge(verifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }
  async function complete(platform, { state, code, error } = {}) {
    const job = pending.get(state);
    if (!job || job.platform !== platform) throw new Error('Invalid OAuth state');
    pending.delete(state); // one-time state, including failed responses
    if (now() - job.createdAt > 600000) throw new Error('OAuth state expired');
    if (error || !code || typeof code !== 'string' || code.length > 2048) throw new Error('OAuth authorization denied or invalid');
    const cfg = settings(platform);
    const params = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret,
      code, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' });
    if (platform === 'discord') params.set('code_verifier', job.verifier);
    const token = await jsonReply(await fetchFn(platform === 'slack' ? 'https://slack.com/api/oauth.v2.access' : platform === 'line' ? 'https://api.line.me/oauth2/v2.1/token' : 'https://discord.com/api/v10/oauth2/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params,
      redirect: 'error', signal: AbortSignal.timeout(10000),
    }));
    if (platform === 'line') {
      if (!token.access_token) throw new Error('LINE did not grant a profile token');
      const profile = await jsonReply(await fetchFn('https://api.line.me/v2/profile', {
        headers: { authorization: `Bearer ${token.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
      }));
      if (!/^U[0-9a-f]{32}$/i.test(profile.userId ?? '')) throw new Error('LINE did not return a valid user ID');
      // LINE Login is identity-only. Never store the access token or imply chat API access.
      return { platform, account: store.recordVerifiedAccount('line', profile.userId, profile.displayName ?? profile.userId) };
    }
    if (platform === 'slack') {
      if (job.mode === 'user') {
        const user = token.authed_user;
        if (!token.ok || !user?.id || !user?.access_token || !token.team?.id) throw new Error('Slack did not grant a user token');
        const creds = { token: user.access_token, kind: 'user', team_id: token.team.id };
        if (env.SLACK_SIGNING_SECRET) creds.signing_secret = env.SLACK_SIGNING_SECRET;
        if (user.refresh_token) creds.refresh_token = user.refresh_token;
        if (user.expires_in) creds.expires_at = now() + Number(user.expires_in) * 1000;
        const connection = store.addConnection('slack', job.name ?? `Slack ${token.team.name ?? token.team.id}`, creds);
        const account = store.recordVerifiedAccount('slack', user.id, `${token.team.name ?? token.team.id} · ${user.id}`, null, connection.id);
        return { platform, account, connection };
      }
      if (!token.ok || !token.access_token || !token.team?.id) throw new Error('Slack OAuth did not return a bot token and workspace ID');
      if (!env.SLACK_SIGNING_SECRET) throw new Error('SLACK_SIGNING_SECRET is required to verify incoming webhooks');
      const creds = { token: token.access_token, signing_secret: env.SLACK_SIGNING_SECRET, team_id: token.team.id };
      if (token.refresh_token) creds.refresh_token = token.refresh_token;
      if (token.expires_in) creds.expires_at = now() + Number(token.expires_in) * 1000;
      return { platform, connection: store.addConnection('slack', job.name ?? token.team.name ?? token.team.id, creds) };
    }
    if (!token.access_token || token.token_type?.toLowerCase() !== 'bearer') throw new Error('Discord OAuth did not return a user token');
    const user = await jsonReply(await fetchFn('https://discord.com/api/v10/users/@me', {
      headers: { authorization: `Bearer ${token.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
    }));
    if (!/^\d{15,22}$/.test(user.id ?? '')) throw new Error('Discord OAuth identity invalid');
    // Only persist verified public identity. OAuth bearer and refresh tokens are discarded.
    const matching = job.connection_id ? store.listAddresses().find(a => a.connection_id === job.connection_id && a.external_user_id === user.id) : null;
    if (matching && matching.identity_id !== job.identity_id) throw new Error('Discord user is mapped to another identity');
    if (job.identity_id && job.connection_id) {
      if (!matching) store.addAddress(job.identity_id, job.connection_id, user.id, true);
      else store.verifyAddress(matching.id);
    }
    const verified = store.recordVerifiedAccount('discord', user.id, user.global_name ?? user.username ?? user.id, job.identity_id, job.connection_id);
    return { platform, account: verified };
  }
  async function refreshSlack(connection) {
    const creds = connection.credentials;
    if (!creds.expires_at || creds.expires_at > now() + 120000 || !creds.refresh_token) return connection;
    const cfg = settings('slack');
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('Slack OAuth refresh is not configured');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refresh_token,
      client_id: cfg.clientId, client_secret: cfg.clientSecret });
    const result = await jsonReply(await fetchFn('https://slack.com/api/oauth.v2.access', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
      signal: AbortSignal.timeout(10000), redirect: 'error',
    }));
    const fresh = creds.kind === 'user' ? result.authed_user : result;
    if (!result.ok || !fresh?.access_token) throw new Error('Slack OAuth token refresh failed');
    const next = { ...creds, token: fresh.access_token, refresh_token: fresh.refresh_token ?? creds.refresh_token,
      expires_at: now() + Number(fresh.expires_in ?? 3600) * 1000 };
    store.updateConnectionCredentials(connection.id, next);
    return { ...connection, credentials: next };
  }
  function discordInstallUrl() {
    if (!env.DISCORD_CLIENT_ID || !/^\d{15,22}$/.test(env.DISCORD_CLIENT_ID)) throw new Error('DISCORD_CLIENT_ID is not configured');
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
    url.searchParams.set('scope', 'bot applications.commands');
    url.searchParams.set('permissions', '68608'); // View Channel, Send Messages, Read Message History
    url.searchParams.set('integration_type', '0'); // Guild installation
    return url.toString();
  }
  return { begin, complete, configured, refreshSlack, discordInstallUrl };
}
