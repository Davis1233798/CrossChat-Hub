import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nativeHelperPaths, requireNativeHelper } = require('../desktop/native-helper-paths.cjs');

test('packaged helpers resolve only from resources/native', () => {
  const paths = nativeHelperPaths({ isPackaged: true, resourcesPath: 'C:\\app\\resources', appPath: 'C:\\app\\resources\\app.asar' });
  assert.equal(paths.lineWitness, path.join('C:\\app\\resources', 'native', 'LineWitness.exe'));
  assert.equal(paths.readOnlyRouting, path.join('C:\\app\\resources', 'native', 'ReadOnlyRouting.exe'));
});

test('development helpers resolve only from build/bin and missing files fail closed', () => {
  const paths = nativeHelperPaths({ isPackaged: false, resourcesPath: 'ignored', appPath: 'C:\\repo' });
  assert.equal(paths.lineWitness, path.join('C:\\repo', 'build', 'bin', 'native-host', 'LineWitness.exe'));
  assert.equal(paths.readOnlyRouting, path.join('C:\\repo', 'build', 'bin', 'native-routing', 'ReadOnlyRouting.exe'));
  assert.throws(() => requireNativeHelper(paths.lineWitness, () => false), /unavailable/);
  assert.throws(() => requireNativeHelper('relative.exe'), /unavailable/);
});
