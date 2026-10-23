'use strict';
// Permissions apply only to the official domain hosting a service, never to arbitrary
// OAuth redirects, third-party iframes, or message links.
const OFFICIAL_HOSTS = Object.freeze({
  telegram: ['web.telegram.org', 'telegram.org'],
  discord: ['discord.com'],
  slack: ['slack.com'],
  whatsapp: ['web.whatsapp.com', 'whatsapp.com'],
});
const USER_PERMISSIONS = new Set(['media', 'notifications']);
const SAFE_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
function isOfficialOrigin(id, origin) {
  try {
    const uri = new URL(origin);
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.port && uri.port !== '443') return false;
    return (OFFICIAL_HOSTS[id] ?? []).some(host => uri.hostname === host || uri.hostname.endsWith(`.${host}`));
  } catch { return false; }
}
function canCheckPermission(id, origin, permission) {
  return isOfficialOrigin(id, origin) && (USER_PERMISSIONS.has(permission) || SAFE_PERMISSIONS.has(permission));
}
function needsUserApproval(permission) { return USER_PERMISSIONS.has(permission); }
module.exports = { OFFICIAL_HOSTS, isOfficialOrigin, canCheckPermission, needsUserApproval };
