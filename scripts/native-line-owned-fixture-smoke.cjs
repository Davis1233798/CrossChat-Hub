'use strict';
// Exercises the LINE_PRODUCT lifecycle against an owned synthetic HWND only.
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') throw new Error('Owned native broker smoke is Windows-only');
const binary = path.join(__dirname, '..', 'build', 'bin', 'native-host', 'ProductBrokerFixture.exe');
if (!fs.existsSync(binary)) throw new Error('Build native helpers before running the owned fixture smoke');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'crosschat-native-line-'));
const nonce = crypto.randomBytes(24).toString('hex');
let window, child, sequence = 0, output = '', settled = false, timer;
const pending = new Map();
function send(type, fields = {}) {
  const current = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(current, { resolve, reject });
    child.stdin.write(JSON.stringify({ v: 1, nonce, sequence: current, type, ...fields }) + '\n');
  });
}
function fail(error) {
  if (settled) return;
  settled = true; clearTimeout(timer);
  for (const item of pending.values()) item.reject(error);
  pending.clear();
  console.error('FAIL: owned native LINE lifecycle smoke:', error.message);
  if (!child || child.exitCode !== null) { window?.destroy(); app.exit(1); return; }
  // EOF asks the broker to roll back the owned fixture. No live LINE is involved.
  child.stdin.end();
  const fallback = setTimeout(() => { window?.destroy(); app.exit(1); }, 10000);
  child.once('exit', () => { clearTimeout(fallback); window?.destroy(); app.exit(1); });
}
async function run() {
  window = new BrowserWindow({ show: false, width: 1200, height: 800, minWidth: 800, minHeight: 600, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('data:text/html,<title>Owned native broker fixture</title><main>Offline fixture only</main>');
  window.show();
  const handle = window.getNativeWindowHandle();
  const hwnd = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
  const minimum = window.getMinimumSize();
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  const hubMinimum = { width: Math.ceil(minimum[0] * scale), height: Math.ceil(minimum[1] * scale) };
  child = spawn(binary, [String(process.pid), nonce, path.join(folder, 'broker-result.json'), 'manual', 'none', 'mixed-v2'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
  child.stderr.on('data', bytes => process.stderr.write(bytes));
  child.stdout.on('data', bytes => {
    output += bytes.toString('utf8');
    if (output.length > 65536) { fail(new Error('broker output exceeded limit')); return; }
    let index;
    while ((index = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, index); output = output.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('invalid broker JSON')); return; }
      if (message.v !== 1 || message.nonce !== nonce || !Number.isSafeInteger(message.sequence)) { fail(new Error('invalid broker envelope')); return; }
      if (message.type === 'ready') {
        void send('attach', { pid: process.pid, startTicks: message.startTicks, hwnd, hubMinimum })
          .then(result => {
            if (result.type !== 'attached') throw new Error('Hub attach was not acknowledged');
            return send('line-attach', { fixture: true });
          }).then(result => {
            if (result.type !== 'line-attached' || result.attached !== true || result.alive !== true) throw new Error(`Owned fixture attach/readback failed: ${JSON.stringify(result)}`);
            return send('line-hide');
          }).then(result => {
            if (result.type !== 'line-visibility' || result.visible !== false || result.verified !== true) throw new Error('Owned fixture hide/readback failed');
            return send('line-show');
          }).then(result => {
            if (result.type !== 'line-visibility' || result.visible !== true || result.verified !== true) throw new Error('Owned fixture show/readback failed');
            return send('detach-host');
          }).then(result => {
            if (result.type !== 'host-detached' || result.restored !== true || result.lineAlive !== true) throw new Error('Owned fixture normal detach/readback failed');
            settled = true; clearTimeout(timer); child.stdin.end();
          }).catch(fail);
      } else {
        const request = pending.get(message.sequence);
        if (request) { pending.delete(message.sequence); request.resolve(message); }
      }
    }
  });
  child.once('error', fail);
  child.once('exit', code => {
    if (!settled || code !== 0) { fail(new Error(`native helper exited before clean completion (${code})`)); return; }
    window.destroy(); console.log('PASS: ProductBrokerFixture owned HWND attach/show/hide/detach readbacks; no LINE process used.'); app.exit(0);
  });
  timer = setTimeout(() => fail(new Error('owned fixture lifecycle timed out')), 30000);
}
app.whenReady().then(run).catch(fail);
