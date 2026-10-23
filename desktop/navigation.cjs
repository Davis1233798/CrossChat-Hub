'use strict';
const { isOfficialOrigin } = require('./permissions.cjs');

// Authentication pages may keep their opener, but never receive native APIs or
// device permissions. Custom enterprise IdPs require explicit future support.
const AUTH_HOSTS = Object.freeze({
  slack: ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'],
  discord: [], telegram: [], whatsapp: [],
});
function navigationTarget(serviceId, value) {
  let url;
  try { url = new URL(value); } catch { return 'deny'; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return 'deny';
  if (isOfficialOrigin(serviceId, url.href)) return 'internal';
  if ((AUTH_HOSTS[serviceId] ?? []).includes(url.hostname)) return 'internal';
  return 'external';
}

function protectContents(contents, service, { openExternal, onPopup = () => {} }) {
  const navigate = (event, url, _inPlace, isMainFrame = true) => {
    if (!isMainFrame) return;
    const target = navigationTarget(service.id, url);
    if (target === 'internal') return;
    event.preventDefault();
    if (target === 'external') openExternal(url);
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
  contents.setWindowOpenHandler(({ url }) => {
    const target = navigationTarget(service.id, url);
    if (target !== 'internal') {
      if (target === 'external') openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: {
      width: 830, height: 790, autoHideMenuBar: true,
      webPreferences: {
        partition: service.partition, sandbox: true, nodeIntegration: false,
        contextIsolation: true, webSecurity: true, allowRunningInsecureContent: false,
      },
    } };
  });
  contents.on('did-create-window', popup => {
    onPopup(popup);
    protectContents(popup.webContents, service, { openExternal, onPopup });
    // An authentication origin must be visible even if a page supplies a
    // misleading document title. Include path neither here nor in logs.
    const updateTitle = () => {
      if (popup.isDestroyed()) return;
      try { popup.setTitle(`${service.title} · ${new URL(popup.webContents.getURL()).origin}`); } catch {}
    };
    popup.webContents.on('page-title-updated', event => { event.preventDefault(); updateTitle(); });
    popup.webContents.on('did-navigate', updateTitle);
    updateTitle();
  });
}
module.exports = { navigationTarget, protectContents };
