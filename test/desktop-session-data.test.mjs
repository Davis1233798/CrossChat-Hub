import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSessionReset } = require('../desktop/session-data.cjs');
const { getService } = require('../desktop/tab-config.cjs');
function setup(overrides = {}) {
  const events = [];
  let blocker;
  const isolated = {
    webRequest: { onBeforeRequest: handler => { blocker = handler; events.push(handler ? 'block network' : 'unblock network'); } },
    closeAllConnections: async () => events.push('close connections'),
    clearAuthCache: async () => events.push('clear http auth'),
    clearData: async () => events.push('clear data'),
    flushStorageData: () => events.push('flush storage'),
    cookies: { flushStore: async () => events.push('flush cookies') },
  };
  const reset = createSessionReset({
    getService, getSession: service => { events.push(service.partition); return isolated; },
    confirm: async () => true,
    destroyWriters: service => events.push(`destroy ${service.id}`),
    revokePermissions: id => events.push(`revoke ${id}`),
    onState: (_id, state) => events.push(state), isClosing: () => false,
    ...overrides,
  });
  return { reset, events, isolated, getBlocker: () => blocker };
}
test('profile reset requires a configured web service and explicit confirmation', async () => {
  const { reset, events } = setup({ confirm: async () => false });
  for (const id of ['line', 'unknown', 'persist:other', '../default']) await assert.rejects(reset.request(id), /Unsupported service/);
  assert.deepEqual(await reset.request('slack'), { state: 'cancelled' });
  assert.deepEqual(events, []);
  assert.equal(reset.isBlocked('slack'), false);
});
test('confirmed reset blocks writes, destroys only the target and flushes deletion before reopening', async () => {
  const { reset, events, isolated, getBlocker } = setup();
  let finish;
  isolated.clearData = () => new Promise(resolve => { finish = resolve; });
  const first = reset.request('slack');
  assert.equal(reset.request('slack'), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reset.isBlocked('slack'), true);
  assert.equal(reset.isBlocked('discord'), false);
  let blocked;
  getBlocker()({}, result => { blocked = result.cancel; });
  assert.equal(blocked, true);
  finish();
  assert.deepEqual(await first, { state: 'cleared' });
  assert.deepEqual(events, ['resetting', 'persist:crosschat-slack', 'block network', 'destroy slack', 'revoke slack', 'close connections', 'clear http auth', 'flush storage', 'flush cookies', 'unblock network', 'cleared']);
  assert.equal(reset.isBlocked('slack'), false);
});
test('failure leaves the profile blocked and never announces success; explicit retry can recover', async () => {
  const { reset, events, isolated } = setup();
  isolated.clearData = async () => { throw new Error('Private storage path'); };
  assert.deepEqual(await reset.request('slack'), { state: 'reset-error' });
  assert.equal(reset.isBlocked('slack'), true);
  assert.equal(events.includes('cleared'), false);
  isolated.clearData = async () => {};
  assert.deepEqual(await reset.request('slack'), { state: 'cleared' });
  assert.equal(reset.isBlocked('slack'), false);
});
test('quit during confirmation cancels clearing; active clearing is observable by shutdown', async () => {
  let closing = false;
  let answer;
  const { reset, events } = setup({ confirm: () => new Promise(resolve => { answer = resolve; }), isClosing: () => closing });
  const request = reset.request('slack');
  await new Promise(resolve => setImmediate(resolve));
  closing = true;
  answer(true);
  assert.deepEqual(await request, { state: 'cancelled' });
  assert.deepEqual(events, []);
  await reset.waitForActive();
});
test('pending deletion is restored as blocked and intent is cleared only after durable deletion', async () => {
  const intents = [];
  const { reset, isolated } = setup({
    initialBlocked: ['slack'],
    persistIntent: id => intents.push(`persist ${id}`), clearIntent: id => intents.push(`clear ${id}`),
  });
  assert.equal(reset.isBlocked('slack'), true);
  let finish;
  isolated.cookies.flushStore = () => new Promise(resolve => { finish = resolve; });
  const work = reset.request('slack');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(intents, ['persist slack']);
  let waited = false;
  const draining = reset.waitForActive().then(() => { waited = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waited, false);
  finish();
  await work;
  await draining;
  assert.deepEqual(intents, ['persist slack', 'clear slack']);
  assert.equal(reset.isBlocked('slack'), false);
});
