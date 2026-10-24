import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { SERVICES, getService, LINE_DOWNLOADS, safeNavigation } = require('../desktop/tab-config.cjs');

test('five distinct tabs, each hosted website has isolated persistent storage', () => {
  assert.deepEqual(SERVICES.map(s => s.id), ['telegram', 'discord', 'slack', 'whatsapp', 'line']);
  assert.equal(new Set(SERVICES.filter(s => s.url).map(s => s.partition)).size, 4);
  for (const item of SERVICES.filter(s => s.url)) {
    assert.match(item.url, /^https:\/\//);
    assert.match(item.partition, /^persist:crosschat-/);
    assert.equal(item.kind, 'web');
  }
  assert.equal(getService('line').url, null);
  assert.ok(['native-line-experimental', 'native-line-unavailable'].includes(getService('line').kind));
});
test('native LINE requires explicit binding and opt-in; never requests a platform password', () => {
  const ui = readFileSync(new URL('../desktop/shell.html', import.meta.url), 'utf8');
  assert.match(ui, /啟用 LINE 實驗功能/);
  assert.match(ui, /強制結束 CrossChat 或原生 broker/);
  assert.match(LINE_DOWNLOADS.chrome, /chromewebstore\.google\.com/);
  const src = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(src, /validatedWitnessFor\('line'\)/);
  assert.match(src, /crosschat:line-enable/);
});
test('remote navigation only permits HTTPS URLs, not local files or javascript', () => {
  assert.equal(safeNavigation('https://discord.com/app'), true);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com', 'data:text/html,hi', '']) {
    assert.equal(safeNavigation(url), false);
  }
});
test('native shell never requests a platform password or developer bot token', () => {
  const ui = readFileSync(new URL('../desktop/shell.html', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /type="password"|Webhook Secret|Bot Token/);
  const src = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(src, /nodeIntegration: false/);
  assert.match(src, /sandbox: true/);
  assert.match(src, /quitSafely/);
  assert.doesNotMatch(src, /startHub/);
});
