// Owned synthetic native windows ONLY; real-LINE flag is explicitly disabled.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.platform !== 'win32') throw new Error('Windows-only native layout study');
for (const minimumWidth of [364, 1600]) {
  const processHandle = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [root], {
    cwd: root, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CROSSCHAT_BROKER_STUDY: '1', CROSSCHAT_BROKER_LINE_STUDY: '0', CROSSCHAT_BROKER_DPI: 'mixed-v2', CROSSCHAT_BROKER_TEST_MODE: 'normal', CROSSCHAT_BROKER_FAIL_AT: 'none', CROSSCHAT_BROKER_OWNED_MIN_WIDTH: String(minimumWidth) },
  });
  let output = '', stderr = '';
  processHandle.stdout.on('data', b => { output += b.toString(); });
  processHandle.stderr.on('data', b => { stderr += b.toString(); });
  const timer = setTimeout(() => console.error(`Observation deadline: owned controller ${processHandle.pid} still pending; no termination attempted`), 45000);
  const code = await new Promise((resolve, reject) => { processHandle.once('error', reject); processHandle.once('close', resolve); });
  clearTimeout(timer);
  const line = output.split(/\r?\n/).find(s => s.startsWith('CROSSCHAT_BROKER_STUDY '));
  assert.ok(line, stderr);
  const evidence = JSON.parse(line.slice('CROSSCHAT_BROKER_STUDY '.length));
  assert.equal(evidence.lineStudy, false);
  const result = JSON.parse(await readFile(evidence.resultPath, 'utf8'));
  assert.equal(result.fixtureRestoreVerified, true);
  assert.equal(result.fixtureNormallyClosed, true);
  assert.equal(result.hubDpiBefore, 'context-3');
  assert.equal(result.fixtureDpiBefore, 'context-4');
  if (minimumWidth === 364) {
    assert.equal(code, 0, stderr);
    assert.equal(result.success, true);
    assert.equal(result.resizeVerified, true);
    assert.equal(result.layoutAdapted, true);
    const first = result.layoutObservations[0], last = result.layoutObservations.at(-1);
    assert.equal(first.requestedChatWidth, 360);
    assert.equal(first.chat.width, 364, 'Must reproduce the actual native clamp, not mock it');
    assert.equal(last.hub.width + last.chat.width, last.paneWidth);
    assert.equal(last.hub.left + last.hub.width, last.chat.left);
    assert.ok(last.hub.width >= result.hubMinimumWidth);
    assert.ok(last.hub.height >= result.hubMinimumHeight);
  } else {
    assert.equal(code, 1, stderr);
    assert.equal(result.success, false);
    assert.match(result.error, /minimum dimensions exceed available pane/);
    assert.equal(result.rollbackVerified, true);
    assert.equal(result.hubAliveAtRollback, true);
  }
  console.log(JSON.stringify({ minimumWidth, controllerExit: code, adapted: result.layoutAdapted, resizeVerified: result.resizeVerified, rollbackVerified: result.rollbackVerified, fixtureRestored: result.fixtureRestoreVerified }));
}
