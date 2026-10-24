import test from 'node:test';
import assert from 'node:assert/strict';
import { createForwardingDrafts } from '../desktop/forwarding-drafts.mjs';

const text = '@line:測試群:小明 Hello';
function fixture(options = {}) {
  let calls = 0, target = { platform: 'line', accountId: 'a', chatId: 'chat' };
  const adapter = { platform: 'line', accountKind: 'personal', capabilities: { sendText: true, nativeMention: true },
    resolveChat: async () => [target], resolveMember: async () => [{ memberId: 'member' }],
    execute: async () => { calls++; return { messageId: 'message', target, nativeMentionIds: ['member'] }; } };
  const claims = new Set();
  const ledger = { claim: key => { if (claims.has(key)) return false; claims.add(key); return true; }, settle() {} };
  const service = createForwardingDrafts({ adapterFor: () => adapter, ledger, ...options });
  return { service, calls: () => calls, changeTarget: () => { target = { ...target, chatId: 'other' }; } };
}
test('missing personal adapter returns parsed preview, never dispatches', async () => {
  const service = createForwardingDrafts();
  const draft = await service.prepare({ text });
  assert.equal(draft.status, 'unsupported'); assert.equal(draft.preview.chatName, '測試群');
  assert.equal((await service.execute(draft.draftId, draft.revision)).status, 'unsupported');
  assert.equal('plan' in draft, false); assert.equal('target' in draft, false);
});
test('renderer cannot supply plans or exact target IDs; opaque IDs and expiry reject', async () => {
  let time = 0; const { service, calls } = fixture({ now: () => time, ttlMs: 100 });
  assert.equal((await service.prepare({ text, plan: {} })).status, 'rejected');
  assert.equal((await service.prepare({ text, target: 'chat' })).status, 'rejected');
  assert.equal((await service.execute('guessed', 1)).status, 'rejected');
  const draft = await service.prepare({ text }); time = 101;
  assert.equal((await service.execute(draft.draftId, draft.revision)).status, 'rejected'); assert.equal(calls(), 0);
});
test('editing invalidates prior revision, and execution is single use', async () => {
  const { service, calls } = fixture();
  const first = await service.prepare({ text });
  const second = await service.prepare({ text: text + ' again', draftId: first.draftId, revision: first.revision });
  assert.equal(second.revision, 2);
  assert.equal((await service.execute(first.draftId, first.revision)).status, 'rejected');
  const result = await Promise.all([service.execute(second.draftId, second.revision), service.execute(second.draftId, second.revision)]);
  assert.deepEqual(result.map(r => r.status).sort(), ['rejected', 'submitted']); assert.equal(calls(), 1);
  assert.equal((await service.prepare({ text, draftId: second.draftId, revision: second.revision })).status, 'rejected');
});
test('recipient changes never automatically redirect a prepared draft', async () => {
  const { service, changeTarget, calls } = fixture();
  const draft = await service.prepare({ text }); changeTarget();
  assert.equal((await service.execute(draft.draftId, draft.revision)).reason, 'recipient-changed'); assert.equal(calls(), 0);
});
test('late prepare completion cannot overwrite a newer revision', async () => {
  let release, delay = false;
  const gate = new Promise(resolve => release = resolve);
  const service = createForwardingDrafts({ adapterFor: async () => { if (delay) await gate; return null; } });
  const first = await service.prepare({ text }); delay = true;
  const pending = service.prepare({ text: text + ' old', draftId: first.draftId, revision: 1 });
  const newest = await service.prepare({ text: 'bad syntax', draftId: first.draftId, revision: 2 });
  assert.equal(newest.revision, 3); release();
  assert.equal((await pending).reason, 'draft-superseded');
  assert.equal((await service.execute(first.draftId, 2)).status, 'rejected');
});
