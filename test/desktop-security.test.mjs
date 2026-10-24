import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { isOfficialOrigin, canCheckPermission, needsUserApproval } = require('../desktop/permissions.cjs');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('only the expected provider origins receive device or notification permissions', () => {
  assert.equal(isOfficialOrigin('telegram', 'https://web.telegram.org/k/'), true);
  assert.equal(isOfficialOrigin('discord', 'https://discord.com/app'), true);
  assert.equal(isOfficialOrigin('slack', 'https://app.slack.com/client'), true);
  assert.equal(isOfficialOrigin('whatsapp', 'https://web.whatsapp.com/'), true);
  for (const origin of ['https://web.whatsapp.com.evil.test/', 'http://web.whatsapp.com/', 'file:///etc/passwd', 'https://login.microsoftonline.com/']) {
    assert.equal(isOfficialOrigin('whatsapp', origin), false);
    assert.equal(canCheckPermission('whatsapp', origin, 'media'), false);
  }
  assert.equal(canCheckPermission('line', 'https://line.me/', 'media'), false);
  assert.equal(canCheckPermission('discord', 'https://discord.com/', 'geolocation'), false);
  assert.equal(canCheckPermission('discord', 'https://discord.com/', 'media'), true);
  assert.equal(needsUserApproval('media'), true);
  assert.equal(needsUserApproval('notifications'), true);
  assert.equal(needsUserApproval('clipboard-sanitized-write'), false);
});
test('remote views remain sandboxed and cannot receive native APIs', () => {
  const code = read('../desktop/main.cjs');
  assert.match(code, /nodeIntegration: false/);
  assert.match(code, /contextIsolation: true/);
  assert.match(code, /sandbox: true/);
  assert.match(code, /setPermissionCheckHandler/);
  assert.match(code, /setPermissionRequestHandler/);
  assert.match(code, /setSaveDialogOptions/);
  assert.doesNotMatch(code, /executeJavaScript\(/);
});
test('NSIS requests normal close and blocks replacement if a process remains', () => {
  const pkg = JSON.parse(read('../package.json'));
  const installer = read('../build/windows-installer.nsh');
  assert.equal(pkg.build.nsis.include, 'build/windows-installer.nsh');
  assert.match(installer, /customCheckAppRunning/);
  assert.match(installer, /SendMessage.*0x0010/);
  assert.match(installer, /ExecWait/);
  assert.match(installer, /tasklist\.exe/);
  assert.match(installer, /SetErrorLevel 2/);
  assert.doesNotMatch(installer, /taskkill\.exe|nsExec::Exec/);
});
test('tabs persist last selection, show message counts, and expose real website fallback', () => {
  const shell = read('../desktop/shell.html');
  const ui = read('../desktop/shell.js');
  assert.match(shell, /data-tab="telegram"/);
  assert.match(shell, /data-tab="line"/);
  assert.match(ui, /localStorage\.setItem/);
  assert.match(ui, /onTabStatus/);
  assert.match(ui, /\.unread/);
  assert.match(shell, /open-browser/);
});
