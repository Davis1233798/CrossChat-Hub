import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatRoute, prepareForward, executeForward } from '../src/forwarding.mjs';
import { extractMentions } from '../src/bridge.mjs';

const source = { platform: 'telegram', accountId: 'a1', chatId: 'c1', messageId: 'm1' };
const target = { platform: 'line', accountId: 'a2', chatId: 'c2' };
const route = parseChatRoute('@line:測試群:小明 下午好');
const adapter = (changes = {}) => ({ platform: 'line', accountKind: 'personal',
  capabilities: { sendText: true, nativeMention: true, attachments: true },
  resolveChat: async name => name === '測試群' ? [target] : [],
  resolveMember: async (_chat, name) => name === '小明' ? [{ memberId: 'u2' }] : [],
  execute() { throw new Error('Planning must not execute'); }, ...changes });

test('Chinese group route separates native mention requirement from text', () => {
  assert.deepEqual(route, { status: 'parsed', platform: 'line', chatName: '測試群', memberName: '小明', text: '下午好' });
  assert.equal(parseChatRoute('@line:測試群 下午好').memberName, null);
  assert.equal(parseChatRoute('@WhatsApp:群 Hi').platform, 'whatsapp');
});
test('quoted components preserve spaces, colons, quotes and backslashes', () => {
  const result = parseChatRoute(String.raw`@line:"研發 : 台灣":"王 \"小明\"" 請看這裡`);
  assert.equal(result.status, 'parsed');
  assert.equal(result.chatName, '研發 : 台灣');
  assert.equal(result.memberName, '王 "小明"');
  assert.equal(parseChatRoute('@line:"A\\\\B" hello').chatName, 'A\\B');
});
test('malformed routes fail without falling back to legacy alias destinations', () => {
  for (const input of ['@line:', '@line:群:', '@line:群:人:另一人 hi', '@line:"bad', '@line:"A"suffix hi', '@line:"" hi', '@line:"a\\n" hi']) {
    assert.equal(parseChatRoute(input).status, 'invalid', input);
  }
  assert.deepEqual(extractMentions('@line:group:person hi @line:alice'), [{ platform: 'line', alias: 'alice' }]);
});
test('personal UI adapter unavailable is explicit; Bot/OA does not substitute', async () => {
  assert.equal((await prepareForward({ source, route })).reason, 'personal-chat-adapter-unavailable');
  assert.equal((await prepareForward({ source, route }, adapter({ accountKind: 'bot' }))).status, 'unsupported');
  assert.equal((await prepareForward({ source, route }, adapter({ capabilities: { sendText: true } }))).reason, 'native-mention-unavailable');
});
test('prepared plan retains exact IDs and metadata without executing or claiming delivery', async () => {
  const attachment = { id: 'local-file-1', name: '照片.png', mimeType: 'image/png', size: 12 };
  const result = await prepareForward({ source, route, attachments: [attachment] }, adapter());
  assert.equal(result.status, 'prepared');
  assert.deepEqual(result.plan.source, source);
  assert.deepEqual(result.plan.target, target);
  assert.deepEqual(result.plan.mention, { memberId: 'u2', required: true });
  assert.equal(result.plan.text, '下午好');
  assert.deepEqual(result.plan.attachments, [attachment]);
  assert.match(result.plan.dedupeKey, /^[a-f0-9]{64}$/);
  attachment.name = 'changed';
  assert.equal(result.plan.attachments[0].name, '照片.png');
});
test('ambiguous group/member names and missing attachments capability fail closed', async () => {
  assert.equal((await prepareForward({ source, route }, adapter({ resolveChat: async () => [target, { ...target, chatId: 'c3' }] }))).reason, 'ambiguous-chat');
  assert.equal((await prepareForward({ source, route }, adapter({ resolveMember: async () => [{ memberId: 'x' }, { memberId: 'y' }] }))).reason, 'ambiguous-member');
  assert.equal((await prepareForward({ source, route, attachments: [{ id: 'f', name: 'f', mimeType: 'image/png', size: 1 }] }, adapter({ capabilities: { sendText: true, nativeMention: true } }))).reason, 'attachments-unavailable');
  assert.equal((await prepareForward({ source, route, attachments: [{}] }, adapter())).status, 'invalid');
});
test('source, origin and visited chats block forwarding loops; retries keep dedupe key', async () => {
  const first = await prepareForward({ source, route }, adapter());
  const repeat = await prepareForward({ source, route }, adapter());
  assert.equal(first.plan.dedupeKey, repeat.plan.dedupeKey);
  for (const trace of [{ origin: source, visited: [target] }, { origin: { ...target, messageId: 'original' }, visited: [] }]) {
    assert.equal((await prepareForward({ source, route, trace }, adapter())).reason, 'forward-loop');
  }
  assert.equal((await prepareForward({ source: { ...target, messageId: 'm2' }, route }, adapter())).reason, 'forward-loop');
  assert.equal((await prepareForward({ source: { ...source, messageId: '' }, route }, adapter())).status, 'invalid');
});

