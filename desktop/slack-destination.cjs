'use strict';

const { randomUUID } = require('node:crypto');

// Slack documents conversation IDs with C/G/D prefixes and gives
// https://app.slack.com/client/{workspace}/{conversation} as its deep-link
// shape. The URL carries no display name; this parser never invents one.
// https://docs.slack.dev/messaging/formatting-message-text/ documents the
// app.slack.com/client/{id}/{channel-id} example; it uses an E-prefixed first
// segment without defining its type. Only T-prefixed workspace IDs are
// accepted, as documented by the deep-link guide. E-prefixed routes stay unknown.
// https://docs.slack.dev/interactivity/deep-linking/
// https://docs.slack.dev/apis/web-api/using-the-conversations-api/
function parseSlackDestinationUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'app.slack.com' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const match = /^\/client\/(T[A-Z0-9]+)\/([CGD][A-Z0-9]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  return Object.freeze({ teamId: match[1], conversationId: match[2] });
}

function createSlackDestinationSnapshots({ getSlackView, getActiveSlackView, isBlocked = () => false,
    getPartition = () => null, now = Date.now, ttlMs = 5 * 60_000, makeId = randomUUID, onInvalidate = () => {} } = {}) {
  let revision = 0;
  let completed = null;
  const selections = new Map();
  const clear = () => {
    revision++;
    completed = null;
    selections.clear();
    onInvalidate();
  };
  function validView(view) {
    return Boolean(view && view === getSlackView?.() && !view.isDestroyed?.() && !isBlocked());
  }
  function currentMatches(snapshot, view) {
    if (!snapshot || !validView(view) || view !== snapshot.view || view.webContents !== snapshot.webContents ||
        view.webContents.id !== snapshot.webContentsId || getPartition() !== snapshot.partition) return false;
    const live = parseSlackDestinationUrl(view.webContents.getURL());
    return Boolean(live && live.teamId === snapshot.teamId && live.conversationId === snapshot.conversationId &&
      new URL(view.webContents.getURL()).origin === snapshot.origin);
  }
  function expire() {
    for (const [id, item] of selections) if (item.expiresAt <= now()) selections.delete(id);
  }
  function publicLocation(snapshot) {
    return { status: 'identified', teamId: snapshot.teamId, conversationId: snapshot.conversationId,
      label: null, labelStatus: 'unknown-from-url', source: 'official-slack-tab-url' };
  }
  return {
    navigationStarted(webContents, isMainFrame = true) {
      if (isMainFrame && webContents === getSlackView?.()?.webContents) clear();
    },
    navigationCompleted(webContents, value, isMainFrame = true) {
      if (!isMainFrame || webContents !== getSlackView?.()?.webContents) return false;
      const view = getSlackView();
      const parsed = parseSlackDestinationUrl(value);
      let liveUrl;
      try { liveUrl = new URL(webContents.getURL()); } catch { liveUrl = null; }
      if (!parsed || !liveUrl || liveUrl.href !== new URL(value).href || !validView(view)) { clear(); return false; }
      revision++;
      selections.clear();
      completed = { revision, view, webContents, webContentsId: webContents.id, partition: getPartition(),
        origin: liveUrl.origin, teamId: parsed.teamId, conversationId: parsed.conversationId, completedAt: now() };
      return true;
    },
    inspectCurrent() {
      const view = getActiveSlackView?.();
      if (!completed || !view || !currentMatches(completed, view)) return { status: 'unknown' };
      return publicLocation(completed);
    },
    selectCurrent() {
      expire();
      const view = getActiveSlackView?.();
      if (!completed || !view || !currentMatches(completed, view)) return { status: 'unknown' };
      const selectionId = makeId();
      selections.set(selectionId, { ...completed, expiresAt: now() + ttlMs });
      return { ...publicLocation(completed), selectionId };
    },
    validateSelection(selectionId) {
      expire();
      const selected = selections.get(selectionId);
      if (!selected || selected.revision !== completed?.revision || !currentMatches(selected, getSlackView?.())) {
        if (selected) selections.delete(selectionId);
        return { status: 'stale' };
      }
      return { ...publicLocation(selected), selectionId };
    },
    invalidate() { clear(); },
    get revision() { return revision; },
  };
}

module.exports = { parseSlackDestinationUrl, createSlackDestinationSnapshots };
