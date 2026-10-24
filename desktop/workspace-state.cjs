'use strict';
const fs = require('node:fs');
const path = require('node:path');

// This is a navigation preference, never authentication or a delivery receipt.
function canonicalSlackWorkspace(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'app.slack.com' ||
      url.username || url.password || (url.port && url.port !== '443')) return null;
  const team = /^\/client\/(T[A-Z0-9]+)(?:\/|$)/.exec(url.pathname)?.[1];
  return team ? `https://app.slack.com/client/${team}` : null;
}

function createWorkspaceState(directory) {
  const filename = path.join(directory, 'slack.json');
  return {
    read() {
      try {
        if (fs.statSync(filename).size > 512) return null;
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        return data?.version === 1 && canonicalSlackWorkspace(data.workspace) === data.workspace ? data.workspace : null;
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
      }
    },
    record(value) {
      const workspace = canonicalSlackWorkspace(value);
      if (!workspace) return false;
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.tmp`;
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'w', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ version: 1, workspace }));
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filename);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return true;
    },
    clear() {
      try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}
module.exports = { canonicalSlackWorkspace, createWorkspaceState };
