import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const electron = createRequire(import.meta.url)('electron');
const profile = await mkdtemp(join(tmpdir(), 'crosschat-workspace-smoke-'));
const fixture = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  response.end('<!doctype html><title>Synthetic workspace fixture</title>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
try {
  for (const phase of ['assert-failure', 'seed', 'restore-clear', 'cleared']) {
    await new Promise((resolve, reject) => {
      const failure = phase === 'assert-failure';
      const env = { ...process.env, CROSSCHAT_WORKSPACE_PROFILE: profile, CROSSCHAT_WORKSPACE_ORIGIN: origin,
        CROSSCHAT_WORKSPACE_PHASE: failure ? 'seed' : phase, CROSSCHAT_WORKSPACE_ASSERT_FAILURE: failure ? '1' : '0' };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [fileURLToPath(new URL('./workspace-persistence-child.cjs', import.meta.url))], { env, stdio: 'inherit' });
      const deadline = setTimeout(() => { child.kill(); reject(Error(`Workspace ${phase} timeout`)); }, 30000);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', code => {
        clearTimeout(deadline);
        if (code === (failure ? 1 : 0)) {
          if (failure) console.log('PASS: intentional assertion failure exits nonzero');
          resolve();
        } else reject(Error(`Workspace ${phase} exited ${code}`));
      });
    });
  }
  console.log('PASS: canonical workspace consumed across real process restart and cleared durably; provider events/navigation simulated, no real login verified');
} finally {
  await new Promise(resolve => fixture.close(resolve));
}