test('execution requires ledger, atomically deduplicates and reports submission only', async () => {
  let calls = 0;
  const claimed = new Set();
  const settled = [];
  // Test-only store; production needs durable atomic persistence.
  const ledger = { claim: async key => {
    if (claimed.has(key)) return false;
    claimed.add(key); return true;
  }, settle: async (...args) => settled.push(args) };
  const client = adapter({ execute: async () => { calls++; return { target, messageId: 'posted1', nativeMentionIds: ['u2'] }; } });
  const prepared = await prepareForward({ source, route }, client);
  assert.equal((await executeForward(prepared, client)).reason, 'durable-delivery-ledger-required');
  const results = await Promise.all([executeForward(prepared, client, ledger), executeForward(prepared, client, ledger)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['duplicate', 'submitted']);
  assert.equal(calls, 1);
  assert.equal(settled[0][1].status, 'submitted');
});
test('ambiguous send outcomes and missing native mention receipt never become success', async () => {
  for (const execute of [async () => { throw new Error('timeout after click'); }, async () => ({ target, messageId: 'm' })]) {
    const client = adapter({ execute });
    const prepared = await prepareForward({ source, route }, client);
    let claimed = false;
    const ledger = { claim: async () => { if (claimed) return false; claimed = true; return true; }, settle: async (_key, result) => assert.equal(result.status, 'unknown') };
    assert.equal((await executeForward(prepared, client, ledger)).status, 'unknown');
    assert.equal((await executeForward(prepared, client, ledger)).status, 'duplicate');
  }
});

test('Hub compose uses a local draft origin instead of inventing a platform message', async () => {
  const localSource = { kind: 'compose', draftId: 'local-draft-1' };
  const result = await prepareForward({ source: localSource, route }, adapter());
  assert.equal(result.status, 'prepared');
  assert.deepEqual(result.plan.source, localSource);
  assert.deepEqual(result.plan.trace, { origin: localSource, visited: [] });
  assert.equal((await prepareForward({ source: localSource, route }, adapter())).plan.dedupeKey, result.plan.dedupeKey);
  assert.notEqual((await prepareForward({ source: { kind: 'compose', draftId: 'local-draft-2' }, route }, adapter())).plan.dedupeKey, result.plan.dedupeKey);
  assert.notEqual((await prepareForward({ source, route }, adapter())).plan.dedupeKey, result.plan.dedupeKey);
  assert.equal((await prepareForward({ source: { kind: 'compose', draftId: '' }, route }, adapter())).status, 'invalid');
  assert.equal((await prepareForward({ source: localSource, route, trace: { origin: source, visited: [] } }, adapter())).status, 'invalid');
});
test('forwarding a Hub-originated message preserves local origin and actual visited chat', async () => {
  const origin = { kind: 'compose', draftId: 'original-local-draft' };
  const result = await prepareForward({ source, route, trace: { origin, visited: [] } }, adapter());
  assert.equal(result.status, 'prepared');
  assert.deepEqual(result.plan.trace, { origin, visited: [source] });
  const firstCompose = await prepareForward({ source: origin, route }, adapter());
  assert.equal(firstCompose.plan.dedupeKey, result.plan.dedupeKey);
});
test('malformed or inconsistent prepared plans fail before ledger claim or execute', async () => {
  let claims = 0, sends = 0;
  const client = adapter({ execute: async () => { sends++; } });
  const ledger = { claim() { claims++; return true; }, settle() {} };
  const original = await prepareForward({ source, route }, client);
  for (const change of [p => { p.dedupeKey = 'bad'; }, p => { p.target.chatId = 'changed'; }, p => { p.attachments = null; }, p => { p.mention.required = false; }, p => { p.trace = null; }]) {
    const malformed = structuredClone(original); change(malformed.plan);
    assert.equal((await executeForward(malformed, client, ledger)).reason, 'invalid-prepared-plan');
  }
  assert.equal(claims, 0); assert.equal(sends, 0);
});
