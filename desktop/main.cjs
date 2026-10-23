const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { randomBytes } = require('node:crypto');
const { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } = require('node:fs');
const path = require('node:path');

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
let window, hub, secrets;
const authorizedOAuthURL = raw => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (
      (u.hostname === 'slack.com' && u.pathname === '/oauth/v2/authorize') ||
      (u.hostname === 'discord.com' && u.pathname === '/oauth2/authorize')
    );
  } catch { return false; }
};
function loadDesktopSettings() {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const isNew = !existsSync(file);
  const values = isNew ? {} : JSON.parse(readFileSync(file, 'utf8'));
  let needsSave = false;
  for (const key of ['ADMIN_API_KEY', 'ENCRYPTION_KEY']) {
    if (!/^[a-f0-9]{64}$/i.test(values[key] ?? '')) {
      if (!isNew) throw new Error(`Invalid ${key} in desktop settings. Refusing to re-key an existing database.`);
      values[key] = randomBytes(32).toString('hex'); needsSave = true;
    }
  }
  if (needsSave) {
    writeFileSync(file, JSON.stringify(values, null, 2), { flag: 'w', mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows ACLs are managed by OS */ }
  }
  // OAuth app credentials are user-supplied, not hard-coded in the binary.
  return {
    ...values,
    DATABASE_PATH: path.join(dir, 'crosschat.sqlite'),
    OAUTH_CALLBACK_BASE_URL: values.OAUTH_CALLBACK_BASE_URL ?? 'http://127.0.0.1:8787',
  };
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1220, height: 840, minWidth: 900, minHeight: 630,
    title: 'CrossChat Hub',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, devTools: !app.isPackaged,
    },
  });
  const home = `http://127.0.0.1:${hub.port}`;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (authorizedOAuthURL(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${home}/`) && url !== home) event.preventDefault();
  });
  await window.loadURL(home);
}
if (hasLock) {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    try {
      secrets = loadDesktopSettings();
      const { startHub } = await import('../src/runtime.mjs');
      hub = await startHub({ env: secrets, host: '127.0.0.1', port: 8787 });
      ipcMain.handle('crosschat:admin-key', (event) => {
        if (!window || event.sender !== window.webContents) throw new Error('Untrusted renderer');
        return secrets.ADMIN_API_KEY;
      });
      await createWindow();
    } catch (error) {
      dialog.showErrorBox('CrossChat Hub 無法啟動', `${error.message}\n\n請確認 127.0.0.1:8787 未被占用。`);
      app.quit();
    }
  });
  app.on('activate', () => {
    if (hub && BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
  });
  let quitting = false;
  app.on('before-quit', event => {
    if (!hub || quitting) return;
    event.preventDefault();
    quitting = true;
    const active = hub;
    hub = null;
    active.close().catch(console.error).finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
