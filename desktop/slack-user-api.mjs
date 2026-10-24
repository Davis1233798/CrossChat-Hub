const AUTH_TEST_ENDPOINT = 'https://slack.com/api/auth.test';
const POST_MESSAGE_ENDPOINT = 'https://slack.com/api/chat.postMessage';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 4000;
const MAX_TOKEN_LENGTH = 8192;

const safeResult = (status, reason) => Object.freeze({ status, reason });

function validToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
}

function validUserId(value) {
  return typeof value === 'string' && /^[UW][A-Z0-9]+$/.test(value);
}

function validTeamId(value) {
  return typeof value === 'string' && /^T[A-Z0-9]+$/.test(value);
}

function validChannelId(value) {
  return typeof value === 'string' && /^[CGD][A-Z0-9]+$/.test(value);
}

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{10}\.\d{6}$/.test(value);
}

function accountId(teamId, userId) {
  return `slack:${teamId}:${userId}`;
}

function sameAccount(left, right) {
  return left?.platform === 'slack' && left?.accountKind === 'personal' &&
    left.teamId === right.teamId && left.userId === right.userId &&
    left.accountId === accountId(right.teamId, right.userId);
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

/**
 * Main-process-only, fixed-endpoint Slack user-token API client.
 * It never discovers targets, constructs API URLs from caller input, or logs bodies.
 */
export function createSlackUserApi({
  fetchFn = globalThis.fetch,
  timeoutMs = 10_000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  maxTextLength = MAX_TEXT_LENGTH,
} = {}) {
  const configured = typeof fetchFn === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 &&
    Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 &&
    Number.isSafeInteger(maxTextLength) && maxTextLength > 0 && maxTextLength <= MAX_TEXT_LENGTH;

  async function call(endpoint, token, payload) {
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok) return { status: 'transport-unknown' };
      try { return { status: 'response', payload: await readJsonBounded(response, maxResponseBytes) }; }
      catch { return { status: 'transport-unknown' }; }
    } catch {
      return { status: 'transport-unknown' };
    }
  }

  async function verifyAccount(accessToken) {
    if (!configured) return safeResult('unavailable', 'slack-api-unavailable');
    if (!validToken(accessToken)) return safeResult('rejected', 'invalid-access-token');
    const result = await call(AUTH_TEST_ENDPOINT, accessToken, {});
    if (result.status !== 'response') return safeResult('unavailable', 'account-verification-failed');
    const reply = result.payload;
    if (reply?.ok !== true || reply.bot_id || !validUserId(reply.user_id) || !validTeamId(reply.team_id)) {
      return safeResult('rejected', 'personal-slack-account-required');
    }
    return Object.freeze({ status: 'verified', account: Object.freeze({
      platform: 'slack',
      accountKind: 'personal',
      accountId: accountId(reply.team_id, reply.user_id),
      teamId: reply.team_id,
      userId: reply.user_id,
    }) });
  }

  async function postPlainText({ accessToken, account, channelId, text, validateBeforeDispatch } = {}) {
    // The caller must durably claim the draft's dedupe key before dispatch.
    // An unknown result is for reconciliation and must never be retried blindly.
    if (!configured) return safeResult('unavailable', 'slack-api-unavailable');
    if (!validToken(accessToken) || !account || account.platform !== 'slack' || account.accountKind !== 'personal' ||
        !validUserId(account.userId) || !validTeamId(account.teamId) || account.accountId !== accountId(account.teamId, account.userId) ||
        !validChannelId(channelId) || typeof text !== 'string' || !text.trim() || text.length > maxTextLength || text.includes('\u0000')) {
      return safeResult('rejected', 'invalid-message-input');
    }

    // Verify identity immediately before dispatch. A token refreshed or replaced
    // outside this module must never redirect a draft to another Slack account.
    const verified = await verifyAccount(accessToken);
    if (verified.status !== 'verified') return safeResult('rejected', 'account-verification-failed');
    if (!sameAccount(account, verified.account)) return safeResult('rejected', 'slack-account-changed');
    if (validateBeforeDispatch !== undefined && (typeof validateBeforeDispatch !== 'function' || validateBeforeDispatch() !== true)) return safeResult('rejected', 'dispatch-preconditions-changed');

    // Intentionally omit client_msg_id: the public chat.postMessage argument
    // reference does not document it as a supported idempotency mechanism.
    const result = await call(POST_MESSAGE_ENDPOINT, accessToken, {
      channel: channelId,
      text,
      mrkdwn: false,
      parse: 'none',
      unfurl_links: false,
      unfurl_media: false,
    });
    if (result.status !== 'response') return safeResult('unknown', 'reconcile-before-retry');
    if (result.payload?.ok === false) return safeResult('rejected', 'slack-rejected-message');
    const reply = result.payload;
    if (reply?.ok !== true || reply.channel !== channelId || !validTimestamp(reply.ts)) {
      return safeResult('unknown', 'reconcile-before-retry');
    }
    return Object.freeze({ status: 'submitted', receipt: Object.freeze({
      messageId: reply.ts,
      target: Object.freeze({ platform: 'slack', accountId: verified.account.accountId, chatId: channelId }),
    }) });
  }

  return Object.freeze({ isConfigured: configured, verifyAccount, postPlainText });
}
