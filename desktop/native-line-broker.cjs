'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

function createNativeLineBroker({ binaryPath, spawnProcess = spawn, timeoutMs = 15000, platform = process.platform, getScreen = () => require('electron').screen, getStartTicks = null, makeTempDir = fs.mkdtempSync } = {}) {
  let child = null, nonce = null, sequence = 0, output = '', decoder = null, starting = null;
  let pending = new Map(), attached = false, lineEnabled = false, expectedExit = false, blocked = false;
  let desiredVisible = true, visibilityVersion = 0, appliedVisibilityVersion = 0, visibilityQueue = Promise.resolve();
  let readyResolve = null, readyReject = null;
  const listeners = new Set();
  function notify(state, detail = '') { for (const listener of listeners) listener({ state, detail }); }
  function failPending(error) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); }
  function dispose() {
    const current = child; child = null; attached = false; lineEnabled = false; blocked = false;
    if (current && current.exitCode === null) current.stdin.end();
    failPending(new Error('Native LINE broker stopped'));
  }
  function onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { blocked = true; notify('error', 'Native host response was invalid. Keep the window open and retry restoration.'); return; }
    if (!message || message.v !== 1 || message.nonce !== nonce || !Number.isSafeInteger(message.sequence)) return;
    if (message.type === 'ready') { readyResolve?.(); readyResolve = null; return; }
    if (message.type === 'close-request') { notify('close-request'); return; }
    const request = pending.get(message.sequence);
    if (!request) return;
    pending.delete(message.sequence); clearTimeout(request.timer);
    if (message.type === 'error') {
      if (message.rollbackVerified === true) { attached = false; lineEnabled = false; blocked = false; notify('host-failed-restored', message.message || 'Native host restored both windows.'); }
      else { blocked = true; notify('error', message.message || 'Native host could not verify window restoration.'); }
      request.reject(new Error(String(message.message || 'Native host operation failed'))); return;
    }
    request.resolve(message);
  }
  function send(type, fields = {}) {
    if (!child || !child.stdin.writable || (blocked && type !== 'detach-host' && type !== 'close-request-cancel')) return Promise.reject(new Error('Native LINE broker is unavailable; retry restoration first.'));
    const currentSequence = ++sequence;
    const message = { v: 1, nonce, sequence: currentSequence, type, ...fields };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(currentSequence);
        blocked = true; notify('error', 'Native host did not confirm the window operation. Keep both windows open and retry.');
        reject(new Error('Native LINE broker response timed out'));
      }, timeoutMs);
      pending.set(currentSequence, { resolve, reject, timer });
      try { child.stdin.write(JSON.stringify(message) + '\n'); }
      catch (error) { clearTimeout(timer); pending.delete(currentSequence); reject(error); }
    });
  }
  function consume(chunk) {
    output += decoder.write(chunk);
    if (output.length > 65536) { blocked = true; notify('error', 'Native host response exceeded the safety limit.'); return; }
    let index;
    while ((index = output.indexOf('\n')) >= 0) { const line = output.slice(0, index); output = output.slice(index + 1); if (line.length <= 8192) onLine(line); else { blocked = true; notify('error', 'Native host response exceeded the safety limit.'); } }
  }
  function applyDesiredVisibility() {
    const work = visibilityQueue.then(async () => {
      while (attached && lineEnabled && appliedVisibilityVersion !== visibilityVersion) {
        const version = visibilityVersion, visible = desiredVisible;
        const response = await send(visible ? 'line-show' : 'line-hide');
        if (response.type !== 'line-visibility' || response.verified !== true || response.visible !== visible) {
          blocked = true; notify('error', 'LINE 視窗狀態未能確認；請還原後重試。');
          throw new Error('Native LINE visibility was not verified');
        }
        appliedVisibilityVersion = version;
      }
      return true;
    });
    visibilityQueue = work.catch(() => {});
    return work;
  }
  async function start(window, witness) {
    if (child) throw new Error('Native LINE host is already active');
    if (platform !== 'win32' || !path.isAbsolute(binaryPath || '')) throw new Error('Windows native LINE host is unavailable');
    const folder = makeTempDir(path.join(os.tmpdir(), 'crosschat-native-line-'));
    const resultPath = path.join(folder, 'broker-result.json');
    nonce = randomBytes(24).toString('hex'); sequence = 0; output = ''; decoder = new StringDecoder('utf8'); blocked = false; expectedExit = false; appliedVisibilityVersion = 0;
    const handle = window.getNativeWindowHandle();
    const hwnd = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
    const minimum = window.getMinimumSize();
    const scale = getScreen().getDisplayMatching(window.getBounds()).scaleFactor;
    const hubMinimum = { width: Math.ceil(minimum[0] * scale), height: Math.ceil(minimum[1] * scale) };
    if (!Number.isSafeInteger(Number(hwnd)) || Number(hwnd) <= 0 || !Object.values(hubMinimum).every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192)) throw new Error('Invalid main-owned native window bounds');
    const pid = process.pid;
    const startTicks = await (getStartTicks || controllerStartTicks)(pid);
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    child = spawnProcess(binaryPath, [String(pid), nonce, resultPath, 'manual', 'none', 'mixed-v2'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
    const current = child;
    child.stderr.on('data', () => {});
    child.stdout.on('data', consume);
    child.once('error', error => { blocked = true; notify('error', 'Native LINE host could not start.'); readyReject?.(error); readyReject = null; readyResolve = null; failPending(error); });
    child.once('exit', () => {
      if (child !== current) return;
      const hadHost = attached; child = null; attached = false; lineEnabled = false;
      readyReject?.(new Error('Native LINE host exited before handshake')); readyReject = null; readyResolve = null;
      failPending(new Error('Native LINE host exited'));
      if (!expectedExit && hadHost) { blocked = true; notify('error', 'Native host exited while a window may still be attached. Check LINE before continuing.'); }
      else notify('stopped');
    });
    try {
      let readyTimer;
      await Promise.race([ready, new Promise((_resolve, reject) => { readyTimer = setTimeout(() => reject(new Error('Native host startup timed out')), timeoutMs); })]);
      clearTimeout(readyTimer);
      const handleResult = await send('attach', { pid, startTicks, hwnd, hubMinimum });
      if (handleResult.type !== 'attached') throw new Error('Native host did not attach the Hub');
      attached = true; notify('host-attached');
      const result = await send('line-attach', { lineWitness: witness });
      if (result.type === 'line-attached' && result.attached && result.alive) {
        lineEnabled = true; blocked = false; await applyDesiredVisibility(); notify('enabled'); return { state: 'enabled' };
      }
      blocked = result.type === 'line-restore-failed';
      notify(blocked ? 'restore-error' : 'attach-error', result.message || 'LINE could not be embedded.');
      return { state: blocked ? 'restore-error' : 'attach-error', detail: result.message || '' };
    } catch (error) { readyReject?.(error); readyResolve = null; readyReject = null; if (!child || !attached) blocked = true; notify('error', error.message); throw error; }
  }
  async function controllerStartTicks(pid) {
    const { execFileSync } = require('node:child_process');
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true }).trim();
  }
  return {
    onStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get active() { return Boolean(child || starting); },
    get enabled() { return Boolean(child && lineEnabled); },
    get blocked() { return blocked; },
    async enable(window, witness) {
      if (!child) {
        const pendingStart = start(window, witness);
        starting = pendingStart;
        try { return await pendingStart; }
        finally { if (starting === pendingStart) starting = null; }
      }
      if (!attached || blocked) throw new Error('Native LINE host needs restoration before another attach attempt.');
      const result = await send('line-attach', { lineWitness: witness });
      if (result.type === 'line-attached' && result.attached && result.alive) {
        lineEnabled = true; await applyDesiredVisibility(); notify('enabled'); return { state: 'enabled' };
      }
      blocked = result.type === 'line-restore-failed';
      notify(blocked ? 'restore-error' : 'attach-error', result.message || 'LINE could not be embedded.');
      return { state: blocked ? 'restore-error' : 'attach-error', detail: result.message || '' };
    },
    async setLineVisible(visible) {
      desiredVisible = Boolean(visible); visibilityVersion++;
      if (starting) await starting;
      if (!attached || !lineEnabled) return true;
      return applyDesiredVisibility();
    },
    async releaseCloseRequest() {
      if (!child) return false;
      const response = await send('close-request-cancel');
      return response.type === 'close-request-cancelled' && response.released === true;
    },
    async detachAndRestoreHub() {
      if (starting) await starting.catch(() => {});
      if (!child) return { restored: true, inactive: true };
      expectedExit = true;
      const response = await send('detach-host');
      if (response.type !== 'host-detached' || response.restored !== true) { expectedExit = false; blocked = true; return { restored: false, detail: response.message || 'Native window restoration was not verified.' }; }
      attached = false; lineEnabled = false; blocked = false;
      const current = child; child = null;
      if (current && current.exitCode === null) current.stdin.end();
      return { restored: true };
    },
  };
}

module.exports = { createNativeLineBroker };
