'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const appDir = path.resolve(__dirname, '..');
  const script = path.join(appDir, 'scripts', 'build-native-helpers.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: appDir, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Windows native helper build failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`);
};
