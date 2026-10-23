'use strict';

// Each remote service has its own persistent Chromium storage partition.
// This does not imply that providers support embedded authentication.
const SERVICES = Object.freeze([
  Object.freeze({ id: 'telegram', title: 'Telegram', url: 'https://web.telegram.org/k/', partition: 'persist:crosschat-telegram', kind: 'web' }),
  Object.freeze({ id: 'discord', title: 'Discord', url: 'https://discord.com/app', partition: 'persist:crosschat-discord', kind: 'web' }),
  Object.freeze({ id: 'slack', title: 'Slack', url: 'https://slack.com/signin', partition: 'persist:crosschat-slack', kind: 'web' }),
  Object.freeze({ id: 'whatsapp', title: 'WhatsApp', url: 'https://web.whatsapp.com/', partition: 'persist:crosschat-whatsapp', kind: 'web' }),
  Object.freeze({ id: 'line', title: 'LINE', url: null, partition: null, kind: 'unsupported-extension' }),
]);
const SERVICE_IDS = Object.freeze(SERVICES.map(s => s.id));
const LINE_DOWNLOADS = Object.freeze({
  windows: 'https://line.me/en/download',
  mac: 'https://line.me/en/download',
  chrome: 'https://chromewebstore.google.com/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc',
});
function getService(id) { return SERVICES.find(s => s.id === id) ?? null; }
function isValidServiceId(id) { return SERVICE_IDS.includes(id); }
function safeNavigation(url) { try { const parsed = new URL(url); return parsed.protocol === 'https:'; } catch { return false; } }
module.exports = { SERVICES, SERVICE_IDS, LINE_DOWNLOADS, getService, isValidServiceId, safeNavigation };
