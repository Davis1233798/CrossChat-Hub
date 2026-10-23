'use strict';

function createSessionReset({ getService, getSession, confirm, destroyWriters, revokePermissions, onState, isClosing,
  initialBlocked = [], persistIntent = () => {}, clearIntent = () => {} }) {
  const pending = new Map();
  const blocked = new Set(initialBlocked);
  const active = new Set();
  function request(id) {
    const service = getService(id);
    if (!service || service.kind !== 'web' || !service.partition?.startsWith('persist:crosschat-')) {
      return Promise.reject(new Error('Unsupported service'));
    }
    if (isClosing()) return Promise.resolve({ state: 'cancelled' });
    if (pending.has(id)) return pending.get(id);
    const work = Promise.resolve().then(async () => {
      if (!await confirm(service) || isClosing()) return { state: 'cancelled' };
      blocked.add(id);
      onState(id, 'resetting');
      const clearing = Promise.resolve().then(async () => {
        await persistIntent(service.id);
        const isolated = getSession(service);
        // Keep background requests from recreating cookies while the profile clears.
        isolated.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
        destroyWriters(service);
        revokePermissions(id);
        await isolated.closeAllConnections();
        await isolated.clearAuthCache();
        await isolated.clearData();
        isolated.flushStorageData();
        await isolated.cookies.flushStore();
        await clearIntent(service.id);
        if (!isClosing()) isolated.webRequest.onBeforeRequest(null);
        blocked.delete(id);
      });
      active.add(clearing);
      try {
        await clearing;
        onState(id, 'cleared');
        return { state: 'cleared' };
      } catch {
        // Keep the failed profile blocked; only an explicit retry may reopen it.
        onState(id, 'reset-error');
        return { state: 'reset-error' };
      } finally { active.delete(clearing); }
    }).finally(() => pending.delete(id));
    pending.set(id, work);
    return work;
  }
  return {
    request,
    isBlocked: id => blocked.has(id),
    isPending: id => pending.has(id),
    waitForActive: () => Promise.allSettled([...active]),
  };
}
module.exports = { createSessionReset };
