// Starts two independent Electron processes against a disposable local fixture.
// The fixture contains only synthetic data and never touches real login profiles.
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const electron = createRequire(import.meta.url)('electron');
const profile = await mkdtemp(join(tmpdir(), 'crosschat-persistence-'));
const fixture = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>CrossChat local persistence fixture</title><p>Synthetic storage test only.</p>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
async function run(phase) {
  await new Promise((resolve, reject) => {
    const env = { ...process.env, CROSSCHAT_STORAGE_PROFILE: profile, CROSSCHAT_STORAGE_ORIGIN: origin, CROSSCHAT_STORAGE_PHASE: phase };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [join(dirname(fileURLToPath(import.meta.url)), 'session-persistence-child.cjs')], { env, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron ${phase} timed out`)); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Electron ${phase} exited with ${signal || code}`));
    });
  });
}
try {
  await run('seed');
  await run('verify');
  await run('clear');
  await run('resume-clear');
  await run('verify-cleared');
  console.log('PASS: real process restarts preserved synthetic storage and isolated partitions; confirmed local reset deleted only its target and deletion survived restart');
} finally {
  await new Promise(resolve => fixture.close(resolve));
  // OS temp profile retained for failure diagnostics; contains synthetic data only.
}
