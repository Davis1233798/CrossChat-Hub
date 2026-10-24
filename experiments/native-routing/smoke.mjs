import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
const directory = mkdtempSync(join(tmpdir(), 'crosschat-owned-routing-'));
const manifest = join(directory, 'fixture.json');
const binary = name => resolve('build/bin/native-routing', name + '.exe');
const fixture = spawn(binary('SyntheticRouting'), [manifest], { windowsHide: false });
let reader;
const wait = ms => new Promise(r => setTimeout(r, ms));
const exit = p => new Promise(resolve => { if (p.exitCode !== null) resolve(p.exitCode); else p.once('exit', resolve); });
try {
  for (let i=0; i<100 && !existsSync(manifest); i++) await wait(50);
  assert.ok(existsSync(manifest), 'Owned fixture ready');
  const target = JSON.parse(readFileSync(manifest));
  const nonce = randomBytes(24).toString('hex');
  reader = spawn(binary('ReadOnlyRouting'), [String(target.pid), target.startTicks, target.exe, target.hwnd, nonce], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
  let stderr=''; reader.stderr.on('data', b => stderr += b);
  const lines = createInterface({ input: reader.stdout });
  const pending = [];
  lines.on('line', line => {const value=JSON.parse(line);if(value.type==='ready'){assert.equal(value.nonce,nonce);return;}pending.shift()?.(value);});
  let sequence = 0;
  async function request(op, extra = {}) {
    const response = new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('Read-only response timeout')), 7000);
      pending.push(result => { clearTimeout(timer); resolve(result); });
    });
    reader.stdin.write(JSON.stringify({ v:1, id:String(++sequence), op, nonce, ...extra })+'\n');
    return response;
  }
  const probe = await request('probe'); assert.equal(probe.ok,true,'probe'); assert.equal(probe.result.witness.pid,target.pid);
  const header = await request('observe-header', { path:[{ automationId:'chatHeader',controlType:'Text' }] });
  assert.equal(header.ok,true,'header'); assert.equal(header.result.header,'合成聊天室'); assert.equal(header.result.platformChatId,null);
  const selected = await request('observe-selection');
  if (selected.ok) { assert.match(selected.result.text,/Only owned selected text/); assert.equal(selected.result.platformMessageId,null); }
  else assert.ok(['focus-outside-target','selection-unsupported','empty-selection'].includes(selected.error), 'Selection must fail closed with explicit safe reason');
  for (const [op,extra] of [['send',{}],['probe',{nonce:'bad'}],['probe',{target:'other'}],['observe-header',{path:[{automationId:'unknown',controlType:'Text'}]}]]) assert.equal((await request(op,extra)).ok,false);
  reader.stdin.end(); assert.equal(await exit(reader),0);
  // Only the fixture launched above is closed; no existing app is targeted.
  const closer = spawn('powershell', ['-NoProfile','-Command', '$p = Get-Process -Id '+target.pid+' -ErrorAction Stop; $null = $p.CloseMainWindow()'], { windowsHide:true });
  assert.equal(await exit(closer),0); assert.equal(await exit(fixture),0);
  const invalid = spawn(binary('ReadOnlyRouting'), [String(target.pid), '0', target.exe, target.hwnd, nonce], { stdio:['ignore','ignore','ignore'], windowsHide:true });
  assert.equal(await exit(invalid),2);
  console.log(JSON.stringify({ ownedSyntheticOnly:true, probe:true, explicitHeader:true, selectedText:selected.ok, selectionError:selected.error??null, unsupportedSendRejected:true, invalidSessionRejected:true, noPlatformIdsInvented:true, normalExit:true }));
} catch (error) {
  reader?.stdin.end();
  // Fixture has its own 30s normal-close deadline; never kill external apps.
  console.error(error.message); process.exitCode=1;
}
