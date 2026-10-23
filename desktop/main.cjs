'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, shell, session, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SERVICES, LINE_DOWNLOADS, getService, safeNavigation } = require('./tab-config.cjs');
const { isOfficialOrigin, canCheckPermission, needsUserApproval } = require('./permissions.cjs');

// Each official site runs in its own hardened, persistent Chromium profile.
// This is not an API bridge: no password interception, cookie export, or
// injection into a remote messenger is performed.
const HEADER_HEIGHT = 116;
const singleInstance = app.requestSingleInstanceLock();
let mainWindow = null;
let currentId = null;
let currentView = null;
const views = new Map();
const configuredPartitions = new Set();
const permissionGrants = new Set();
let closing = false;

if (!singleInstance) app.quit();

function isTrustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}
function viewBounds() {
  if (!mainWindow) return { x: 0, y: HEADER_HEIGHT, width: 1000, height: 650 };
  const { width, height } = mainWindow.getContentBounds();
  return { x: 0, y: HEADER_HEIGHT, width, height: Math.max(1, height - HEADER_HEIGHT) };
}
function announce(id, state, detail = '') {
  if (!closing && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('crosschat:tab-status', { id, state, detail });
  }
}
function officialOriginForRequest(service, wc, details) {
  const from = details?.requestingUrl || details?.securityOrigin || details?.requestingOrigin || wc?.getURL?.() || '';
  return isOfficialOrigin(service.id, from) ? new URL(from).origin : null;
}
function configureSession(service) {
  if (configuredPartitions.has(service.partition)) return session.fromPartition(service.partition);
  configuredPartitions.add(service.partition);
  const isolated = session.fromPartition(service.partition);

  // Chromium first checks permissions synchronously, then requests consent.
  // Never permit a third-party link or embedded frame to access devices.
  isolated.setPermissionCheckHandler((_wc, permission, origin) => canCheckPermission(service.id, origin, permission));
  isolated.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = officialOriginForRequest(service, wc, details);
    if (!origin || !canCheckPermission(service.id, origin, permission)) return callback(false);
    if (!needsUserApproval(permission)) return callback(true);
    const key = `${service.id}|${origin}|${permission}`;
    if (permissionGrants.has(key)) return callback(true);
    const info = permission === 'media' ? '麥克風或攝影機' : '系統通知';
    dialog.showMessageBox(mainWindow, {
      type: 'question', title: `${service.title} 要求權限`,
      message: `允許 ${service.title} (${origin}) 使用${info}？`,
      detail: '只有本次執行期間會記住授權。你可以拒絕而繼續使用一般文字聊天。',
      buttons: ['拒絕', '允許'], defaultId: 0, cancelId: 0, noLink: true,
    }).then(({ response }) => {
      if (response === 1) permissionGrants.add(key);
      callback(response === 1);
    }).catch(() => callback(false));
  });

  isolated.on('will-download', (_event, item, _contents) => {
    // Let the user choose the destination; do not silently accept download paths.
    const cleanName = path.basename(item.getFilename().replace(/[\\/]/g, '_')) || 'download';
    item.setSaveDialogOptions({
      title: `儲存 ${service.title} 附件`,
      defaultPath: path.join(app.getPath('downloads'), cleanName),
      buttonLabel: '儲存',
    });
    item.once('done', (_e, state) => announce(service.id, state === 'completed' ? 'downloaded' : 'download-error'));
  });
  return isolated;
}
function tabView(service) {
  const existing = views.get(service.id);
  if (existing && !existing.webContents.isDestroyed()) return existing;
  configureSession(service);
  const view = new WebContentsView({
    webPreferences: {
      partition: service.partition,
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
      spellcheck: true,
    },
  });
  view.setBackgroundColor('#0b1220');
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (!safeNavigation(url)) return { action: 'deny' };
    // Preserve the opener relationship for provider OAuth and phone/QR login.
    // Each popup inherits the same isolated platform profile.
    return { action: 'allow', overrideBrowserWindowOptions: {
      width: 830, height: 790,
      webPreferences: {
        partition: service.partition, sandbox: true, nodeIntegration: false,
        contextIsolation: true, webSecurity: true,
      },
    } };
  });
  wc.on('will-navigate', (event, url) => { if (!safeNavigation(url)) event.preventDefault(); });
  wc.on('did-start-loading', () => announce(service.id, 'loading'));
  wc.on('did-finish-load', () => announce(service.id, 'loaded'));
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) announce(service.id, 'failed', `${code} ${description}`);
  });
  wc.on('page-title-updated', (_event, title) => {
    const count = title.match(/^\((\d+)\)/)?.[1];
    announce(service.id, 'title', count ? String(Math.min(Number(count), 999)) : '');
  });
  views.set(service.id, view);
  wc.loadURL(service.url).catch(error => announce(service.id, 'failed', String(error.message)));
  return view;
}
function chooseTab(id) {
  const service = getService(id);
  if (!service) throw new Error('Unknown service');
  if (!mainWindow || mainWindow.isDestroyed() || closing) return;
  if (currentView) { mainWindow.contentView.removeChildView(currentView); currentView = null; }
  currentId = id;
  if (service.kind === 'web') {
    currentView = tabView(service);
    mainWindow.contentView.addChildView(currentView);
    currentView.setBounds(viewBounds());
    currentView.webContents.focus();
  }
  announce(id, service.kind !== 'web' ? 'unsupported' : (currentView.webContents.isLoading() ? 'loading' : 'loaded'));
}
function attachHotkeys(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const index = Number(input.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < SERVICES.length) {
      event.preventDefault();
      chooseTab(SERVICES[index].id);
    }
    if (input.key.toLowerCase() === 'r') {
      event.preventDefault();
      const wc = views.get(currentId)?.webContents;
      if (wc && !wc.isDestroyed()) wc.reload();
    }
  });
}
function quitImmediately() {
  if (closing) return;
  closing = true;
  for (const view of views.values()) {
    if (!view.webContents.isDestroyed()) view.webContents.destroy();
  }
  views.clear();
  app.exit(0);
}
async function openWindow() {
  mainWindow = new BrowserWindow({
    title: 'CrossChat Hub', show: false,
    width: 1320, height: 850, minWidth: 920, minHeight: 620,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(path.join(__dirname, 'shell.html')).href) event.preventDefault();
  });
  attachHotkeys(mainWindow.webContents);
  mainWindow.on('resize', () => currentView?.setBounds(viewBounds()));
  mainWindow.on('closed', quitImmediately);
  await mainWindow.loadFile(path.join(__dirname, 'shell.html'));
  if (!closing) mainWindow.show();
}
if (singleInstance) {
  app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    ipcMain.handle('crosschat:tab-switch', (event, id) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      chooseTab(id); return true;
    });
    ipcMain.handle('crosschat:tab-reload', (event, id) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      const wc = views.get(id)?.webContents;
      if (currentId !== id || !wc || wc.isDestroyed()) return false;
      wc.reload(); return true;
    });
    ipcMain.handle('crosschat:open-browser', (event, id) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      const service = getService(id);
      if (!service?.url) return false;
      return shell.openExternal(service.url).then(() => true);
    });
    ipcMain.handle('crosschat:line-official', (event, kind) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      const url = kind === 'chrome' ? LINE_DOWNLOADS.chrome : LINE_DOWNLOADS[process.platform === 'darwin' ? 'mac' : 'windows'];
      if (!url) return false;
      return shell.openExternal(url).then(() => true);
    });
    ipcMain.handle('crosschat:quit', event => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      quitImmediately();
    });
    await openWindow();
  }).catch(error => { console.error('Desktop failed to start:', error); app.exit(1); });
  app.on('window-all-closed', quitImmediately);
}
