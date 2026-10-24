'use strict';
const { isOfficialOrigin } = require('./permissions.cjs');

// Authentication pages may keep their opener, but never receive native APIs or
// device permissions. Custom enterprise IdPs require explicit future support.
const AUTH_HOSTS = Object.freeze({
  // Google lists accounts.youtube.com as an additional authentication URL:
  // https://knowledge.workspace.google.com/admin/getting-started/set-up-a-google-workspace-host-name-allowlist
  // Keep this exact account host scoped to Slack's Google sign-in flow.
  slack: ['accounts.google.com', 'accounts.youtube.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'],
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

// The workspace chooser's desktop-launch link stops at /ssb/redirect in an
// embedded browser. Its official "use Slack in your browser" fallback is the
// same workspace origin's root. Match only the observed chooser link, never
// rewrite OAuth callbacks or unknown authentication parameters.
function slackWorkspaceWebUrl(serviceId, value) {
  if (serviceId !== 'slack' || navigationTarget(serviceId, value) !== 'internal') return null;
  const url = new URL(value);
  if (!/^[a-z0-9][a-z0-9-]*\.slack\.com$/.test(url.hostname) ||
      ['app.slack.com', 'api.slack.com', 'slack.slack.com'].includes(url.hostname) ||
      url.pathname !== '/ssb/redirect' || url.hash ||
      url.searchParams.getAll('entry_point').length !== 1 ||
      url.searchParams.get('entry_point') !== 'your_workspaces' ||
      [...url.searchParams.keys()].some(key => !['entry_point', '_gl'].includes(key))) return null;
  return `${url.origin}/`;
}

function protectContents(contents, service, { openExternal, onPopup = () => {}, onWorkspaceLaunch }) {
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
    const workspace = slackWorkspaceWebUrl(service.id, url);
    if (workspace && onWorkspaceLaunch) {
      onWorkspaceLaunch(workspace);
      return { action: 'deny' };
    }
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
    protectContents(popup.webContents, service, { openExternal, onPopup, onWorkspaceLaunch });
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
module.exports = { navigationTarget, protectContents, slackWorkspaceWebUrl };
