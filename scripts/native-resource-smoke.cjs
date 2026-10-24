'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { requireNativeHelper } = require('../desktop/native-helper-paths.cjs');

const resourcesPath = process.argv[2];
if (!path.isAbsolute(resourcesPath ?? '')) throw new Error('Pass the absolute packaged resources directory, such as dist/win-unpacked/resources');
for (const name of ['LineWitness.exe', 'ReadOnlyRouting.exe']) {
  const executable = requireNativeHelper(path.join(resourcesPath, 'native', name));
  const result = spawnSync(executable, ['--self-test'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.error, undefined, `${name} must start: ${result.error?.message}`);
  assert.equal(result.status, 0, `${name} self-test failed: ${result.stderr}`);
  const records = result.stdout.trim().split(/\r?\n/);
  assert.equal(records.length, 1, `${name} must emit one protocol record`);
  const record = JSON.parse(records[0]);
  assert.equal(record.ok, true);
  assert.equal(record.protocol, 1);
  assert.match(record.runtime, /^\d+\.\d+/);
}
console.log('Packaged native helper resources and safe self-tests passed.');
