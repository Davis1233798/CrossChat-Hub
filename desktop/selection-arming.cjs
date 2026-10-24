'use strict';
const { randomBytes } = require('node:crypto');
const ARM_TTL_MS = 30_000;
const SELECTION_ACCELERATOR = 'CommandOrControl+Shift+Alt+S';

function createSelectionArming({ register, unregister, isBound, capture, onResult, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, random = randomBytes } = {}) {
  let current = null, generation = 0;
  function clear() {
    generation++;
    if (!current) return;
    clearTimer(current.timer);
    try { unregister(SELECTION_ACCELERATOR); } catch {}
    current = null;
  }
  async function trigger() {
    const armed = current;
    if (!armed) return;
    clearTimer(armed.timer);
    try { unregister(SELECTION_ACCELERATOR); } catch {}
    current = null;
    const requestGeneration = generation;
    let result;
    try { result = await capture({ platform: 'line', chatName: armed.chatName }); }
    catch { result = { status: 'unsupported', reason: 'selection-observation-unavailable' }; }
    if (requestGeneration !== generation || armed !== current && current !== null) return;
    // A cancel or a replacement arm invalidates a capture that was still in flight.
    if (armed.cancelled || armed.id !== armed.requestArmId) return;
    onResult({ armId: armed.id, ...result });
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
      const armed = { id, requestArmId: id, chatName: input.chatName, timer: null, cancelled: false };
      const onHotkey = () => { void trigger(); };
      let registered = false;
      try { registered = register(SELECTION_ACCELERATOR, onHotkey) === true; } catch {}
      if (!registered) return { status: 'conflict', reason: 'shortcut-unavailable' };
      current = armed;
      armed.timer = setTimer(() => {
        if (current !== armed) return;
        clear();
        onResult({ armId: id, status: 'expired', reason: 'selection-arm-expired' });
      }, ARM_TTL_MS);
      return { status: 'armed', armId: id, expiresAt: now() + ARM_TTL_MS };
    },
    cancel(input) {
      if (input !== undefined && (!input || Object.keys(input).length !== 1 || typeof input.armId !== 'string')) return { status: 'rejected' };
      if (current && input?.armId !== undefined && input.armId !== current.id) return { status: 'rejected' };
      if (current) current.cancelled = true;
      clear();
      return { status: 'cancelled' };
    },
    close() { if (current) current.cancelled = true; clear(); },
    state() { return current ? { armed: true, armId: current.id } : { armed: false }; },
  };
}
module.exports = { createSelectionArming, SELECTION_ACCELERATOR, SELECTION_ARM_TTL_MS: ARM_TTL_MS };
