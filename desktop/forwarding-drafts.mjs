import { randomUUID } from 'node:crypto';
import { parseChatRoute, prepareForward, executeForward } from '../src/forwarding.mjs';

// Main-process-only service. Renderer values are commands, never resolved plans.
export function createForwardingDrafts({ adapterFor = () => null, ledger, now = Date.now, ttlMs = 300000, maxDrafts = 100 } = {}) {
  const drafts = new Map();
  const rejected = reason => ({ status: 'rejected', reason });
  function lookup(id, revision) {
    const draft = typeof id === 'string' ? drafts.get(id) : null;
    if (!draft || draft.expiresAt <= now()) { if (draft) drafts.delete(id); return null; }
    return draft.revision === revision ? draft : null;
  }
  function summary(draft) {
    return { draftId: draft.id, revision: draft.revision, status: draft.result.status,
      ...(draft.result.reason ? { reason: draft.result.reason } : {}),
      ...(draft.route.status === 'parsed' ? { preview: { platform: draft.route.platform, chatName: draft.route.chatName,
        memberName: draft.route.memberName, text: draft.route.text } } : {}) };
  }
  function expire() { for (const [id, draft] of drafts) if (draft.expiresAt <= now()) drafts.delete(id); }
  return {
    async prepare(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['text', 'draftId', 'revision'].includes(k)) ||
          typeof input.text !== 'string' || input.text.length > 16000) return rejected('invalid-draft-input');
      expire();
      let draft;
      if (input.draftId !== undefined || input.revision !== undefined) {
        draft = lookup(input.draftId, input.revision);
        if (!draft || draft.executing || draft.terminal) return rejected('draft-unavailable');
        draft.revision++;
      } else {
        if (drafts.size >= maxDrafts) return rejected('draft-limit');
        draft = { id: randomUUID(), revision: 1 };
        drafts.set(draft.id, draft);
      }
      const revision = draft.revision;
      draft.expiresAt = now() + ttlMs;
      draft.plan = null;
      draft.route = parseChatRoute(input.text);
      draft.result = { status: 'preparing' };
      if (draft.route.status !== 'parsed') { draft.result = draft.route; return summary(draft); }
      let result, adapter;
      try {
        adapter = await adapterFor(draft.route.platform);
        result = await prepareForward({ route: draft.route, source: { kind: 'compose', draftId: draft.id } }, adapter);
      } catch { result = { status: 'unsupported', reason: 'adapter-unavailable' }; }
      if (lookup(draft.id, revision) !== draft) return rejected('draft-superseded');
      draft.result = result;
      draft.plan = result.status === 'prepared' ? result : null;
      draft.adapter = adapter;
      return summary(draft);
    },
    async execute(id, revision) {
      const draft = lookup(id, revision);
      if (!draft || draft.executing || draft.terminal) return rejected('draft-unavailable');
      if (!draft.plan) return { status: 'unsupported', reason: 'draft-not-prepared' };
      draft.executing = true;
      try {
        const adapter = await adapterFor(draft.route.platform);
        const fresh = await prepareForward({ route: draft.route, source: { kind: 'compose', draftId: draft.id } }, adapter);
        if (lookup(id, revision) !== draft) return rejected('draft-unavailable');
        const identity = result => JSON.stringify([result.plan?.target, result.plan?.mention]);
        if (adapter !== draft.adapter || fresh.status !== 'prepared' || identity(fresh) !== identity(draft.plan)) {
          draft.plan = null;
          return rejected('recipient-changed');
        }
        // Once dispatch starts, do not allow draft edits to create another send.
        draft.terminal = true;
        const result = await executeForward(draft.plan, adapter, ledger);
        // Do not leak adapter receipt/target IDs into the shell.
        return { status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
      } catch {
        draft.terminal = true;
        return { status: 'unknown', reason: 'reconcile-before-retry' };
      } finally { draft.executing = false; }
    },
  };
}
