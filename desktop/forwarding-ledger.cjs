'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Exclusive creation is the cross-process arbiter. Never remove reservations:
// a crash/partial write must block blind retries, not make another send possible.
function createForwardingLedger(directory) {
  const owned = new Set();
  const historyRefs = new Map();
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
  function publishOutcome(file, value) {
    // Do not expose a success-shaped JSON file before its flush succeeds.
    // Hard-link publication is atomic and exclusive, unlike rename on hosts
    // where an existing outcome could be replaced. A failed flush leaves only
    // the claim (and possibly an ignored temporary file), so recovery is unknown.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeExclusive(temporary, value);
      fs.linkSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* Claim remains the retry barrier. */ }
    }
  }
  return {
    claim(key, routing = null) {
      const file = keyPath(key, 'claim');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      let safeRouting;
      if (routing !== null) {
        if (routing?.version !== 1 || routing.platform !== 'slack' || !/^T[A-Z0-9]+$/.test(routing.teamId ?? '') || !/^[CGD][A-Z0-9]+$/.test(routing.chatId ?? '')) throw new Error('Invalid forwarding routing metadata');
        safeRouting = { version: 1, platform: 'slack', teamId: routing.teamId, chatId: routing.chatId };
      }
      try { writeExclusive(file, { version: 1, status: 'pending', createdAt: Date.now(), ...(safeRouting ? { routing: safeRouting } : {}) }); }
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
      try {
        publishOutcome(file, { version: 1, status: outcome.status, settledAt: Date.now(), ...(receipt ? { receipt } : {}) });
      } finally {
        // A persistence error after sending is uncertain even in this process.
        owned.delete(key);
      }
    },
    get(key) {
      const claim = read(keyPath(key, 'claim'));
      if (!claim) return null;
      const outcome = read(keyPath(key, 'outcome'));
      if (outcome && ['submitted', 'unknown'].includes(outcome.status)) return outcome;
      return { version: 1, status: owned.has(key) ? 'pending' : 'unknown' };
    },
    listRecent(limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid history limit');
      let dir;
      try {
        const dirStat = fs.lstatSync(directory);
        if (!dirStat.isDirectory()) return [];
        dir = fs.opendirSync(directory);
      } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      // Bound total directory work as well as returned records. Never follow
      // links and never expose filesystem names or the delivery key to renderer.
      const names = [];
      try { for (let i = 0; i < 1000; i++) { const entry = dir.readSync(); if (!entry) break; names.push(entry.name); } }
      finally { dir.closeSync(); }
      const keys = new Set();
      for (const name of names) {
        const match = /^([a-f0-9]{64})\.(claim|outcome)$/.exec(name);
        if (!match) continue;
        try { if (fs.lstatSync(path.join(directory, name)).isFile()) keys.add(match[1]); } catch { /* damaged entry is omitted */ }
      }
      const rows = [];
      for (const key of keys) {
        let claim, outcome;
        try {
          const claimPath = keyPath(key, 'claim');
          const stat = fs.lstatSync(claimPath);
          if (!stat.isFile() || stat.size > 16_384) continue;
          claim = read(claimPath);
          if (!claim || typeof claim !== 'object' || !Number.isFinite(claim.createdAt) || claim.createdAt < 0) claim = null;
          const outcomePath = keyPath(key, 'outcome');
          const outStat = fs.existsSync(outcomePath) ? fs.lstatSync(outcomePath) : null;
          if (outStat && outStat.isFile() && outStat.size <= 16_384) outcome = read(outcomePath);
          else outcome = null;
        } catch { claim = null; outcome = null; }
        const validReceipt = outcome?.receipt && typeof outcome.receipt.messageId === 'string' && outcome.receipt.messageId.length <= 1024 &&
          ['line', 'telegram', 'discord', 'slack', 'whatsapp'].includes(outcome.receipt.target?.platform) &&
          typeof outcome.receipt.target?.chatId === 'string' && outcome.receipt.target.chatId.length <= 1024;
        const effective = claim && claim.version === 1 && ['submitted', 'pending'].includes(claim.status)
          ? outcome && outcome.version === 1 && ['submitted', 'unknown'].includes(outcome.status) && (outcome.status !== 'submitted' || validReceipt) ? outcome.status : 'unknown'
          : 'unknown';
        const receipt = effective === 'submitted' ? outcome?.receipt : null;
        const platform = receipt?.target?.platform;
        const chatId = receipt?.target?.chatId;
        const routing = claim?.routing;
        const validRouting = routing?.version === 1 && routing.platform === 'slack' && /^T[A-Z0-9]+$/.test(routing.teamId ?? '') && /^[CGD][A-Z0-9]+$/.test(routing.chatId ?? '') &&
          (!receipt || (receipt.target.platform === 'slack' && receipt.target.chatId === routing.chatId));
        const ref = randomUUID(); historyRefs.set(ref, key);
        rows.push({ id: ref, status: effective, time: effective === 'unknown' ? claim?.createdAt ?? null : outcome?.settledAt ?? claim.createdAt,
          ...( ['line', 'telegram', 'discord', 'slack', 'whatsapp'].includes(platform) ? { platform } : {}),
          ...(typeof chatId === 'string' && chatId.length <= 1024 ? { targetChatId: chatId } : validRouting ? { platform: 'slack', targetChatId: routing.chatId } : {}),
          ...(validRouting ? { openSlack: true } : {}) });
      }
      rows.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
      const result = rows.slice(0, limit);
      const keep = new Set(result.map(row => row.id));
      for (const id of historyRefs.keys()) if (!keep.has(id)) historyRefs.delete(id);
      return result;
    },
    resolveHistoryRef(ref) { return typeof ref === 'string' && ref.length <= 64 && historyRefs.has(ref) ? this.get(historyRefs.get(ref)) : null; },
    resolveHistorySlackRoute(ref) {
      if (typeof ref !== 'string' || ref.length > 64 || !historyRefs.has(ref)) return null;
      const key = historyRefs.get(ref);
      let claim;
      try { const file = keyPath(key, 'claim'); const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > 16_384) return null; claim = read(file); } catch { return null; }
      const route = claim?.routing;
      if (claim?.version !== 1 || !['pending', 'submitted'].includes(claim.status) || route?.version !== 1 || route.platform !== 'slack' || !/^T[A-Z0-9]+$/.test(route.teamId ?? '') || !/^[CGD][A-Z0-9]+$/.test(route.chatId ?? '')) return null;
      let outcome = null;
      try { const file = keyPath(key, 'outcome'); const stat = fs.lstatSync(file); if (stat.isFile() && stat.size <= 16_384) outcome = read(file); } catch { /* pending and damaged outcomes remain reconcilable */ }
      if (outcome?.status === 'submitted' && (outcome.receipt?.target?.platform !== 'slack' || outcome.receipt?.target?.chatId !== route.chatId)) return null;
      return { teamId: route.teamId, chatId: route.chatId };
    },
  };
}
module.exports = { createForwardingLedger };
