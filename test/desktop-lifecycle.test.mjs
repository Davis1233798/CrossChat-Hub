import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createShutdown, flushSessions } = createRequire(import.meta.url)('../desktop/lifecycle.cjs');

test('native close and quit join the same shutdown and wait for persistence', async () => {
  const events = [];
  let finishFlush;
  const flushing = new Promise(resolve => { finishFlush = resolve; });
  const shutdown = createShutdown({
    prepare: () => { events.push('stop writers'); void shutdown(); },
    flush: () => { events.push('flush'); return flushing; },
    exit: code => events.push(`exit ${code}`),
  });
  const first = shutdown();
  assert.equal(shutdown(), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['stop writers', 'flush']);
  finishFlush();
  assert.equal(await first, true);
  assert.deepEqual(events, ['stop writers', 'flush', 'exit 0']);
});

test('flush failure attempts every distinct session and cannot report a successful close', async () => {
  const attempts = [];
  const good = { flushStorageData: () => attempts.push('storage'), cookies: { flushStore: async () => attempts.push('cookies') } };
  const bad = { flushStorageData: () => { attempts.push('failed'); throw new Error('Sensitive storage detail'); } };
  await assert.rejects(flushSessions([bad, good, good]), /^Error: Session persistence failed$/);
  assert.deepEqual(attempts, ['failed', 'storage', 'cookies']);
  const exits = [];
  const shutdown = createShutdown({ prepare: () => {}, flush: () => flushSessions([bad]), exit: code => exits.push(code) });
  assert.equal(await shutdown(), false);
  assert.deepEqual(exits, [1]);
});

test('a stuck flush is bounded and late completion cannot exit twice', async () => {
  const exits = [];
  let finishFlush;
  const shutdown = createShutdown({
    prepare: () => {}, flush: () => new Promise(resolve => { finishFlush = resolve; }),
    exit: code => exits.push(code), timeoutMs: 20,
  });
  assert.equal(await shutdown(), false);
  assert.deepEqual(exits, [1]);
  finishFlush();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [1]);
});
