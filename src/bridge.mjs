export const PLATFORMS = ['slack', 'telegram', 'line', 'discord'];

// Deliberately require the destination platform: @line:alice, not ambiguous @alice.
export function extractMentions(text) {
  const pattern = /(^|[^\w])@(slack|telegram|line|discord):([a-z][a-z0-9_.-]{1,31})(?![a-z0-9_.-]|:)/gi;
  const matches = [...text.matchAll(pattern)];
  return [...new Map(matches.map(m => [`${m[2].toLowerCase()}:${m[3].toLowerCase()}`, { platform: m[2].toLowerCase(), alias: m[3].toLowerCase() }])).values()];
}

export function processIncoming(store, message) {
  const { connectionId, eventId, roomId, authorId, text, platform } = message;
  if (!text?.trim() || authorId == null || roomId == null || eventId == null) return { stored: false, enqueued: 0 };
  const messageId = store.insertMessage(connectionId, String(eventId), String(roomId), String(authorId), text.slice(0, 8000));
  if (!messageId) return { stored: false, enqueued: 0 }; // idempotent webhook
  let enqueued = 0;
  for (const mention of extractMentions(text)) {
    for (const addr of store.findAddresses(mention.alias, mention.platform)) {
      const formatted = `[CrossChat | ${platform} → ${mention.platform}]\nFrom: ${authorId}\nChat: ${roomId}\n\n${text}`.slice(0, 3500);
      if (store.queueDelivery(addr.connection_id, addr.external_user_id, formatted, messageId, addr.id)) enqueued++;
    }
  }
  // Bridge rules are opt-in, scoped to a concrete source connection and room.
  // Events posted by our own bots are filtered by every ingress adapter; exact
  // source-event deduplication also prevents retries from fanning out twice.
  for (const rule of store.matchingBridgeRules?.(connectionId, String(roomId)) ?? []) {
    if (rule.source_connection_id === rule.target_connection_id && rule.source_room_id === rule.target_room_id) continue;
    const formatted = `[CrossChat ${platform} | ${authorId}]\n${text}`.slice(0, 3500);
    if (store.queueDelivery(rule.target_connection_id, rule.target_room_id, formatted, messageId, null, 'room', rule.id)) enqueued++;
  }
  return { stored: true, enqueued };
}

function slackEvents(body, connectionId) {
  if (body.type !== 'event_callback' || !body.event || body.event.type !== 'message') return [];
  const e = body.event;
  if (!e.text || !e.user || e.bot_id || e.subtype) return [];
  return [{ connectionId, platform: 'slack', eventId: body.event_id ?? `${e.channel}:${e.ts}`, roomId: e.channel, authorId: e.user, text: e.text }];
}
function telegramEvents(body, connectionId) {
  const msg = body.message;
  if (!msg?.text || !msg.from || msg.from.is_bot) return [];
  return [{ connectionId, platform: 'telegram', eventId: body.update_id, roomId: msg.chat.id, authorId: msg.from.id, text: msg.text }];
}
function lineEvents(body, connectionId) {
  return (body.events ?? []).filter(e => e.type === 'message' && e.message?.type === 'text' && e.source?.userId).map(e => ({
    connectionId, platform: 'line', eventId: e.message.id, roomId: e.source.groupId ?? e.source.roomId ?? e.source.userId,
    authorId: e.source.userId, text: e.message.text,
  }));
}
function discordEvents(body, connectionId) {
  if (body.type !== 2 || body.data?.name !== 'tag') return [];
  const options = Object.fromEntries((body.data.options ?? []).map(opt => [opt.name, opt.value]));
  if (!/^(slack|telegram|line|discord):[a-z][a-z0-9_.-]{1,31}$/.test(options.recipient ?? '') || !options.message) return [];
  return [{ connectionId, platform: 'discord', eventId: body.id, roomId: body.channel_id ?? 'dm',
    authorId: body.member?.user?.id ?? body.user?.id, text: `@${options.recipient} ${options.message}` }];
}
export function normalizeEvents(platform, body, connectionId) {
  switch (platform) {
    case 'slack': return slackEvents(body, connectionId);
    case 'telegram': return telegramEvents(body, connectionId);
    case 'line': return lineEvents(body, connectionId);
    case 'discord': return discordEvents(body, connectionId);
    default: return [];
  }
}

