import { randomUUID, createHash } from 'node:crypto';
import { parseChatRoute, prepareForward, executeForward } from '../src/forwarding.mjs';

// Main-process-only service. Renderer values are commands, never resolved plans.
export function createForwardingDrafts({ adapterFor = () => null, observeSelection = async () => ({ status: 'unsupported', reason: 'selection-window-not-bound' }), ledger, now = Date.now, ttlMs = 300000, maxDrafts = 100, validateDestination = () => null } = {}) {
  const drafts = new Map();
  const selections = new Map();
  const rejected = reason => ({ status: 'rejected', reason });
  function lookup(id, revision) {
    const draft = typeof id === 'string' ? drafts.get(id) : null;
    if (!draft || draft.expiresAt <= now()) { if (draft) drafts.delete(id); return null; }
    return draft.revision === revision ? draft : null;
  }
  function summary(draft) {
    return { draftId: draft.id, revision: draft.revision, status: draft.result.status,
      ...(draft.result.reason ? { reason: draft.result.reason } : {}),
      ...(draft.source?.kind === 'selection' ? { source: { provenance: draft.source.provenance, platform: draft.source.platform, chatName: draft.source.chatName } } : {}),
      ...(draft.route.status === 'parsed' ? { preview: { platform: draft.route.platform, chatName: draft.route.chatName,
        memberName: draft.route.memberName, text: draft.route.text } } : {}) };
  }
  function expire() {
    for (const [id, draft] of drafts) if (draft.expiresAt <= now()) drafts.delete(id);
    for (const [id, selection] of selections) if (selection.expiresAt <= now()) selections.delete(id);
  }
    async function prepare(input, selection = null) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['text', 'draftId', 'revision', 'slackDestinationSelectionId'].includes(k)) ||
          typeof input.text !== 'string' || input.text.length > 16000 ||
          (input.slackDestinationSelectionId !== undefined && (typeof input.slackDestinationSelectionId !== 'string' || input.slackDestinationSelectionId.length > 128))) return rejected('invalid-draft-input');
      expire();
      let draft;
      if (input.draftId !== undefined || input.revision !== undefined) {
        draft = lookup(input.draftId, input.revision);
        if (!draft || draft.executing || draft.terminal || draft.source?.kind === 'selection') return rejected('draft-unavailable');
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
      draft.destinationSelectionId = draft.route.platform === 'slack' ? input.slackDestinationSelectionId : null;
      draft.source = selection?.source ?? { kind: 'compose', draftId: draft.id };
      if (selection && draft.route.status === 'parsed') draft.route.text = selection.text;
      draft.result = { status: 'preparing' };
      if (draft.route.status !== 'parsed') { draft.result = draft.route; return summary(draft); }
      let result, adapter;
      try {
        const destination = draft.route.platform === 'slack' && typeof input.slackDestinationSelectionId === 'string'
          ? validateDestination(input.slackDestinationSelectionId) : null;
        draft.sourceValid = () => draft.source?.kind !== 'selection' || selections.has(draft.source.selectionId);
        adapter = await adapterFor(draft.route.platform, destination, draft.sourceValid);
        if (draft.route.platform === 'slack' && (!destination || destination.status !== 'identified' || draft.route.chatName !== destination.conversationId)) {
          result = { status: 'unsupported', reason: 'select-exact-slack-destination' };
        } else {
        result = await prepareForward({ route: draft.route, source: draft.source }, adapter);
        }
      } catch { result = { status: 'unsupported', reason: 'adapter-unavailable' }; }
      if (lookup(draft.id, revision) !== draft) return rejected('draft-superseded');
      if (draft.route.platform === 'slack' && result.status === 'prepared' && (!validateDestination(input.slackDestinationSelectionId) || !adapter?.validatePlan?.(result.plan))) return rejected('slack-destination-changed');
      draft.result = result;
      draft.plan = result.status === 'prepared' ? result : null;
      draft.adapter = adapter;
      return summary(draft);
    }
  return {
    listHistory() { return ledger?.listRecent?.(20) ?? []; },
    prepare: input => prepare(input),
    async captureObservedSelection(input) {
      if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['platform', 'chatName'].includes(k)) ||
          !['line', 'slack', 'telegram', 'discord', 'whatsapp'].includes(input.platform) || typeof input.chatName !== 'string' || !input.chatName.trim() || input.chatName.length > 512) return rejected('invalid-observation-input');
      let result;
      try { result = await observeSelection(input.platform); } catch { return { status: 'unsupported', reason: 'selection-observation-unavailable' }; }
      if (result?.status !== 'observed') return { status: 'unsupported', reason: result?.reason ?? 'selection-observation-unavailable' };
      const capture = this.captureSelection({ text: result.text, platform: input.platform, chatName: input.chatName });
      if (capture.status !== 'captured') return capture;
      const selected = selections.get(capture.selectionId);
      selected.source.provenance = 'ui-selected-text-unverified-origin';
      return { ...capture, text: result.text, provenance: selected.source.provenance };
    },
    captureSelection(input) {
      if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['text', 'platform', 'chatName'].includes(k)) ||
          typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000 ||
          !['line', 'telegram', 'discord', 'slack', 'whatsapp'].includes(input.platform) ||
          typeof input.chatName !== 'string' || !input.chatName.trim() || input.chatName.length > 512) return rejected('invalid-selection-input');
      expire(); if (selections.size >= maxDrafts) return rejected('selection-limit');
      const source = { kind: 'selection', selectionId: randomUUID(), captureRevision: 1,
        platform: input.platform, chatName: input.chatName, provenance: 'user-confirmed-selection',
        textDigest: createHash('sha256').update(input.text).digest('hex'), capturedAt: now() };
      selections.set(source.selectionId, { source, text: input.text, expiresAt: now() + ttlMs });
      return { status: 'captured', ...source };
    },
    async prepareSelection(input) {
      if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['selectionId', 'captureRevision', 'routeText', 'slackDestinationSelectionId'].includes(k))) return rejected('invalid-selection-reference');
      expire(); const selected = selections.get(input.selectionId);
      if (!selected || input.captureRevision !== selected.source.captureRevision) return rejected('selection-unavailable');
      const route = parseChatRoute(input.routeText);
      if (route.status !== 'parsed' || route.text) return rejected('selection-route-must-exclude-body');
      // Each call is a new explicit destination preview. Dedupe still covers
      // selection+exact target, allowing a different explicitly chosen target.
      return prepare({ text: input.routeText, ...(input.slackDestinationSelectionId ? { slackDestinationSelectionId: input.slackDestinationSelectionId } : {}) }, selected);
    },
    revokeSelection(input) {
      if (!input || Object.keys(input).some(k => !['selectionId', 'captureRevision'].includes(k))) return rejected('invalid-selection-reference');
      const selected = selections.get(input.selectionId);
      if (!selected || selected.source.captureRevision !== input.captureRevision) return rejected('selection-unavailable');
      selections.delete(input.selectionId);
      for (const [id, draft] of drafts) if (draft.source?.selectionId === input.selectionId) {
        // Revocation during awaited recipient resolution must invalidate the
        // pending send too. Once dispatch starts, its outcome needs reconciliation.
        if (!draft.dispatched) drafts.delete(id);
      }
      return { status: 'revoked' };
    },
    async execute(id, revision) {
      const draft = lookup(id, revision);
      if (!draft || draft.executing || draft.terminal) return rejected('draft-unavailable');
      if (!draft.plan) return { status: 'unsupported', reason: 'draft-not-prepared' };
      draft.executing = true;
      try {
        const destination = draft.route.platform === 'slack' ? draft.destinationSelectionId ? validateDestination(draft.destinationSelectionId) : null : null;
        if (draft.route.platform === 'slack' && (!destination || destination.status !== 'identified' || draft.route.chatName !== destination.conversationId)) return rejected('slack-destination-changed');
        const adapter = draft.adapter;
        const fresh = await prepareForward({ route: draft.route, source: draft.source }, adapter);
        if (lookup(id, revision) !== draft) return rejected('draft-unavailable');
        if (draft.route.platform === 'slack' && (!validateDestination(draft.destinationSelectionId) || !adapter?.validatePlan?.(fresh.plan))) return rejected('slack-destination-changed');
        const identity = result => JSON.stringify([result.plan?.target, result.plan?.mention]);
        if (adapter !== draft.adapter || fresh.status !== 'prepared' || identity(fresh) !== identity(draft.plan)) {
          draft.plan = null;
          return rejected('recipient-changed');
        }
        // Once dispatch starts, do not allow draft edits to create another send.
        draft.terminal = true;
        draft.dispatched = true;
        const result = await executeForward(draft.plan, adapter, ledger);
        // Do not leak adapter receipt/target IDs into the shell.
        return { status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.status === 'submitted' ? { summary: 'Slack 已受理純文字訊息；這是 API 回執，不代表對方已送達或讀取。' } : {}) };
      } catch {
        draft.terminal = true;
        return { status: 'unknown', reason: 'reconcile-before-retry' };
      } finally { draft.executing = false; }
    },
  };
}
