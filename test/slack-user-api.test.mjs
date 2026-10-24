import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackUserApi } from '../desktop/slack-user-api.mjs';

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const identityReply = { ok: true, team_id: 'T123', user_id: 'U456' };

test('identity verification accepts a user token and returns an exact account binding', async () => {
  const calls = [];
  const api = createSlackUserApi({ fetchFn: async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(identityReply);
  } });
  const result = await api.verifyAccount('user-oauth-token');
  assert.deepEqual(result, { status: 'verified', account: {
    platform: 'slack', accountKind: 'personal', accountId: 'slack:T123:U456', teamId: 'T123', userId: 'U456',
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/auth.test');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.authorization, 'Bearer user-oauth-token');
});

test('plain-text send rechecks the same account and accepts only an exact channel ID', async () => {
  const calls = [];
  const api = createSlackUserApi({ fetchFn: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth.test')) return jsonResponse(identityReply);
    return jsonResponse({ ok: true, channel: 'D789', ts: '1771862400.000123' });
  } });
  const { account } = await api.verifyAccount('user-oauth-token');
  calls.length = 0;
  const result = await api.postPlainText({ accessToken: 'user-oauth-token', account, channelId: 'D789', text: 'plain **text**' });
  assert.deepEqual(result, { status: 'submitted', receipt: {
    messageId: '1771862400.000123',
    target: { platform: 'slack', accountId: 'slack:T123:U456', chatId: 'D789' },
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://slack.com/api/auth.test');
  assert.equal(calls[1].url, 'https://slack.com/api/chat.postMessage');
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    channel: 'D789', text: 'plain **text**', mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
  });
  assert.equal('client_msg_id' in body, false);
  assert.equal(calls[1].options.redirect, 'error');
});

test('account change, bot identity, and non-ID destinations are rejected before posting', async () => {
  let postCount = 0;
  let authReply = identityReply;
  const api = createSlackUserApi({ fetchFn: async url => {
    if (url.endsWith('/auth.test')) return jsonResponse(authReply);
    postCount++;
    return jsonResponse({ ok: true, channel: 'C789', ts: '1771862400.000123' });
  } });
  const { account } = await api.verifyAccount('user-oauth-token');
  authReply = { ok: true, team_id: 'T-other', user_id: 'U456' };
  assert.equal((await api.postPlainText({ accessToken: 'user-oauth-token', account, channelId: 'C789', text: 'hello' })).reason, 'account-verification-failed');
  assert.equal(postCount, 0);
  authReply = { ok: true, team_id: 'T123', user_id: 'U456', bot_id: 'B777' };
  assert.equal((await api.verifyAccount('bot-token')).reason, 'personal-slack-account-required');
  authReply = identityReply;
  assert.equal((await api.postPlainText({ accessToken: 'user-oauth-token', account, channelId: 'general', text: 'hello' })).reason, 'invalid-message-input');
  assert.equal(postCount, 0);
});

test('uncertain send transport or unconfirmed receipt returns unknown without retry', async () => {
  for (const postReply of [
    () => { throw new Error('transport includes credential'); },
    () => jsonResponse({ ok: true, channel: 'C-other', ts: '1771862400.000123' }),
    () => jsonResponse({ ok: true, channel: 'C789', ts: 'not-a-ts' }),
  ]) {
    let sends = 0;
    const api = createSlackUserApi({ fetchFn: async url => {
      if (url.endsWith('/auth.test')) return jsonResponse(identityReply);
      sends++;
      return postReply();
    } });
    const { account } = await api.verifyAccount('user-oauth-token');
    const result = await api.postPlainText({ accessToken: 'user-oauth-token', account, channelId: 'C789', text: 'hello' });
    assert.deepEqual(result, { status: 'unknown', reason: 'reconcile-before-retry' });
    assert.equal(sends, 1);
  }
});

test('Slack-reported message rejection is definitive and response body limits are enforced', async () => {
  const rejectedApi = createSlackUserApi({ fetchFn: async url => url.endsWith('/auth.test')
    ? jsonResponse(identityReply)
    : jsonResponse({ ok: false, error: 'not_in_channel' }) });
  const { account } = await rejectedApi.verifyAccount('user-oauth-token');
  assert.equal((await rejectedApi.postPlainText({ accessToken: 'user-oauth-token', account, channelId: 'C789', text: 'hello' })).reason, 'slack-rejected-message');

  const boundedApi = createSlackUserApi({ maxResponseBytes: 20, fetchFn: async () => jsonResponse({ ok: true, team_id: 'T123', user_id: 'U456' }) });
  assert.equal((await boundedApi.verifyAccount('user-oauth-token')).reason, 'account-verification-failed');
});
