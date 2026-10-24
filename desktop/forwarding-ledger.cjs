'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Exclusive creation is the cross-process arbiter. Never remove reservations:
// a crash/partial write must block blind retries, not make another send possible.
function createForwardingLedger(directory) {
  const owned = new Set();
  const keyPath = (key, suffix) => {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid delivery key');
    return path.join(directory, `${key}.${suffix}`);
  };
  function writeExclusive(file, value) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  function read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof SyntaxError) return { status: 'unknown' }; throw error; }
  }
  return {
    claim(key) {
      const file = keyPath(key, 'claim');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { writeExclusive(file, { version: 1, status: 'pending', createdAt: Date.now() }); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      owned.add(key);
      return true; // Only after reservation flush succeeds can UI execute.
    },
    settle(key, outcome) {
      const file = keyPath(key, 'outcome');
      if (!['submitted', 'unknown'].includes(outcome?.status)) throw new Error('Invalid delivery outcome');
      let receipt;
      if (outcome.status === 'submitted') {
        const r = outcome.receipt;
        const valid = value => typeof value === 'string' && value.trim() && value.length <= 1024;
        if (!r || !valid(r.messageId) || !r.target || !['line', 'telegram', 'discord', 'slack', 'whatsapp'].includes(r.target.platform) ||
            !valid(r.target.accountId) || !valid(r.target.chatId)) throw new Error('Invalid submission receipt');
        receipt = { messageId: r.messageId, target: { platform: r.target.platform, accountId: r.target.accountId, chatId: r.target.chatId } };
      }
      if (!owned.has(key)) {
        const settled = read(file);
        if (settled?.status === outcome.status && JSON.stringify(settled.receipt) === JSON.stringify(receipt)) return;
        throw new Error('Delivery reservation not owned by this ledger');
      }
      // Deliberate allowlist: no message body, attachment paths, arbitrary
      // adapter payloads, tokens or credentials are persisted.
      writeExclusive(file, { version: 1, status: outcome.status, settledAt: Date.now(), ...(receipt ? { receipt } : {}) });
      owned.delete(key);
    },
    get(key) {
      const claim = read(keyPath(key, 'claim'));
      if (!claim) return null;
      const outcome = read(keyPath(key, 'outcome'));
      if (outcome && ['submitted', 'unknown'].includes(outcome.status)) return outcome;
      return { version: 1, status: owned.has(key) ? 'pending' : 'unknown' };
    },
  };
}
module.exports = { createForwardingLedger };
