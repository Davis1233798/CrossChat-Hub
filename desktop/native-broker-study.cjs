'use strict';
// Developer-only native-shell integration. Never touches the normal profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function configureBrokerStudy(app) {
  if (process.env.CROSSCHAT_BROKER_STUDY !== '1') return null;
  if (process.platform !== 'win32' || app.isPackaged) throw new Error('Native broker study requires unpackaged Windows');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crosschat-broker-hub-'));
  app.setPath('userData', profile);
  fs.mkdirSync(path.join(profile, 'sessions'));
  app.setPath('sessionData', path.join(profile, 'sessions'));
  const nonce = crypto.randomBytes(24).toString('hex');
  const resultPath = path.join(profile, 'broker-result.json');
  const mode = process.env.CROSSCHAT_BROKER_TEST_MODE || 'manual';
  if (!['manual', 'normal', 'crash'].includes(mode)) throw new Error('Invalid broker test mode');
  const injection = process.env.CROSSCHAT_BROKER_FAIL_AT || 'none';
  if (!['none', 'after-hub-parent', 'after-fixture-parent', 'after-resize', 'stdio-eof'].includes(injection)) throw new Error('Invalid broker failure injection');
  const dpiMode = process.env.CROSSCHAT_BROKER_DPI || 'strict-v1';
  if (!['strict-v1', 'mixed-v2'].includes(dpiMode)) throw new Error('Invalid broker DPI study mode');
  const binary = path.join(__dirname, '..', 'build', 'bin', 'native-host', dpiMode === 'mixed-v2' ? 'HubBrokerMixed.exe' : 'HubBroker.exe');
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) throw new Error('Build the fixed HubBroker.exe before enabling broker study');
  let server, origin, sidecar, attached = false, shuttingDown = false, failed = false;
  const urlPath = '/' + crypto.randomBytes(20).toString('hex');
  const evidence = { profile, resultPath, mode, injection, dpiMode, controllerPid: process.pid };
  fs.writeFileSync(path.join(profile, 'study.json'), JSON.stringify(evidence));
  console.log('CROSSCHAT_BROKER_STUDY ' + JSON.stringify(evidence));
  function write(type, fields = {}) {
    if (sidecar?.stdin.writable) sidecar.stdin.write(JSON.stringify({ v: 1, nonce, type, ...fields }) + '\n');
  }
  return {
    profile,
    async start() {
      server = http.createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== urlPath || req.headers.host !== new URL(origin).host) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'" });
        res.end('<!doctype html><meta charset="utf-8"><title>Synthetic chat — isolated Hub</title><style>body{background:#13243a;color:#e6f0ff;font:18px system-ui;padding:32px}strong{color:#75e3b0}</style><h1>Hub synthetic chat</h1><p><strong>Only loopback fixture content.</strong></p><p>Real Hub tabs and composer remain available below. No platform account or messages are loaded.</p>');
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      origin = 'http://127.0.0.1:' + server.address().port;
    },
    createView(WebContentsView) {
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: 'broker-study-' + nonce } });
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', (event, url) => { if (url !== origin + urlPath) event.preventDefault(); });
      view.webContents.on('will-redirect', event => event.preventDefault());
      view.webContents.loadURL(origin + urlPath);
      return view;
    },
    async attach(window, quit) {
      // Independent process group: controller console teardown must not kill
      // the root-owning broker before it can restore its synthetic child.
      sidecar = spawn(binary, [String(process.pid), nonce, resultPath, mode, injection, dpiMode], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: false });
      sidecar.stderr.on('data', bytes => console.error('Native broker:', bytes.toString().slice(0, 512)));
      const handle = window.getNativeWindowHandle();
      const hwnd = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
      let pending = '', ready = false;
      const done = new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          failed = true;
          // Closing input requests broker rollback BEFORE main rejects and may
          // exit. Broker emits error only after restoring changed live HWNDs.
          sidecar.stdin.end();
        }, 15000);
        const fail = error => { failed = true; clearTimeout(timer); if (!settled) { settled = true; reject(error); } };
        const requestRollback = error => {
          failed = true; clearTimeout(timer);
          console.error('Native broker protocol failure; requesting rollback:', error.message);
          if (sidecar.stdin.writable) sidecar.stdin.end();
        };
        sidecar.stdin.on('error', () => { /* EOF/exit is handled by sidecar acknowledgement or exit. */ });
        sidecar.once('error', fail);
        sidecar.once('exit', code => { if (!attached) fail(new Error('Native broker exited before attachment: ' + code)); else if (!shuttingDown) { failed = true; quit(); } });
        sidecar.stdout.on('data', bytes => {
          pending += bytes.toString('utf8');
          if (pending.length > 8192) { pending = ''; requestRollback(new Error('Broker protocol overflow')); return; }
          for (;;) {
            const index = pending.indexOf('\n'); if (index < 0) break;
            const line = pending.slice(0, index); pending = pending.slice(index + 1);
            try {
              if (line.length > 4096) throw new Error('Broker line too long');
              const msg = JSON.parse(line);
              if (msg.v !== 1 || msg.nonce !== nonce) throw new Error('Broker handshake identity mismatch');
              if (msg.type === 'ready' && !ready) { ready = true; write('attach', { pid: process.pid, hwnd, startTicks: msg.startTicks }); }
              else if (msg.type === 'attached' && ready && !attached) {
                attached = true; clearTimeout(timer); window.show(); settled = true; resolve(msg);
                if (injection === 'stdio-eof') sidecar.stdin.end();
                else if (mode !== 'manual') setTimeout(() => { write('resize-check'); setTimeout(() => mode === 'normal' ? quit() : process.exit(73), 1500); }, 1500);
              } else if (msg.type === 'close-request') quit();
              else if (msg.type === 'focus-hub') window.focus();
              else if (msg.type === 'error') {
                failed = true;
                // An existing normal-close callback can otherwise race the
                // startup rejection and return code 0. Exit only AFTER broker
                // has acknowledged restoration of every changed live window.
                if (msg.rollbackVerified === true) {
                  console.error('Native broker failed; rollback verified:', msg.message);
                  app.exit(1);
                  return;
                }
                // Do not tear down the controller after incomplete rollback.
                // Keep both processes alive for diagnosis with a failed state.
                console.error('Native broker failed; rollback incomplete:', msg.message);
                clearTimeout(timer);
                continue;
              }
              else if (msg.type !== 'resized') throw new Error('Unexpected broker protocol message');
            } catch (error) { requestRollback(error); }
          }
        });
      });
      return done;
    },
    beginShutdown() { shuttingDown = true; write('shutdown'); server?.close(); },
    // In this mode external links, clearing account state and permissions must
    // not touch a real platform or open any authentication flow.
    get attached() { return attached; },
    get failed() { return failed; },
  };
}
module.exports = { configureBrokerStudy };
