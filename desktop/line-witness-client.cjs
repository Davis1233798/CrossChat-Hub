'use strict';
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { isAbsolute } = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const MAX_BYTES = 32768;
const WITNESS_KEYS = ['pid', 'startTicks', 'hwnd', 'path', 'publisher', 'sha256', 'dpiContext'];
function validWitness(w) {
  return Boolean(w && Object.keys(w).length === WITNESS_KEYS.length && WITNESS_KEYS.every(k => Object.hasOwn(w, k)) &&
    Number.isSafeInteger(w.pid) && w.pid > 0 && /^\d+$/.test(w.startTicks) && /^-?\d+$/.test(w.hwnd) &&
    typeof w.path === 'string' && typeof w.publisher === 'string' && typeof w.sha256 === 'string' && /^[a-f0-9]{64}$/.test(w.sha256) &&
    w.dpiContext === 'context-4');
}
function createLineWitnessClient({ binaryPath, timeoutMs = 5000, spawnProcess = spawn } = {}) {
  if (!isAbsolute(binaryPath ?? '')) throw new Error('LINE witness executable must be a fixed absolute path');
  async function request(op, witness) {
    const nonce = randomBytes(24).toString('hex'), id = randomUUID();
    return new Promise((resolve, reject) => {
      let child, output = '', bytes = 0, ready = false, response = null, complete = false, timer;
      const decoder = new StringDecoder('utf8');
      function finish(error, value, terminate = false) {
        if (complete) return;
        complete = true; clearTimeout(timer);
        if (terminate && child && child.exitCode === null) child.kill();
        error ? reject(error) : resolve(value);
      }
      function fail() { finish(new Error('LINE witness helper unavailable'), null, true); }
      try {
        child = spawnProcess(binaryPath, ['--protocol', nonce], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        timer = setTimeout(fail, timeoutMs);
        child.once('error', fail); child.stdin.on('error', fail); child.stderr.on('data', () => {});
        child.stdout.on('data', chunk => {
          bytes += chunk.length; if (bytes > MAX_BYTES) { fail(); return; }
          output += decoder.write(chunk);
          let index;
          while ((index = output.indexOf('\n')) >= 0 && !complete) {
            const line = output.slice(0, index); output = output.slice(index + 1);
            try {
              const parsed = JSON.parse(line);
              if (!ready) {
                if (!parsed || Object.keys(parsed).length !== 3 || Object.keys(parsed).some(k => !['v', 'type', 'nonce'].includes(k)) ||
                    parsed.v !== 1 || parsed.type !== 'ready' || parsed.nonce !== nonce) throw new Error();
                ready = true;
                child.stdin.end(JSON.stringify({ v: 1, id, nonce, op, ...(witness ? { witness } : {}) }) + '\n');
              } else {
                if (response) throw new Error();
                if (!parsed || Object.keys(parsed).length !== 5 || Object.keys(parsed).some(k => !['v', 'id', 'nonce', 'ok', 'data'].includes(k)) ||
                    parsed.v !== 1 || parsed.id !== id || parsed.nonce !== nonce || parsed.ok !== true || !parsed.data) throw new Error();
                if (op === 'list-candidates') {
                  if (Object.keys(parsed.data).length !== 1 || !Object.hasOwn(parsed.data, 'candidates') || !Array.isArray(parsed.data.candidates) || parsed.data.candidates.length > 12 || !parsed.data.candidates.every(validWitness)) throw new Error();
                } else if (Object.keys(parsed.data).length !== 2 || parsed.data.valid !== true || !validWitness(parsed.data.witness)) throw new Error();
                response = parsed.data;
              }
            } catch { fail(); }
          }
        });
        child.once('close', code => {
          if (complete) return;
          if (code !== 0 || !ready || !response || (output + decoder.end()).trim()) { fail(); return; }
          finish(null, response);
        });
      } catch { fail(); }
    });
  }
  return {
    listCandidates: async () => (await request('list-candidates')).candidates,
    validateWitness: async witness => {
      if (!validWitness(witness)) throw new Error('Invalid private LINE witness');
      const data = await request('validate-witness', witness);
      return data.witness;
    },
  };
}
module.exports = { createLineWitnessClient, validLineWitness: validWitness };
