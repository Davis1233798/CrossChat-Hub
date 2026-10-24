'use strict';
const { randomBytes } = require('node:crypto');
const ARM_TTL_MS = 30_000;
const DELIVERY_TTL_MS = 10_000;
const SELECTION_ACCELERATOR = 'CommandOrControl+Shift+Alt+S';

function createSelectionArming({ register, unregister, isBound, capture, discard = () => {}, onResult,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random = randomBytes } = {}) {
  let current = null, generation = 0;
  const pendingDeliveries = new Map();
  function discardResult(result) {
    if (result?.status !== 'captured' || typeof result.selectionId !== 'string' || !Number.isSafeInteger(result.captureRevision)) return;
    try { void discard({ selectionId: result.selectionId, captureRevision: result.captureRevision }); } catch {}
  }
  function removePending(armId, revoke = true) {
    const pending = pendingDeliveries.get(armId);
    if (!pending) return;
    clearTimer(pending.timer);
    pendingDeliveries.delete(armId);
    if (revoke) discardResult(pending.result);
  }
  function clear() {
    generation++;
    if (!current) return;
    clearTimer(current.timer);
    if (current.active) { try { unregister(SELECTION_ACCELERATOR); } catch {} }
    current = null;
  }
  async function trigger() {
    const armed = current;
    if (!armed?.active) return;
    clearTimer(armed.timer);
    try { unregister(SELECTION_ACCELERATOR); } catch {}
    current = null;
    const requestGeneration = generation;
    let result;
    try { result = await capture({ platform: 'line', chatName: armed.chatName }); }
    catch { result = { status: 'unsupported', reason: 'selection-observation-unavailable' }; }
    if (requestGeneration !== generation || armed !== current && current !== null || armed.cancelled) {
      discardResult(result); return;
    }
    if (result?.status === 'captured') {
      const pending = { result, timer: null };
      pending.timer = setTimer(() => removePending(armed.id), DELIVERY_TTL_MS);
      pendingDeliveries.set(armed.id, pending);
    }
    try { onResult({ armId: armed.id, ...result }); }
    catch { removePending(armed.id); }
  }
  return {
    async arm(input) {
      clear();
      const requestGeneration = generation;
      if (!input || Object.keys(input).sort().join(',') !== 'chatName,platform' || input.platform !== 'line' ||
          typeof input.chatName !== 'string' || !input.chatName.trim() || input.chatName.length > 512) return { status: 'rejected' };
      let bound = false;
      try { bound = await isBound(); } catch {}
      if (requestGeneration !== generation) return { status: 'cancelled' };
      if (!bound) return { status: 'unavailable', reason: 'line-window-not-bound' };
      const id = random(16).toString('hex');
      const armed = { id, requestArmId: id, chatName: input.chatName, timer: null, cancelled: false, active: false };
      current = armed;
      armed.timer = setTimer(() => {
        if (current !== armed) return;
        clear();
        onResult({ armId: id, status: 'expired', reason: 'selection-arm-expired' });
      }, ARM_TTL_MS);
      return { status: 'prepared', armId: id, expiresAt: now() + ARM_TTL_MS };
    },
    activate(input) {
      if (!input || Object.keys(input).length !== 1 || typeof input.armId !== 'string') return { status: 'rejected' };
      const armed = current;
      if (!armed || armed.id !== input.armId || armed.active) return { status: 'cancelled' };
      armed.active = true;
      let registered = false;
      try { registered = register(SELECTION_ACCELERATOR, () => { void trigger(); }) === true; } catch {}
      if (!registered) { armed.active = false; if (current === armed) clear(); return { status: 'conflict', reason: 'shortcut-unavailable' }; }
      return { status: 'armed', armId: armed.id };
    },
    acknowledge(input) {
      if (!input || Object.keys(input).sort().join(',') !== 'armId,captureRevision,selectionId' ||
          typeof input.armId !== 'string' || typeof input.selectionId !== 'string' || !Number.isSafeInteger(input.captureRevision)) return { status: 'rejected' };
      const pending = pendingDeliveries.get(input.armId);
      if (!pending || pending.result.selectionId !== input.selectionId || pending.result.captureRevision !== input.captureRevision) return { status: 'rejected' };
      removePending(input.armId, false);
      return { status: 'accepted' };
    },
    cancel(input) {
      if (input !== undefined && (!input || Object.keys(input).length !== 1 || typeof input.armId !== 'string')) return { status: 'rejected' };
      if (current && input?.armId !== undefined && input.armId !== current.id) return { status: 'rejected' };
      if (input?.armId !== undefined) removePending(input.armId);
      if (current) current.cancelled = true;
      clear();
      return { status: 'cancelled' };
    },
    close() {
      if (current) current.cancelled = true;
      clear();
      for (const armId of pendingDeliveries.keys()) removePending(armId);
    },
    state() { return current ? { armed: true, armId: current.id, active: current.active } : { armed: false }; },
  };
}
module.exports = { createSelectionArming, SELECTION_ACCELERATOR, SELECTION_ARM_TTL_MS: ARM_TTL_MS, SELECTION_DELIVERY_TTL_MS: DELIVERY_TTL_MS };
