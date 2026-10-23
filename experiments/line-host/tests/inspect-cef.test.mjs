import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

// Execute the real entry point with transport substitutes: no CEF, network or
// LINE account is involved. The transport asserts the requested CDP operations.
const source = await readFile(new URL('../inspect-cef.mjs', import.meta.url), 'utf8');
const origin = 'chrome-extension://hcmjeeijoifmcgjhocekmfmepgijdjgb/';
async function inspect(mode, fault) {
  const children = [];
  const sockets = [];
  const operations = [];
  const timers = new Set();
  const main = { id: 'main', type: 'page', url: `${origin}probe.html`, webSocketDebuggerUrl: 'ws://127.0.0.1:19377/main' };
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay === 10000 ? 30 : delay);
    timers.add(timer);
    return timer;
  };
  const cancel = timer => { timers.delete(timer); clearTimeout(timer); };
  class Socket {
    constructor(url) {
      assert.match(url, /^ws:\/\/127\.0\.0\.1:19377\//);
      sockets.push(this);
      queueMicrotask(() => this.onopen());
    }
    close() { this.closed = true; this.onclose?.(); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      operations.push({ method, params });
      if (fault === 'closed') { this.close(); return; }
      if (fault === 'timeout') return;
      let result;
      if (method === 'Browser.getWindowForTarget') {
        result = { windowId: fault === 'escaped' && params.targetId !== 'main' ? 72 : 71 };
      } else {
        assert.equal(method, 'Runtime.evaluate');
        assert.equal(params.awaitPromise, true);
        assert.equal(params.returnByValue, true);
        let value;
        if (params.expression.includes('type:"capabilities"')) value = { starts: 1, capabilities: { worker: true } };
        else if (params.expression.includes('document.title')) value = { title: 'fixture' };
        else {
          assert.equal(params.userGesture, true);
          const path = params.expression.includes('worker-window') ? 'worker' : 'ordinary';
          if (fault !== 'workerFailure' || path !== 'worker') children.push({ id: path, type: 'page', url: `${origin}probe.html?child=${path}`, webSocketDebuggerUrl: `ws://127.0.0.1:19377/${path}` });
          // Deliberately unlike CDP's 71: chrome.windows IDs must not be compared.
          value = path === 'worker' ? (fault === 'workerFailure' ? { error: 'create failed' } : { created: true, id: 999 }) : true;
        }
        result = { result: { value } };
      }
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, result }) }));
    }
  }
  const process = { argv: ['node', 'inspect', mode] };
  let report;
  let error;
  try {
    await vm.runInNewContext(`(async () => {${source}\n})()`, {
      fetch: async () => ({ ok: true, json: async () => [main, ...children] }),
      WebSocket: Socket, AbortSignal, process, console: { log: value => { report = JSON.parse(value); } },
      setTimeout: schedule, clearTimeout: cancel, Date, queueMicrotask,
    });
  } catch (caught) { error = caught; }
  assert.ok(sockets.every(socket => socket.closed), 'success and failures must close all opened sockets');
  assert.equal(timers.size, 0, 'no pending request/connection timers may survive');
  return { process, report, error, operations };
}

for (const mode of ['ordinary', 'worker', 'both']) {
  test(`inspector exercises exactly the ${mode} path(s)`, async () => {
    const result = await inspect(mode);
    assert.equal(result.error, undefined);
    assert.equal(result.process.exitCode, undefined);
    assert.equal(result.report.fixtureOnly, true);
    assert.equal(result.report.realLineLogin, false);
    assert.equal(result.report.sameWindow, true);
    assert.deepEqual(result.report.paths.map(path => path.path), mode === 'both' ? ['ordinary', 'worker'] : [mode]);
    assert.equal(result.operations.filter(operation => operation.method === 'Browser.getWindowForTarget').length, 1 + result.report.paths.length);
  });
}
test('a separate CDP native window fails same-window acceptance', async () => {
  const result = await inspect('both', 'escaped');
  assert.equal(result.error, undefined);
  assert.equal(result.process.exitCode, 1);
  assert.equal(result.report.sameWindow, false);
  assert.ok(result.report.paths.every(path => !path.sameWindow));
});
test('worker create failure cannot become a passing report', async () => {
  const result = await inspect('worker', 'workerFailure');
  assert.match(result.error?.message ?? '', /Worker popup creation failed/);
  assert.equal(result.report, undefined);
});
for (const [fault, message] of [['closed', /socket closed/], ['timeout', /Timed out: Runtime.evaluate/]]) {
  test(`${fault} rejects an in-flight CDP request and cleans up`, async () => {
    const result = await inspect('both', fault);
    assert.match(result.error?.message ?? '', message);
    assert.equal(result.report, undefined);
  });
}

test('worker replies only after the initial persistent storage write', async () => {
  const worker = await readFile(new URL('../mv3-fixture/worker.js', import.meta.url), 'utf8');
  let finishWrite;
  let listener;
  let response;
  const stored = {};
  const chrome = {
    storage: { local: {
      get: async key => typeof key === 'string' ? { starts: stored.starts } : { ...stored },
      set: value => new Promise(resolve => { finishWrite = () => { Object.assign(stored, value); resolve(); }; }),
    } },
    runtime: { onMessage: { addListener: callback => { listener = callback; } } },
    action: { onClicked: { addListener() {} } },
  };
  vm.runInNewContext(worker, { chrome });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listener({ type: 'capabilities' }, null, value => { response = value; }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response, undefined, 'a capabilities request must wait for storage initialization');
  finishWrite();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.starts, 1);
  assert.equal(response.capabilities.worker, true);
});
