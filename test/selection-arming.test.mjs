import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createForwardingDrafts } from '../desktop/forwarding-drafts.mjs';
const { createSelectionArming, SELECTION_ACCELERATOR, SELECTION_ARM_TTL_MS } = createRequire(import.meta.url)('../desktop/selection-arming.cjs');

function setup({ bound = true, registration = true, immediate = false, capture = async () => ({ status: 'captured', text: 'owned selection', selectionId: 'sel', captureRevision: 1 }), discard = () => {} } = {}) {
  let callback = null, timerCallback = null, unregistered = 0, delivered = [], discarded = [];
  const arm = createSelectionArming({
    register: (key, fn) => { assert.equal(key, SELECTION_ACCELERATOR); callback = fn; if (immediate) fn(); return registration; },
    unregister: key => { assert.equal(key, SELECTION_ACCELERATOR); callback = null; unregistered++; },
    isBound: async () => bound,
    capture,
    discard: ref => { discarded.push(ref); return discard(ref); },
    onResult: value => delivered.push(value),
    setTimer: fn => { timerCallback = fn; return 1; }, clearTimer: () => {}, now: () => 100,
    random: () => Buffer.alloc(16, 3),
  });
  return { arm, callback: () => callback, timeout: () => timerCallback, delivered, discarded, unregistered: () => unregistered };
}

test('arming uses fixed temporary shortcut, captures once, and unregisters before delivery', async () => {
  const f = setup();
  const result = await f.arm.arm({ platform: 'line', chatName: '我填的來源' });
  assert.equal(result.status, 'prepared'); assert.equal(result.expiresAt, 100 + SELECTION_ARM_TTL_MS);
  assert.equal(f.arm.state().armId, result.armId);
  assert.equal(f.callback(), null);
  assert.equal(f.arm.activate({ armId: result.armId }).status, 'armed');
  const trigger = f.callback(); assert.equal(typeof trigger, 'function'); trigger();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.unregistered(), 1);
  assert.deepEqual(f.delivered, [{ armId: result.armId, status: 'captured', text: 'owned selection', selectionId: 'sel', captureRevision: 1 }]);
  assert.equal(f.arm.acknowledge({ armId: result.armId, selectionId: 'other', captureRevision: 1 }).status, 'rejected');
  assert.equal(f.arm.acknowledge({ armId: result.armId, selectionId: 'sel', captureRevision: 1 }).status, 'accepted');
  assert.deepEqual(f.delivered.length, 1);
  assert.equal(f.callback(), null);
});

test('unacknowledged delivered capture is revoked by main after its bounded delivery window', async () => {
  const f = setup();
  const prepared = await f.arm.arm({ platform: 'line', chatName: '群' });
  f.arm.activate({ armId: prepared.armId });
  f.callback()();
  await new Promise(resolve => setImmediate(resolve));
  f.timeout()();
  assert.deepEqual(f.discarded, [{ selectionId: 'sel', captureRevision: 1 }]);
  assert.equal(f.arm.acknowledge({ armId: prepared.armId, selectionId: 'sel', captureRevision: 1 }).status, 'rejected');
});

test('arm requires a bound LINE source and reports shortcut conflicts', async () => {
  assert.equal((await setup({ bound: false }).arm.arm({ platform: 'line', chatName: '群' })).reason, 'line-window-not-bound');
  const conflict = setup({ registration: false });
  const prepared = await conflict.arm.arm({ platform: 'line', chatName: '群' });
  assert.equal(conflict.arm.activate({ armId: prepared.armId }).reason, 'shortcut-unavailable');
  assert.equal((await setup().arm.arm({ platform: 'slack', chatName: '群' })).status, 'rejected');
  assert.equal((await setup().arm.arm({ platform: 'line', chatName: '群', hwnd: 'renderer supplied' })).status, 'rejected');
});

test('timeout, explicit cancel, and close unregister only the feature shortcut', async () => {
  for (const end of ['timeout', 'cancel', 'close']) {
    const f = setup();
    const armed = await f.arm.arm({ platform: 'line', chatName: '群' });
    f.arm.activate({ armId: armed.armId });
    if (end === 'timeout') f.timeout()();
    if (end === 'cancel') assert.equal(f.arm.cancel({ armId: armed.armId }).status, 'cancelled');
    if (end === 'close') f.arm.close();
    assert.equal(f.arm.state().armed, false);
    assert.equal(f.unregistered(), 1);
  }
});

test('cancellation invalidates an in-flight observed selection', async () => {
  let finish;
  const f = setup({ capture: () => new Promise(resolve => { finish = resolve; }) });
  const armed = await f.arm.arm({ platform: 'line', chatName: '群' });
  f.arm.activate({ armId: armed.armId });
  f.callback()();
  f.arm.cancel({ armId: armed.armId });
  finish({ status: 'captured', text: 'must not escape after cancel' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.delivered, []);
});

test('stale deferred draft capture is revoked and cannot be reused', async () => {
  let resolveObservation;
  const drafts = createForwardingDrafts({ observeSelection: () => new Promise(resolve => { resolveObservation = resolve; }) });
  const f = setup({ capture: input => drafts.captureObservedSelection(input), discard: ref => drafts.revokeSelection(ref) });
  const prepared = await f.arm.arm({ platform: 'line', chatName: '人填來源' });
  f.arm.activate({ armId: prepared.armId });
  f.callback()();
  f.arm.cancel({ armId: prepared.armId });
  resolveObservation({ status: 'observed', text: '已取消的私有文字' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.delivered, []);
  const reuse = await drafts.prepareSelection({ selectionId: 'unknown', captureRevision: 1, routeText: '@slack:目標' });
  assert.equal(reuse.reason, 'selection-unavailable');
});

test('prepared arm id is available to renderer before an immediate registered hotkey fires', async () => {
  const f = setup({ immediate: true });
  const prepared = await f.arm.arm({ platform: 'line', chatName: '群' });
  const rendererOwnsId = prepared.armId;
  assert.equal(f.arm.activate({ armId: rendererOwnsId }).status, 'armed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.delivered[0].armId, rendererOwnsId);
  assert.equal(f.arm.acknowledge({ armId: rendererOwnsId, selectionId: f.delivered[0].selectionId,
    captureRevision: f.delivered[0].captureRevision }).status, 'accepted');
});
