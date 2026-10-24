import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLineBinding } = require('../desktop/line-binding.cjs');
const { createLineWitnessClient } = require('../desktop/line-witness-client.cjs');
const { registerForwardingIpc } = require('../desktop/forwarding-ipc.cjs');

const a = { pid: 101, startTicks: '10101', hwnd: '1001', path: 'C:\\Users\\fixture\\LINE.exe', publisher: 'LY Corporation', sha256: 'a'.repeat(64), dpiContext: 'context-4' };
const b = { ...a, pid: 202, startTicks: '20202', hwnd: '2002' };

test('binding uses opaque candidates, explicit confirmation, and fresh validation before each observe', async () => {
  let current = [a, b], checks = 0, clock = 100;
  const binding = createLineBinding({ listCandidates: async () => current, validateWitness: async w => { checks++; const found = current.find(x => x.pid === w.pid); if (!found) throw new Error(); return found; }, now: () => clock });
  const listed = await binding.list();
  assert.deepEqual(listed.candidates.map(x => x.sequence), [1, 2]);
  assert.ok(listed.candidates.every(x => /^[a-f0-9]{32}$/.test(x.candidateId)));
  assert.equal(JSON.stringify(listed).includes('1001'), false);
  assert.equal((await binding.bind({ candidateId: listed.candidates[0].candidateId })).status, 'rejected');
  assert.equal((await binding.bind({ candidateId: listed.candidates[0].candidateId, confirmed: true })).status, 'bound');
  assert.equal(checks, 1);
  assert.deepEqual(await binding.witnessFor('line'), { pid: 101, startTicks: '10101', hwnd: '1001', exe: a.path });
  assert.equal(checks, 2);
  current = [b];
  assert.equal(await binding.witnessFor('line'), null);
  assert.equal(binding.state().bound, false);
  assert.equal(await binding.witnessFor('line'), null);
});

test('candidate handles expire and unbind clears the private witness', async () => {
  let clock = 0;
  const binding = createLineBinding({ listCandidates: async () => [a], validateWitness: async w => w, now: () => clock });
  const listed = await binding.list(); clock += 30_001;
  assert.equal((await binding.bind({ candidateId: listed.candidates[0].candidateId, confirmed: true })).status, 'expired');
  const second = await binding.list();
  await binding.bind({ candidateId: second.candidates[0].candidateId, confirmed: true });
  assert.equal(binding.unbind().status, 'unbound');
  assert.equal(await binding.witnessFor('line'), null);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('unbind during pending candidate validation cannot restore the binding', async () => {
  const validation = deferred();
  const binding = createLineBinding({ listCandidates: async () => [a], validateWitness: () => validation.promise });
  const listed = await binding.list();
  const pendingBind = binding.bind({ candidateId: listed.candidates[0].candidateId, confirmed: true });
  assert.equal(binding.unbind().status, 'unbound');
  validation.resolve(a);
  assert.equal((await pendingBind).status, 'expired');
  assert.equal(binding.state().bound, false);
  assert.equal(await binding.witnessFor('line'), null);
});

test('overlapping candidate scans publish only the latest completed request generation', async () => {
  const scans = [deferred(), deferred()]; let index = 0;
  const binding = createLineBinding({ listCandidates: () => scans[index++].promise, validateWitness: async w => w });
  const earlier = binding.list();
  const latest = binding.list();
  scans[1].resolve([b]);
  const current = await latest;
  assert.equal(current.status, 'available');
  scans[0].resolve([a]);
  const stale = await earlier;
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.candidates, []);
  assert.equal((await binding.bind({ candidateId: current.candidates[0].candidateId, confirmed: true })).status, 'bound');
  assert.equal((await binding.witnessFor('line')).hwnd, b.hwnd);
});

function witnessHelper(transform = data => data, options = {}) {
  let killed = 0;
  const client = createLineWitnessClient({ binaryPath: resolve('fixed-LineWitness.exe'), timeoutMs: 30,
    spawnProcess(binary, args, settings) {
      assert.equal(binary, resolve('fixed-LineWitness.exe')); assert.equal(args[0], '--protocol'); assert.equal(settings.windowsHide, true);
      const child = new EventEmitter(); child.exitCode = null;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => { killed++; child.exitCode = 1; };
      let input = ''; child.stdin.on('data', chunk => input += chunk);
      child.stdin.on('finish', () => {
        const req = JSON.parse(input);
        const data = transform(req.op === 'list-candidates' ? { candidates: [a, b] } : { valid: true, witness: req.witness ?? a });
        if (data === null) return;
        child.stdout.write(JSON.stringify({ v: 1, id: req.id, nonce: req.nonce, ok: true, data }) + '\n');
        child.exitCode = 0; child.emit('close', 0);
      });
      queueMicrotask(() => child.stdout.write(JSON.stringify({ v: 1, type: 'ready', nonce: args[1] }) + '\n'));
      return child;
    }, ...options });
  return { client, killed: () => killed };
}

test('fixed witness client enforces bounded protocol schema and identity', async () => {
  const f = witnessHelper();
  assert.deepEqual(await f.client.listCandidates(), [a, b]);
  assert.deepEqual(await f.client.validateWitness(a), a);
  const invalid = witnessHelper(() => ({ candidates: [{ ...a, hwnd: 'forged' }, b] }));
  await assert.rejects(invalid.client.listCandidates());
  const stalled = witnessHelper(() => null);
  await assert.rejects(stalled.client.listCandidates());
  assert.equal(stalled.killed(), 1);
});

test('LINE IPC requires the trusted shell frame and accepts no renderer identity fields', async () => {
  const handlers = new Map(), url = 'file:///owned/shell.html';
  const frame = { url }, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
  const binding = createLineBinding({ listCandidates: async () => [a], validateWitness: async w => w });
  registerForwardingIpc({ handle: (name, fn) => handlers.set(name, fn) }, () => window, url, {}, binding);
  const event = { sender: contents, senderFrame: frame };
  const listed = await handlers.get('crosschat:line-bind-list')(event);
  assert.deepEqual(Object.keys(listed.candidates[0]).sort(), ['candidateId', 'sequence']);
  assert.equal((await handlers.get('crosschat:line-bind-confirm')(event, { candidateId: listed.candidates[0].candidateId, confirmed: true, hwnd: a.hwnd })).status, 'rejected');
  assert.throws(() => handlers.get('crosschat:line-bind-confirm')(event, { candidateId: listed.candidates[0].candidateId, confirmed: true }, { pid: a.pid }), /Invalid/);
  assert.throws(() => handlers.get('crosschat:line-bind-list')(event, { pid: a.pid }), /Invalid/);
  assert.throws(() => handlers.get('crosschat:line-bind-clear')({ sender: {}, senderFrame: frame }), /Untrusted/);
  assert.throws(() => handlers.get('crosschat:line-bind-clear')(event, { hwnd: a.hwnd }), /Invalid/);
});