async function apiPost(fetchFn, url, token, payload, auth = 'Bearer') {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `${auth} ${token}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (!res.ok) throw new Error(`Remote API HTTP ${res.status}`);
  return res;
}

export async function sendPlatformMessage(connection, targetId, text, fetchFn = fetch, targetKind = 'user') {
  const { platform, credentials } = connection;
  const token = credentials.token;
  switch (platform) {
    case 'slack': {
      // A Slack user ID is not a channel ID. Open a DM explicitly to send a notification.
      let channelId = targetId;
      if (targetKind === 'user') {
        const opened = await apiPost(fetchFn, 'https://slack.com/api/conversations.open', token, { users: targetId });
        const dm = await opened.json();
        if (!dm.ok || !dm.channel?.id) throw new Error(`Slack conversations.open: ${String(dm.error ?? 'unknown').slice(0, 80)}`);
        channelId = dm.channel.id;
      }
      const posted = await apiPost(fetchFn, 'https://slack.com/api/chat.postMessage', token,
        { channel: channelId, text: text.slice(0, 3500), unfurl_links: false, unfurl_media: false });
      const result = await posted.json();
      if (!result.ok) throw new Error(`Slack chat.postMessage: ${String(result.error ?? 'unknown').slice(0, 80)}`);
      return;
    }
    case 'telegram': {
      const response = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: targetId, text: text.slice(0, 3500), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Remote API HTTP ${response.status}`);
      const result = await response.json();
      if (!result.ok) throw new Error(`Telegram sendMessage: ${String(result.description ?? 'unknown').slice(0, 80)}`);
      return;
    }
    case 'line':
      await apiPost(fetchFn, 'https://api.line.me/v2/bot/message/push', token,
        { to: targetId, messages: [{ type: 'text', text: text.slice(0, 3500) }] });
      return;
    case 'discord': {
      // DM creation may fail due to user privacy settings; this is expected.
      let channelId = targetId;
      if (targetKind === 'user') {
        const opened = await apiPost(fetchFn, 'https://discord.com/api/v10/users/@me/channels', token,
          { recipient_id: targetId }, 'Bot');
        const dm = await opened.json();
        if (!dm.id) throw new Error('Discord did not provide a DM channel');
        channelId = dm.id;
      }
      await apiPost(fetchFn, `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, token,
        { content: text.slice(0, 1900), allowed_mentions: { parse: [] } }, 'Bot');
      return;
    }
    default: throw new Error('Unsupported platform');
  }
}

export async function flushOutbox(store, fetchFn = fetch, prepareConnection = async c => c) {
  let sent = 0, failed = 0;
  for (const row of store.nextDeliveries()) {
    let connection = store.getConnection(row.connection_id);
    try {
      if (!connection) throw new Error('Connection removed');
      connection = await prepareConnection(connection);
      await sendPlatformMessage(connection, row.target_id, row.text, fetchFn, row.target_kind);
      store.finishDelivery(row.id);
      sent++;
    } catch (err) {
      const attempts = row.attempts + 1;
      store.failDelivery(row.id, attempts, err.message, Math.min(60000, 1000 * 2 ** attempts));
      failed++;
    }
  }
  return { sent, failed };
}

// Called only for DISCORD Gateway MESSAGE_CREATE dispatches. Bot and webhook
// messages are not bridged, preventing our own outbound events looping back.
export function normalizeDiscordGatewayMessage(connectionId, msg) {
  if (!msg || !msg.id || !msg.channel_id || !msg.author?.id || msg.author.bot || msg.webhook_id || !msg.content) return null;
  return { connectionId, platform: 'discord', eventId: msg.id, roomId: msg.channel_id,
    authorId: msg.author.id, text: msg.content };
}
