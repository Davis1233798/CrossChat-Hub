import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { canonicalSlackWorkspace, createWorkspaceState } = createRequire(import.meta.url)('../desktop/workspace-state.cjs');

test('workspace preference strips channel, query and hash without retaining authentication data', () => {
  assert.equal(canonicalSlackWorkspace('https://app.slack.com/client/T030GFVCKKJ/C123?token=secret#private'), 'https://app.slack.com/client/T030GFVCKKJ');
  assert.equal(canonicalSlackWorkspace('https://app.slack.com:443/client/T1'), 'https://app.slack.com/client/T1');
  for (const value of [
    'https://app.slack.com/client/not-team', 'https://app.slack.com/client/T',
    'https://app.slack.com/client/T1evil', 'https://app.slack.com/signin?team=T123',
    'https://app.slack.com.evil.test/client/T123', 'https://workspace.slack.com/client/T123',
    'https://user:secret@app.slack.com/client/T123', 'https://app.slack.com:8443/client/T123',
    'http://app.slack.com/client/T123', 'file:///client/T123', 'invalid',
  ]) assert.equal(canonicalSlackWorkspace(value), null, value);
});

test('workspace state survives reopening, rejects malformed state and clears independently of cookies', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crosschat-workspace-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createWorkspaceState(directory);
  assert.equal(store.read(), null);
  assert.equal(store.record('https://app.slack.com/client/T123/C456?token=secret#private'), true);
  assert.equal(createWorkspaceState(directory).read(), 'https://app.slack.com/client/T123');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'slack.json'))), { version: 1, workspace: 'https://app.slack.com/client/T123' });
  assert.equal(store.record('https://accounts.google.com/'), false);
  assert.equal(store.read(), 'https://app.slack.com/client/T123');
  store.clear();
  assert.equal(store.read(), null);
  store.clear();
  fs.writeFileSync(path.join(directory, 'slack.json'), '{bad');
  assert.equal(store.read(), null);
  fs.writeFileSync(path.join(directory, 'slack.json'), JSON.stringify({ version: 1, workspace: 'https://app.slack.com/client/T123/C456?token=secret' }));
  assert.equal(store.read(), null);
});

test('main captures only owned navigation events and clears preference before releasing reset intent', () => {
  const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /contents\.on\('did-navigate', \(event, url\) => record\(event, url, true\)\)/);
  assert.match(main, /contents\.on\('did-navigate-in-page', record\)/);
  assert.match(main, /!isMainFrame \|\| closing \|\| contents\.isDestroyed\(\) \|\| profileReset\.isBlocked/);
  assert.match(main, /rememberWorkspace\(popup\.webContents, service\)/);
  assert.match(main, /workspaceState\.clear\(\);\s*resetIntents\.clear\(id\)/);
});
