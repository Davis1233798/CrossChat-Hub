'use strict';
const { randomBytes } = require('node:crypto');

const TTL_MS = 30_000;
const MAX_CANDIDATES = 12;
function sameWitness(a, b) {
  return Boolean(a && b && ['pid', 'startTicks', 'hwnd', 'path', 'publisher', 'sha256', 'dpiContext']
    .every(key => String(a[key]) === String(b[key])));
}

// Private, process-local bindings. Renderer receives only short-lived candidate
// handles and sequence numbers; native identity never crosses IPC.
function createLineBinding({ listCandidates, validateWitness, now = Date.now, random = randomBytes } = {}) {
  let candidates = new Map(), expiresAt = 0, bound = null;
  function expireCandidates() {
    if (now() >= expiresAt) { candidates.clear(); expiresAt = 0; }
  }
  return {
    async list() {
      candidates.clear(); expiresAt = 0;
      try {
        const found = await listCandidates();
        if (!Array.isArray(found) || found.length > MAX_CANDIDATES) return { status: 'unavailable', candidates: [] };
        expiresAt = now() + TTL_MS;
        const rows = found.map((witness, index) => {
          const id = random(16).toString('hex');
          candidates.set(id, { witness: structuredClone(witness), sequence: index + 1 });
          return { candidateId: id, sequence: index + 1 };
        });
        return { status: 'available', candidates: rows, bound: Boolean(bound) };
      } catch { return { status: 'unavailable', candidates: [], bound: Boolean(bound) }; }
    },
    async bind(input) {
      expireCandidates();
      if (!input || Object.keys(input).length !== 2 || typeof input.candidateId !== 'string' ||
          !/^[a-f0-9]{32}$/.test(input.candidateId) || input.confirmed !== true) return { status: 'rejected' };
      const candidate = candidates.get(input.candidateId);
      if (!candidate) return { status: 'expired' };
      try {
        const verified = await validateWitness(structuredClone(candidate.witness));
        if (!sameWitness(candidate.witness, verified)) throw new Error('Candidate changed');
      } catch { candidates.clear(); expiresAt = 0; return { status: 'stale' }; }
      expireCandidates();
      if (candidates.get(input.candidateId) !== candidate) return { status: 'expired' };
      bound = structuredClone(candidate.witness);
      candidates.clear(); expiresAt = 0;
      return { status: 'bound', sequence: candidate.sequence };
    },
    unbind() { bound = null; candidates.clear(); expiresAt = 0; return { status: 'unbound' }; },
    async witnessFor(platform) {
      if (platform !== 'line' || !bound) return null;
      const selected = bound;
      try {
        const valid = await validateWitness(structuredClone(selected));
        if (bound !== selected) return null;
        if (!sameWitness(selected, valid)) { bound = null; return null; }
        return { pid: selected.pid, startTicks: selected.startTicks, hwnd: selected.hwnd, exe: selected.path };
      } catch { if (bound === selected) bound = null; return null; }
    },
    state() { return { bound: Boolean(bound) }; },
  };
}
module.exports = { createLineBinding, LINE_BINDING_TTL_MS: TTL_MS, LINE_BINDING_MAX_CANDIDATES: MAX_CANDIDATES };
