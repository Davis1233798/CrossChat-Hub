// Windows integration checks: intentionally FAIL the actual isolated Hub attach,
// then assert rollback evidence before controller exit. No kill/restart fallback.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.platform !== 'win32') throw new Error('Windows-only native failure study');
for (const injection of ['after-hub-parent', 'after-fixture-parent', 'after-resize', 'stdio-eof']) {
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [root], {
    cwd: root, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CROSSCHAT_BROKER_STUDY: '1', CROSSCHAT_BROKER_TEST_MODE: 'manual', CROSSCHAT_BROKER_FAIL_AT: injection },
  });
  let output = '', errors = '';
  child.stdout.on('data', b => { output += b.toString(); });
  child.stderr.on('data', b => { errors += b.toString(); });
  // Observation deadline does not kill a parent or hide an orphan. If this
  // expires, stop the suite and inspect this same PID/handle instead of retrying.
  const timer = setTimeout(() => { console.error(`Observation deadline for owned controller ${child.pid}; no termination attempted`); }, 45000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  const line = output.split(/\r?\n/).find(s => s.startsWith('CROSSCHAT_BROKER_STUDY '));
  assert.ok(line, `Missing isolated profile evidence: ${errors.slice(-300)}`);
  const evidence = JSON.parse(line.slice('CROSSCHAT_BROKER_STUDY '.length));
  assert.equal(evidence.controllerPid, child.pid);
  assert.equal(evidence.injection, injection);
  const result = JSON.parse(await readFile(evidence.resultPath, 'utf8'));
  assert.equal(result.success, false);
  assert.ok(result.error, 'Injected failure must remain a failure');
  assert.equal(result.rollbackAttempted, true);
  assert.equal(result.rollbackVerified, true);
  assert.equal(result.hubAliveAtRollback, true, 'Cannot use controller death to claim Hub restoration');
  assert.equal(result.hubRestoreVerified, true);
  assert.equal(result.fixtureNormallyClosed, true);
  assert.equal(result.hubChanged, true);
  assert.equal(result.fixtureChanged, injection !== 'after-hub-parent');
  assert.deepEqual(result.rollbackOrder, injection === 'after-hub-parent' ? ['hub'] : ['fixture', 'hub']);
  if (injection !== 'stdio-eof') assert.notEqual(code, 0, 'Partial attach failure cannot report a passing startup: '+errors.slice(-1500));
  console.log(JSON.stringify({ injection, controllerExit: code, rollbackVerified: true, hubAliveAtRollback: true, rollbackOrder: result.rollbackOrder, profile: evidence.profile }));
}
