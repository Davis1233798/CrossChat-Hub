'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNativeLineBroker } = require('../desktop/native-line-broker.cjs');

function harness({ timeoutMs = 100, drop = new Set(), restoreFailure = false } = {}) {
  const children = [], commands = [];
  let closeNotice = 0;
  function spawnProcess(_binary, args) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
    child.killCount = 0; child.kill = () => { child.killCount++; return true; };
    child.stdin.on('data', bytes => {
      for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
        const message = JSON.parse(line); commands.push(message);
        if (drop.has(message.type)) continue;
        const response = { v: 1, nonce: args[1], sequence: message.sequence };
        if (message.type === 'attach') Object.assign(response, { type: 'attached' });
        else if (message.type === 'line-attach') Object.assign(response, { type: 'line-attached', attached: true, alive: true });
        else if (message.type === 'line-show' || message.type === 'line-hide') Object.assign(response, { type: 'line-visibility', visible: message.type === 'line-show', verified: true });
        else if (message.type === 'detach-host') Object.assign(response, restoreFailure
          ? { type: 'line-restore-failed', restored: false, message: 'fixture restore rejected' }
          : { type: 'host-detached', restored: true });
        child.stdout.write(JSON.stringify(response) + '\n');
      }
    });
    children.push(child);
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ v: 1, nonce: args[1], sequence: 0, type: 'ready' }) + '\n');
      child.stdout.write(JSON.stringify({ v: 1, nonce: args[1], sequence: 0, type: 'close-request' }) + '\n');
    });
    return child;
  }
  const broker = createNativeLineBroker({
    binaryPath: 'C:\\native\\ProductBroker.exe', spawnProcess, timeoutMs, platform: 'win32',
    getStartTicks: async () => '1234', makeTempDir: () => 'C:\\Temp\\crosschat-native-line-test',
    getScreen: () => ({ getDisplayMatching: () => ({ scaleFactor: 1 }) }),
  });
  broker.onStatus(event => { if (event.state === 'close-request') closeNotice++; });
  return { broker, children, commands, get closeNotice() { return closeNotice; } };
}
const window = {
  getNativeWindowHandle() { const handle = Buffer.alloc(8); handle.writeBigUInt64LE(99n); return handle; },
  getMinimumSize() { return [800, 600]; }, getBounds() { return { x: 0, y: 0, width: 1200, height: 800 }; },
};
const witness = { pid: 10, startTicks: '20', hwnd: '30', path: 'C:\\LINE.exe', publisher: 'LY Corporation', sha256: 'a'.repeat(64), dpiContext: 'context-4' };

test('native LINE host starts only on enable and correlates nonce/sequence through restore failure and retry', async () => {
  const h = harness({ restoreFailure: true });
  assert.equal(h.broker.active, false);
  assert.equal(h.children.length, 0);
  assert.deepEqual(await h.broker.enable(window, witness), { state: 'enabled' });
  assert.equal(h.closeNotice, 1);
  await h.broker.setLineVisible(false);
  await h.broker.setLineVisible(true);
  const failed = await h.broker.detachAndRestoreHub();
  assert.equal(failed.restored, false);
  h.broker.blocked && assert.equal(h.broker.blocked, true);
  // The fixture changes its response on the next detach; the controller does not kill the host.
  const fixture = h.children[0];
  const original = fixture.stdin.listeners('data')[0];
  fixture.stdin.removeListener('data', original);
  fixture.stdin.on('data', bytes => {
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      const message = JSON.parse(line); h.commands.push(message);
      fixture.stdout.write(JSON.stringify({ v: 1, nonce: h.commands[0].nonce, sequence: message.sequence, type: 'host-detached', restored: true }) + '\n');
    }
  });
  assert.deepEqual(await h.broker.detachAndRestoreHub(), { restored: true });
  assert.equal(fixture.killCount, 0);
  assert.deepEqual(h.commands.map(command => command.sequence), [1, 2, 3, 4, 5, 6]);
  assert.ok(h.commands.every(command => command.nonce === h.commands[0].nonce));
});

test('native LINE timeout blocks window operations but preserves broker for restore retry', async () => {
  const h = harness({ timeoutMs: 10, drop: new Set(['line-hide']) });
  await h.broker.enable(window, witness);
  await assert.rejects(h.broker.setLineVisible(false), /not verified|timed out/i);
  assert.equal(h.broker.blocked, true);
  assert.equal(h.children[0].killCount, 0);
  assert.deepEqual(await h.broker.detachAndRestoreHub(), { restored: true });
  assert.equal(h.children[0].killCount, 0);
});

test('close during native host startup waits for attach acknowledgement before detaching', async () => {
  const h = harness();
  const enable = h.broker.enable(window, witness);
  const close = h.broker.detachAndRestoreHub();
  const [enabled, restored] = await Promise.all([enable, close]);
  assert.equal(enabled.state, 'enabled');
  assert.equal(restored.restored, true);
  assert.deepEqual(h.commands.map(command => command.type), ['attach', 'line-attach', 'detach-host']);
  assert.equal(h.children[0].killCount, 0);
});

test('unexpected host exit after attach remains blocked instead of claiming restoration', async () => {
  const h = harness();
  await h.broker.enable(window, witness);
  h.children[0].emit('exit', 73);
  assert.equal(h.broker.active, false);
  assert.equal(h.broker.blocked, true);
  assert.equal(h.children[0].killCount, 0);
});
