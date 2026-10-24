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
  let candidates = new Map(), expiresAt = 0, bound = null, generation = 0n;
  function expireCandidates() {
    if (now() >= expiresAt) { candidates.clear(); expiresAt = 0; }
  }
  function clearCandidates() { candidates.clear(); expiresAt = 0; }
  function advance() { generation += 1n; return generation; }
  return {
    async list() {
      const requestGeneration = advance();
      clearCandidates();
      try {
        const found = await listCandidates();
        if (generation !== requestGeneration) return { status: 'stale', candidates: [], bound: Boolean(bound) };
        if (!Array.isArray(found) || found.length > MAX_CANDIDATES) return { status: 'unavailable', candidates: [], bound: Boolean(bound) };
        expiresAt = now() + TTL_MS;
        const rows = found.map((witness, index) => {
          const id = random(16).toString('hex');
          candidates.set(id, { witness: structuredClone(witness), sequence: index + 1 });
          return { candidateId: id, sequence: index + 1 };
        });
        return { status: 'available', candidates: rows, bound: Boolean(bound) };
      } catch {
        if (generation !== requestGeneration) return { status: 'stale', candidates: [], bound: Boolean(bound) };
        clearCandidates();
        return { status: 'unavailable', candidates: [], bound: Boolean(bound) };
      }
    },
    async bind(input) {
      expireCandidates();
      if (!input || Object.keys(input).length !== 2 || typeof input.candidateId !== 'string' ||
          !/^[a-f0-9]{32}$/.test(input.candidateId) || input.confirmed !== true) return { status: 'rejected' };
      const candidate = candidates.get(input.candidateId);
      if (!candidate) return { status: 'expired' };
      const requestGeneration = advance();
      try {
        const verified = await validateWitness(structuredClone(candidate.witness));
        if (!sameWitness(candidate.witness, verified)) throw new Error('Candidate changed');
      } catch {
        if (generation !== requestGeneration) return { status: 'expired' };
        if (candidates.get(input.candidateId) === candidate) { clearCandidates(); advance(); }
        return { status: 'stale' };
      }
      if (generation !== requestGeneration) return { status: 'expired' };
      expireCandidates();
      if (generation !== requestGeneration || candidates.get(input.candidateId) !== candidate) return { status: 'expired' };
      bound = structuredClone(candidate.witness);
      clearCandidates(); advance();
      return { status: 'bound', sequence: candidate.sequence };
    },
    unbind() { advance(); bound = null; clearCandidates(); return { status: 'unbound' }; },
    async witnessFor(platform) {
      if (platform !== 'line' || !bound) return null;
      const selected = bound;
      const requestGeneration = generation;
      try {
        const valid = await validateWitness(structuredClone(selected));
        if (bound !== selected || generation !== requestGeneration) return null;
        if (!sameWitness(selected, valid)) { bound = null; clearCandidates(); advance(); return null; }
        return { pid: selected.pid, startTicks: selected.startTicks, hwnd: selected.hwnd, exe: selected.path };
      } catch {
        if (bound === selected) { bound = null; clearCandidates(); advance(); }
        return null;
      }
    },
    state() { return { bound: Boolean(bound) }; },
  };
}
module.exports = { createLineBinding, LINE_BINDING_TTL_MS: TTL_MS, LINE_BINDING_MAX_CANDIDATES: MAX_CANDIDATES };
