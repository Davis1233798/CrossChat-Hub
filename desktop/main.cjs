'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SERVICES, LINE_DOWNLOADS, getService, safeNavigation } = require('./tab-config.cjs');

// A browser-like desktop workspace; service pages do not get Node.js access.
// Each platform retains its own cookies and local storage between restarts.
const HEADER_HEIGHT = 116;
const singleInstance = app.requestSingleInstanceLock();
let mainWindow = null;
let currentId = null;
let currentView = null;
const views = new Map();

if (!singleInstance) app.quit();

function isTrustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}
function viewBounds() {
  if (!mainWindow) return { x: 0, y: HEADER_HEIGHT, width: 1000, height: 650 };
  const { width, height } = mainWindow.getContentBounds();
  return { x: 0, y: HEADER_HEIGHT, width, height: Math.max(1, height - HEADER_HEIGHT) };
}
function announce(id, state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('crosschat:tab-status', { id, state });
}
function tabView(service) {
  const existing = views.get(service.id);
  if (existing) return existing;
  const view = new WebContentsView({
    webPreferences: {
      partition: service.partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  });
  view.setBackgroundColor('#0b1220');
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (!safeNavigation(url)) return { action: 'deny' };
    // OAuth/SSO pages may require a popup. Preserve the platform's session.
    return { action: 'allow', overrideBrowserWindowOptions: {
      width: 780, height: 760,
      webPreferences: { partition: service.partition, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true },
    } };
  });
  wc.on('will-navigate', (e, url) => { if (!safeNavigation(url)) e.preventDefault(); });
  wc.on('did-start-loading', () => announce(service.id, 'loading'));
  wc.on('did-finish-load', () => announce(service.id, 'loaded'));
  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) announce(service.id, 'failed');
  });
  // Neither microphone/camera nor clipboard read permissions are silently granted.
  const isolatedSession = session.fromPartition(service.partition);
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  views.set(service.id, view);
  wc.loadURL(service.url).catch(() => announce(service.id, 'failed'));
  return view;
}
function chooseTab(id) {
  const service = getService(id);
  if (!service) throw new Error('Unknown service');
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (currentView) {
    mainWindow.contentView.removeChildView(currentView);
    currentView = null;
  }
  currentId = id;
  if (service.kind === 'web') {
    currentView = tabView(service);
    mainWindow.contentView.addChildView(currentView);
    currentView.setBounds(viewBounds());
    currentView.webContents.focus();
  }
  announce(id, service.kind !== 'web' ? 'unsupported' : (currentView?.webContents.isLoading() ? 'loading' : 'loaded'));
}
function attachHotkeys(webContents) {
  webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const index = Number(input.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < SERVICES.length) chooseTab(SERVICES[index].id);
  });
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
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== pathToFileURL(path.join(__dirname, 'shell.html')).href) e.preventDefault();
  });
  attachHotkeys(mainWindow.webContents);
  mainWindow.on('resize', () => currentView?.setBounds(viewBounds()));
  mainWindow.on('closed', () => { mainWindow = null; currentView = null; app.quit(); });
  await mainWindow.loadFile(path.join(__dirname, 'shell.html'));
  mainWindow.show();
}
if (singleInstance) {
  app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    // No local daemon or port dependency at launch: a clean process shutdown
    // also prevents the previous v0.3.x installer from remaining locked.
    ipcMain.handle('crosschat:tab-switch', (event, id) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      chooseTab(id);
      return true;
    });
    ipcMain.handle('crosschat:tab-reload', (event, id) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      if (currentId !== id || !getService(id)?.url) return false;
      views.get(id)?.webContents.reload();
      return true;
    });
    ipcMain.handle('crosschat:line-official', (event, kind) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      const url = kind === 'chrome' ? LINE_DOWNLOADS.chrome : LINE_DOWNLOADS[process.platform === 'darwin' ? 'mac' : 'windows'];
      if (!url) return false;
      return shell.openExternal(url).then(() => true);
    });
    ipcMain.handle('crosschat:quit', (event) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      // Don't wait for remote sites, sockets, or any background service.
      app.exit(0);
    });
    await openWindow();
  }).catch(error => { console.error('Desktop failed to start:', error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
