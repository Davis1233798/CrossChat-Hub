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
  assert.equal(getService('line').kind, 'unsupported-extension');
});
test('never misrepresent LINE OAuth/Chrome extension as an embeddable web chat', () => {
  const ui = readFileSync(new URL('../desktop/shell.html', import.meta.url), 'utf8');
  assert.match(ui, /LINE 個人聊天尚無法內嵌/);
  assert.match(ui, /此分頁目前不能收發 LINE 私人訊息/);
  assert.match(LINE_DOWNLOADS.chrome, /chromewebstore\.google\.com/);
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
  assert.match(src, /app\.exit\(0\)/);
  assert.doesNotMatch(src, /startHub/);
});
