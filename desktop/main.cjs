'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, shell, session, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SERVICES, LINE_DOWNLOADS, getService } = require('./tab-config.cjs');
const { protectContents } = require('./navigation.cjs');
const { createShutdown, flushSessions } = require('./lifecycle.cjs');
const { createSessionReset } = require('./session-data.cjs');
const { createResetIntentStore } = require('./reset-intent.cjs');
const { createForwardingLedger } = require('./forwarding-ledger.cjs');
const { registerForwardingIpc } = require('./forwarding-ipc.cjs');
const { isOfficialOrigin, canCheckPermission, needsUserApproval } = require('./permissions.cjs');

// Each official site runs in its own hardened, persistent Chromium profile.
// This is not an API bridge: no password interception, cookie export, or
// injection into a remote messenger is performed.
const HEADER_HEIGHT = 116;
const COMPOSER_HEIGHT = 184;
const singleInstance = app.requestSingleInstanceLock();
let mainWindow = null;
let currentId = null;
let currentView = null;
const views = new Map();
const configuredPartitions = new Set();
const permissionGrants = new Set();
const popupWindows = new Map();
const permissionVersions = new Map();
const activeDownloads = new Map();
let externalPromptPending = false;
let closing = false;

if (!singleInstance) app.quit();

function isTrustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}
function viewBounds() {
  if (!mainWindow) return { x: 0, y: HEADER_HEIGHT, width: 1000, height: 650 };
  const { width, height } = mainWindow.getContentBounds();
  return { x: 0, y: HEADER_HEIGHT, width, height: Math.max(1, height - HEADER_HEIGHT - COMPOSER_HEIGHT) };
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
  isolated.setPermissionCheckHandler((_wc, permission, origin) => !closing && !profileReset.isBlocked(service.id) && canCheckPermission(service.id, origin, permission));
  isolated.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (closing || profileReset.isBlocked(service.id)) return callback(false);
    const version = permissionVersions.get(service.id) || 0;
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
      const allowed = response === 1 && !closing && !profileReset.isBlocked(service.id) && version === (permissionVersions.get(service.id) || 0);
      if (allowed) permissionGrants.add(key);
      callback(allowed);
    }).catch(() => callback(false));
  });

  isolated.on('will-download', (_event, item, _contents) => {
    if (closing || profileReset.isBlocked(service.id)) { _event.preventDefault(); return; }
    if (!activeDownloads.has(service.id)) activeDownloads.set(service.id, new Set());
    activeDownloads.get(service.id).add(item);
    // Let the user choose the destination; do not silently accept download paths.
    const cleanName = path.basename(item.getFilename().replace(/[\\/]/g, '_')) || 'download';
    item.setSaveDialogOptions({
      title: `儲存 ${service.title} 附件`,
      defaultPath: path.join(app.getPath('downloads'), cleanName),
      buttonLabel: '儲存',
    });
    item.once('done', (_e, state) => {
      activeDownloads.get(service.id)?.delete(item);
      if (!profileReset.isBlocked(service.id)) announce(service.id, state === 'completed' ? 'downloaded' : 'download-error');
    });
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
  const report = (state, detail) => {
    if (views.get(service.id) === view && !wc.isDestroyed() && !profileReset.isBlocked(service.id)) announce(service.id, state, detail);
  };
  protectContents(wc, service, { openExternal: async url => {
    if (closing || externalPromptPending || !mainWindow || mainWindow.isDestroyed()) return;
    externalPromptPending = true;
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: '開啟外部網站',
        message: `要在系統瀏覽器開啟 ${new URL(url).origin}？`,
        detail: '此網站不在此平台的內嵌登入清單中。外部登入不會同步回本程式；自訂企業 SSO 可能無法完成登入。',
        buttons: ['取消', '開啟瀏覽器'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response === 1 && !closing) await shell.openExternal(url);
    } catch { announce(service.id, 'external-error'); }
    finally { externalPromptPending = false; }
  }, onWorkspaceLaunch: url => {
    if (closing || wc.isDestroyed() || profileReset.isBlocked(service.id)) return;
    chooseTab(service.id);
    wc.loadURL(url).catch(error => report('failed', String(error.message)));
  }, onPopup: popup => {
    popupWindows.set(popup, service.id);
    popup.once('closed', () => popupWindows.delete(popup));
    attachHotkeys(popup.webContents);
  } });
  attachHotkeys(wc);
  wc.on('did-start-loading', () => report('loading'));
  wc.on('did-finish-load', () => report('loaded'));
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) report('failed', `${code} ${description}`);
  });
  wc.on('page-title-updated', (_event, title) => {
    const count = title.match(/^\((\d+)\)/)?.[1];
    report('title', count ? String(Math.min(Number(count), 999)) : '');
  });
  views.set(service.id, view);
  wc.loadURL(service.url).catch(error => report('failed', String(error.message)));
  return view;
}
function chooseTab(id) {
  const service = getService(id);
  if (!service) throw new Error('Unknown service');
  if (!mainWindow || mainWindow.isDestroyed() || closing) return;
  if (currentView) { mainWindow.contentView.removeChildView(currentView); currentView = null; }
  currentId = id;
  announce(id, 'selected');
  if (service.kind === 'web' && !profileReset.isBlocked(id)) {
    currentView = tabView(service);
    mainWindow.contentView.addChildView(currentView);
    currentView.setBounds(viewBounds());
    currentView.webContents.focus();
  }
  announce(id, service.kind !== 'web' ? 'unsupported' : profileReset.isBlocked(id) ? (profileReset.isPending(id) ? 'resetting' : 'reset-error') : (currentView.webContents.isLoading() ? 'loading' : 'loaded'));
}
function destroyServiceWriters(service) {
  const view = views.get(service.id);
  if (view && currentView === view) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
    currentView = null;
  }
  if (view && !view.webContents.isDestroyed()) view.webContents.destroy();
  views.delete(service.id);
  for (const [popup, id] of popupWindows) {
    if (id === service.id && !popup.isDestroyed()) popup.destroy();
  }
  for (const item of activeDownloads.get(service.id) || []) item.cancel();
  activeDownloads.delete(service.id);
}
const resetIntents = createResetIntentStore(path.join(app.getPath('userData'), 'pending-profile-resets'), SERVICES.filter(service => service.kind === 'web').map(service => service.id));
const profileReset = createSessionReset({
  initialBlocked: resetIntents.pending(), persistIntent: resetIntents.mark, clearIntent: resetIntents.clear,
  getService, getSession: service => configureSession(service),
  isClosing: () => closing,
  confirm: async service => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: `清除 ${service.title} 本機登入資料`,
      message: `要清除 ${service.title} 在此裝置上的登入與網站資料？`,
      detail: '此平台的視窗和未完成下載會關閉，下次使用需要重新登入。其他平台、其他裝置及已儲存的附件不受影響。這不會撤銷伺服器端的裝置授權；請使用官方平台的裝置管理功能。',
      buttons: ['取消', '清除本機資料'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return response === 1;
  },
  destroyWriters: destroyServiceWriters,
  revokePermissions: id => {
    permissionVersions.set(id, (permissionVersions.get(id) || 0) + 1);
    for (const key of permissionGrants) if (key.startsWith(`${id}|`)) permissionGrants.delete(key);
    announce(id, 'title', '');
  },
  onState: (id, state) => {
    announce(id, state);
    if (state === 'cleared' && !closing && currentId === id) chooseTab(id);
  },
});
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
const quitSafely = createShutdown({
  prepare: () => {
    closing = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    // Stop every remote writer, including authentication popups, before flushing.
    for (const popup of popupWindows.keys()) if (!popup.isDestroyed()) popup.destroy();
    popupWindows.clear();
    if (currentView && mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(currentView);
    currentView = null;
    for (const view of views.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.destroy();
    }
    views.clear();
  },
  flush: async () => {
    await profileReset.waitForActive();
    await flushSessions([session.defaultSession, ...[...configuredPartitions].map(partition => session.fromPartition(partition))]);
  },
  exit: code => app.exit(code),
  onFailure: () => console.error('Desktop session persistence failed or timed out during shutdown.'),
});
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
  mainWindow.on('close', event => { event.preventDefault(); void quitSafely(); });
  mainWindow.on('closed', () => { void quitSafely(); });
  await mainWindow.loadFile(path.join(__dirname, 'shell.html'));
  if (!closing) mainWindow.show();
}
if (singleInstance) {
  app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    const { createForwardingDrafts } = await import('./forwarding-drafts.mjs');
    const drafts = createForwardingDrafts({
      ledger: createForwardingLedger(path.join(app.getPath('userData'), 'forwarding-ledger')),
      // No verified personal-chat UI adapter is registered yet.
    });
    registerForwardingIpc(ipcMain, () => mainWindow, pathToFileURL(path.join(__dirname, 'shell.html')).href, drafts);
    ipcMain.handle('crosschat:tab-switch', (event, id) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      chooseTab(id); return true;
    });
    ipcMain.handle('crosschat:tab-reload', (event, id) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      if (closing || profileReset.isBlocked(id)) return false;
      const wc = views.get(id)?.webContents;
      if (currentId !== id || !wc || wc.isDestroyed()) return false;
      wc.reload(); return true;
    });
    ipcMain.handle('crosschat:profile-clear', (event, id) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer');
      return profileReset.request(id);
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
      void quitSafely();
    });
    await openWindow();
  }).catch(error => { console.error('Desktop failed to start:', error); app.exit(1); });
  app.on('before-quit', event => { event.preventDefault(); void quitSafely(); });
  app.on('window-all-closed', () => { void quitSafely(); });
}
