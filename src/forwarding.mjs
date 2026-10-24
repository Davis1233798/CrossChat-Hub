import { createHash } from 'node:crypto';

const platforms = new Set(['line', 'telegram', 'discord', 'slack', 'whatsapp']);
const invalid = reason => ({ status: 'invalid', reason });

// Routing is a leading command, separate from legacy Bot/OA alias mentions.
// Names containing whitespace or ':' must use JSON-style double quotes.
export function parseChatRoute(input) {
  if (typeof input !== 'string') return invalid('route-must-be-text');
  const prefix = /^@(line|telegram|discord|slack|whatsapp):/i.exec(input);
  if (!prefix) return invalid('missing-platform-route');
  let offset = prefix[0].length;
  function component() {
    const start = offset;
    if (input[offset] === '"') {
      offset++;
      let escaped = false;
      while (offset < input.length) {
        const char = input[offset++];
        if (!escaped && char === '"') {
          const value = JSON.parse(input.slice(start, offset));
          if (!value.trim() || /[\r\n\u0000]/.test(value)) throw new Error();
          return value;
        }
        if (!escaped && char === '\\') escaped = true;
        else escaped = false;
      }
      throw new Error();
    }
    while (offset < input.length && !/[\s:"]/.test(input[offset])) offset++;
    const value = input.slice(start, offset);
    if (!value || /[\\\u0000]/.test(value)) throw new Error();
    return value;
  }
  try {
    const chatName = component();
    let memberName = null;
    if (input[offset] === ':') { offset++; memberName = component(); }
    if (offset < input.length && !/\s/.test(input[offset])) return invalid('malformed-route');
    const text = input.slice(offset).replace(/^\s+/, '');
    return { status: 'parsed', platform: prefix[1].toLowerCase(), chatName, memberName, text };
  } catch { return invalid('malformed-route'); }
}

const exactId = value => typeof value === 'string' && value.trim().length > 0;
const validChat = chat => chat && platforms.has(chat.platform) && exactId(chat.accountId) && exactId(chat.chatId);
const chatKey = chat => JSON.stringify([chat.platform, chat.accountId, chat.chatId]);
const isCompose = source => source?.kind === 'compose' && exactId(source.draftId);
const isSelection = source => source?.kind === 'selection' && exactId(source.selectionId) && source.captureRevision === 1 &&
  platforms.has(source.platform) && exactId(source.chatName) && source.provenance === 'user-confirmed-selection' &&
  /^[a-f0-9]{64}$/.test(source.textDigest ?? '') && Number.isSafeInteger(source.capturedAt) && source.capturedAt >= 0;
const isForward = source => !['compose', 'selection'].includes(source?.kind) && validChat(source) && exactId(source.messageId);
const validSource = source => isCompose(source) || isSelection(source) || isForward(source);
const sourceKey = source => isCompose(source) ? ['compose', source.draftId] : isSelection(source) ? ['selection', source.selectionId, source.captureRevision] : ['forward', source.platform, source.accountId, source.chatId, source.messageId];

// resolveChat/resolveMember return arrays of exact adapter-owned IDs. Display
// names never become IDs, and ambiguity is rejected rather than picking first.
// No production personal-account adapter is supplied by this module.
export async function prepareForward({ route, source, attachments = [], trace = null }, adapter) {
  if (route?.status !== 'parsed' || !platforms.has(route.platform) || !exactId(route.chatName) ||
      typeof route.text !== 'string' || (route.memberName !== null && !exactId(route.memberName)) ||
      !validSource(source)) return invalid('missing-exact-source-or-route');
  if (isSelection(source) && (trace !== null || createHash('sha256').update(route.text).digest('hex') !== source.textDigest)) return invalid('selection-content-or-trace-mismatch');
  if (!Array.isArray(attachments)) return invalid('invalid-attachments');
  if (attachments.some(a => !a || !exactId(a.id) || !exactId(a.name) || !exactId(a.mimeType) || !Number.isSafeInteger(a.size) || a.size < 0)) return invalid('invalid-attachment-manifest');
  if (!route.text.trim() && !attachments.length) return invalid('empty-message');
  if (!adapter || adapter.platform !== route.platform || adapter.accountKind !== 'personal' ||
      !adapter.capabilities?.sendText || typeof adapter.resolveChat !== 'function' || typeof adapter.execute !== 'function') {
    return { status: 'unsupported', reason: 'personal-chat-adapter-unavailable' };
  }
  if (route.memberName && (!adapter.capabilities.nativeMention || typeof adapter.resolveMember !== 'function')) return { status: 'unsupported', reason: 'native-mention-unavailable' };
  if (attachments.length && !adapter.capabilities.attachments) return { status: 'unsupported', reason: 'attachments-unavailable' };
  const chats = await adapter.resolveChat(route.chatName);
  if (!Array.isArray(chats) || chats.length !== 1) return { status: 'unresolved', reason: chats?.length ? 'ambiguous-chat' : 'chat-not-found' };
  const target = chats[0];
  if (!validChat(target) || target.platform !== route.platform) return invalid('adapter-returned-invalid-chat');
  let mention = null;
  if (route.memberName) {
    const members = await adapter.resolveMember(target, route.memberName);
    if (!Array.isArray(members) || members.length !== 1) return { status: 'unresolved', reason: members?.length ? 'ambiguous-member' : 'member-not-found' };
    if (!exactId(members[0]?.memberId)) return invalid('adapter-returned-invalid-member');
    mention = { memberId: members[0].memberId, required: true };
  }
  if (isCompose(source) && trace !== null) return invalid('compose-cannot-carry-forward-trace');
  const origin = trace?.origin ?? source;
  const visited = trace?.visited ?? [];
  if (!validSource(origin) || isSelection(trace?.origin) || !Array.isArray(visited) || visited.some(c => !validChat(c))) return invalid('invalid-forward-trace');
  if (visited.length >= 8 || [source, origin, ...visited].filter(validChat).some(c => chatKey(c) === chatKey(target))) return { status: 'blocked', reason: 'forward-loop' };
  const dedupeKey = createHash('sha256').update(JSON.stringify([sourceKey(origin), target.platform, target.accountId, target.chatId, mention?.memberId ?? null])).digest('hex');
  return { status: 'prepared', plan: { version: 1, source: { ...source }, target: { ...target }, mention,
    text: route.text, attachments: structuredClone(attachments), dedupeKey,
    trace: { origin: { ...origin }, visited: [...visited.map(c => ({ ...c })), ...(isForward(source) ? [{ ...source }] : [])] } } };
}

// ledger.claim MUST atomically and durably reserve a key before any UI action;
// unknown submissions stay reserved until reconciled against the target chat.
// This is an adapter integration seam, not an installed personal-chat adapter.
export async function executeForward(prepared, adapter, ledger) {
  const plan = prepared?.plan;
  if (prepared?.status !== 'prepared' || !plan || plan.version !== 1 || !validChat(plan.target) ||
      !validSource(plan.source) || typeof plan.text !== 'string' ||
      !Array.isArray(plan.attachments) || plan.attachments.some(a => !a || !exactId(a.id) || !exactId(a.name) || !exactId(a.mimeType) || !Number.isSafeInteger(a.size) || a.size < 0) ||
      (!plan.text.trim() && !plan.attachments.length) ||
      (plan.mention !== null && (!plan.mention || !exactId(plan.mention.memberId) || plan.mention.required !== true)) ||
      !validSource(plan.trace?.origin) ||
      !Array.isArray(plan.trace?.visited) || plan.trace.visited.some(c => !validChat(c)) || plan.trace.visited.length > 8 ||
      [plan.source, plan.trace.origin, ...plan.trace.visited].filter(validChat).some(c => chatKey(c) === chatKey(plan.target))) return invalid('invalid-prepared-plan');
  if (isSelection(plan.source) && (createHash('sha256').update(plan.text).digest('hex') !== plan.source.textDigest ||
      JSON.stringify(plan.source) !== JSON.stringify(plan.trace.origin) || plan.trace.visited.length)) return invalid('invalid-prepared-plan');
  const expectedKey = createHash('sha256').update(JSON.stringify([sourceKey(plan.trace.origin), plan.target.platform, plan.target.accountId, plan.target.chatId, plan.mention?.memberId ?? null])).digest('hex');
  if (plan.dedupeKey !== expectedKey) return invalid('invalid-prepared-plan');
  if (prepared?.status !== 'prepared' || !plan || !adapter ||
      adapter.platform !== plan.target.platform || adapter.accountKind !== 'personal' ||
      typeof adapter.execute !== 'function' || !adapter.capabilities?.sendText ||
      (plan.mention && !adapter.capabilities.nativeMention) ||
      (plan.attachments.length && !adapter.capabilities.attachments)) return { status: 'unsupported', reason: 'adapter-capabilities-changed' };
  if (typeof ledger?.claim !== 'function' || typeof ledger?.settle !== 'function') return invalid('durable-delivery-ledger-required');
  // Throwing here prevents sending when the durable store is unavailable.
  if (!await ledger.claim(plan.dedupeKey)) return { status: 'duplicate' };
  let receipt;
  try { receipt = await adapter.execute(structuredClone(plan)); }
  catch {
    await ledger.settle(plan.dedupeKey, { status: 'unknown' });
    return { status: 'unknown', reason: 'reconcile-before-retry' };
  }
  // Clicking Send alone is insufficient: identify the submitted target message
  // and verify a requested mention was actually selected as a native member.
  if (!receipt || !exactId(receipt.messageId) || !validChat(receipt.target) ||
      chatKey(receipt.target) !== chatKey(plan.target) ||
      (plan.mention && (!Array.isArray(receipt.nativeMentionIds) || !receipt.nativeMentionIds.includes(plan.mention.memberId))) ||
      (plan.attachments.length && (!Array.isArray(receipt.attachmentIds) || plan.attachments.some(a => !receipt.attachmentIds.includes(a.id))))) {
    await ledger.settle(plan.dedupeKey, { status: 'unknown' });
    return { status: 'unknown', reason: 'submission-not-confirmed' };
  }
  const result = { status: 'submitted', receipt: structuredClone(receipt) };
  await ledger.settle(plan.dedupeKey, result);
  return result; // Submitted is not recipient-delivered/read.
}
