import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createSelectionArming, SELECTION_ACCELERATOR, SELECTION_ARM_TTL_MS } = createRequire(import.meta.url)('../desktop/selection-arming.cjs');

function setup({ bound = true, registration = true, capture = async () => ({ status: 'captured', text: 'owned selection' }) } = {}) {
  let callback = null, timerCallback = null, unregistered = 0, delivered = [];
  const arm = createSelectionArming({
    register: (key, fn) => { assert.equal(key, SELECTION_ACCELERATOR); callback = fn; return registration; },
    unregister: key => { assert.equal(key, SELECTION_ACCELERATOR); callback = null; unregistered++; },
    isBound: async () => bound,
    capture,
    onResult: value => delivered.push(value),
    setTimer: fn => { timerCallback = fn; return 1; }, clearTimer: () => {}, now: () => 100,
    random: () => Buffer.alloc(16, 3),
  });
  return { arm, callback: () => callback, timeout: () => timerCallback, delivered, unregistered: () => unregistered };
}

test('arming uses fixed temporary shortcut, captures once, and unregisters before delivery', async () => {
  const f = setup();
  const result = await f.arm.arm({ platform: 'line', chatName: '我填的來源' });
  assert.equal(result.status, 'armed'); assert.equal(result.expiresAt, 100 + SELECTION_ARM_TTL_MS);
  assert.equal(f.arm.state().armId, result.armId);
  const trigger = f.callback(); assert.equal(typeof trigger, 'function'); trigger();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.unregistered(), 1);
  assert.deepEqual(f.delivered, [{ armId: result.armId, status: 'captured', text: 'owned selection' }]);
  assert.equal(f.callback(), null);
});

test('arm requires a bound LINE source and reports shortcut conflicts', async () => {
  assert.equal((await setup({ bound: false }).arm.arm({ platform: 'line', chatName: '群' })).reason, 'line-window-not-bound');
  assert.equal((await setup({ registration: false }).arm.arm({ platform: 'line', chatName: '群' })).reason, 'shortcut-unavailable');
  assert.equal((await setup().arm.arm({ platform: 'slack', chatName: '群' })).status, 'rejected');
  assert.equal((await setup().arm.arm({ platform: 'line', chatName: '群', hwnd: 'renderer supplied' })).status, 'rejected');
});

test('timeout, explicit cancel, and close unregister only the feature shortcut', async () => {
  for (const end of ['timeout', 'cancel', 'close']) {
    const f = setup();
    const armed = await f.arm.arm({ platform: 'line', chatName: '群' });
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
  f.callback()();
  f.arm.cancel({ armId: armed.armId });
  finish({ status: 'captured', text: 'must not escape after cancel' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.delivered, []);
});
