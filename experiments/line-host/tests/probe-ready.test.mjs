import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = await readFile(new URL('../mv3-fixture/probe.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function page() {
  const nodes = new Map(['result', 'refresh', 'popup', 'worker'].map(id => [id, {}]));
  const messages = [];
  let resolve;
  let reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  vm.runInNewContext(source, {
    document: { getElementById: id => nodes.get(id) },
    chrome: { runtime: {
      id: 'synthetic-fixture',
      sendMessage: request => { assert.equal(request.type, 'capabilities'); return pending; },
    } },
    console: { info: value => messages.push(JSON.parse(value)) },
  });
  return { nodes, messages, resolve, reject };
}

test('fixture readiness is emitted only after a successful worker response', async () => {
  const fixture = page();
  await flush();
  assert.equal(fixture.messages.length, 0, 'initial page creation is not worker readiness');
  fixture.resolve({ starts: 3, capabilities: { worker: true, windowsCreate: true } });
  await flush();
  assert.deepEqual(fixture.messages, [{ event: 'crosschat-fixture-ready', starts: 3, capabilities: { worker: true, windowsCreate: true } }]);
  assert.equal(JSON.parse(fixture.nodes.get('result').textContent).extensionId, 'synthetic-fixture');
});

for (const [name, response] of [
  ['missing counter', { capabilities: { worker: true } }],
  ['zero counter', { starts: 0, capabilities: { worker: true } }],
  ['fractional counter', { starts: 1.5, capabilities: { worker: true } }],
  ['worker absent', { starts: 1, capabilities: { worker: false } }],
  ['initialization error', { error: 'storage initialization failed' }],
]) {
  test(`fixture cannot announce readiness with ${name}`, async () => {
    const fixture = page();
    fixture.resolve(response);
    await flush();
    assert.equal(fixture.messages.length, 0);
  });
}

test('rejected worker initialization displays the failure without readiness', async () => {
  const fixture = page();
  fixture.reject(new Error('worker unavailable'));
  await flush();
  assert.equal(fixture.messages.length, 0);
  assert.equal(fixture.nodes.get('result').textContent, 'worker unavailable');
});
