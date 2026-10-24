import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Main owns the fixed binary and window bindings. No renderer-controlled command,
// executable, HWND, operation or protocol fields are accepted by this client.
export function createNativeSelectionClient({ binaryPath, witnessFor = () => null, timeoutMs = 8000, spawnProcess = spawn } = {}) {
  if (!isAbsolute(binaryPath ?? '')) throw new Error('Selection binary must be a fixed absolute path');
  return {
    async observe(platform) {
      const witness = await witnessFor(platform);
      if (!witness) return { status: 'unsupported', reason: 'selection-window-not-bound' };
      if (!Number.isSafeInteger(witness.pid) || witness.pid <= 0 || !/^\d+$/.test(witness.startTicks ?? '') ||
          !/^\d+$/.test(witness.hwnd ?? '') || !isAbsolute(witness.exe ?? '')) return { status: 'unsupported', reason: 'invalid-window-binding' };
      const selectionPath = witness.selectionPath;
      if (selectionPath !== undefined && (!Array.isArray(selectionPath) || selectionPath.length < 1 || selectionPath.length > 8 ||
          selectionPath.some(s => !s || Object.keys(s).length !== 2 || typeof s.automationId !== 'string' || !s.automationId || s.automationId.length > 128 || !['Text', 'Pane', 'Group', 'Document', 'Edit'].includes(s.controlType)))) return { status: 'unsupported', reason: 'invalid-window-binding' };
      const nonce = randomBytes(24).toString('hex'), id = randomUUID();
      return new Promise(resolve => {
        let child, output = '', bytes = 0, complete = false, timer, ready = false, response = null;
        const decoder = new StringDecoder('utf8');
        function finish(result, terminate = false) {
          if (complete) return; complete = true; clearTimeout(timer);
          if (terminate && child && child.exitCode === null) child.kill(); // Only this spawned helper.
          resolve(result);
        }
        const unavailable = reason => finish({ status: 'unsupported', reason }, true);
        try {
          child = spawnProcess(binaryPath, [String(witness.pid), witness.startTicks, witness.exe, witness.hwnd, nonce],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          timer = setTimeout(() => unavailable('selection-observation-timeout'), timeoutMs);
          child.once('error', () => unavailable('selection-helper-unavailable'));
          child.stdin.on('error', () => unavailable('selection-helper-unavailable'));
          child.stderr.on('data', () => {}); // Never echo arbitrary helper diagnostics or text.
          child.stdout.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 131072) { unavailable('selection-response-limit'); return; }
            output += decoder.write(chunk);
            let index;
            while ((index = output.indexOf('\n')) >= 0 && !complete) {
              const line = output.slice(0, index); output = output.slice(index + 1);
              try {
                const parsed = JSON.parse(line);
                if (!ready) {
                  const w = parsed.witness;
                  if (parsed.v !== 1 || parsed.type !== 'ready' || parsed.nonce !== nonce || !w ||
                      w.pid !== witness.pid || w.startTicks !== witness.startTicks || w.hwnd !== witness.hwnd ||
                      typeof w.executable !== 'string' || w.executable.toLowerCase() !== basename(witness.exe).toLowerCase()) throw new Error();
                  ready = true;
                  child.stdin.end(JSON.stringify({ v: 1, id, op: 'observe-selection', nonce, ...(selectionPath ? { path: structuredClone(selectionPath) } : {}) }) + '\n');
                } else { if (response) throw new Error(); response = parsed; }
              } catch { unavailable('invalid-selection-response'); }
            }
          });
          child.once('close', code => {
            if (complete) return;
            try {
              if (code !== 0) throw new Error();
              if (!ready || !response || (output + decoder.end()).trim()) throw new Error();
              const result = response;
              if (result.v !== 1 || result.id !== id || result.nonce !== nonce || typeof result.ok !== 'boolean') throw new Error();
              if (!result.ok) {
                const safe = ['selection-unsupported', 'focus-outside-target', 'empty-selection', 'single-selection-required',
                  'request-decode-failed', 'invalid-schema', 'invalid-request', 'session-mismatch', 'window-mismatch', 'window-unavailable',
                  'observation-provider-unavailable-validate', 'observation-provider-unavailable-focus',
                  'observation-provider-unavailable-focus-owner', 'observation-provider-unavailable-focus-ancestry',
                  'observation-provider-unavailable-text-pattern', 'observation-provider-unavailable-text-selection'];
                unavailable(safe.includes(result.error) ? result.error : 'selection-observation-unavailable'); return;
              }
              const r = result.result, w = r?.witness;
              if (!w || w.pid !== witness.pid || w.startTicks !== witness.startTicks || w.hwnd !== witness.hwnd ||
                  w.executable.toLowerCase() !== basename(witness.exe).toLowerCase() || r.provenance !== 'ui-selected-text' ||
                  r.platformMessageId !== null || typeof r.text !== 'string' || !r.text.trim() || r.text.length > 16000) throw new Error();
              finish({ status: 'observed', text: r.text, provenance: 'ui-selected-text-unverified-origin' });
            } catch { unavailable('invalid-selection-response'); }
          });
        } catch { unavailable('selection-helper-unavailable'); }
      });
    },
  };
}
