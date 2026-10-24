import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { createNativeSelectionClient } from '../desktop/native-selection-client.mjs';
import { createForwardingDrafts } from '../desktop/forwarding-drafts.mjs';
const witness = { pid: 100, startTicks: '12345', hwnd: '456', exe: resolve('owned-fixture.exe') };
function fixture(transform = x => x, options = {}) {
  let kills = 0, spawns = 0;
  const client = createNativeSelectionClient({ binaryPath: resolve('fixed-reader.exe'), witnessFor: () => witness, timeoutMs: 20,
    spawnProcess(binary, args, settings) {
      spawns++; assert.equal(binary, resolve('fixed-reader.exe')); assert.equal(settings.windowsHide, true);
      assert.deepEqual(args.slice(0, 4), ['100', '12345', witness.exe, '456']);
      const child = new EventEmitter(); child.exitCode = null;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { kills++; child.exitCode = 1; };
      let request = ''; child.stdin.on('data', b => request += b);
      child.stdin.on('finish', () => {
        const req = JSON.parse(request); assert.equal(req.op, 'observe-selection');
        const response = transform({ v: 1, id: req.id, nonce: req.nonce, ok: true, result: {
          witness: { pid:100, startTicks:'12345', hwnd:'456', executable:'owned-fixture.exe' },
          text:'Owned selected text', provenance:'ui-selected-text', platformMessageId:null } });
        if (response === null) return;
        child.stdout.write(typeof response === 'string' ? response : JSON.stringify(response));
        child.exitCode = 0; child.emit('close', 0);
      });
      return child;
    }, ...options });
  return { client, kills: () => kills, spawns: () => spawns };
}
test('main-owned one-shot transport validates fixed request and exact witness', async () => {
  const { client } = fixture();
  assert.deepEqual(await client.observe('line'), { status:'observed', text:'Owned selected text', provenance:'ui-selected-text-unverified-origin' });
});
test('unbound windows never launch helper; renderer-like invalid witness fails closed', async () => {
  const f = fixture(x=>x, { witnessFor:()=>null });
  assert.equal((await f.client.observe('line')).reason,'selection-window-not-bound'); assert.equal(f.spawns(),0);
  const bad = fixture(x=>x,{witnessFor:()=>({...witness,exe:'relative.exe'})});
  assert.equal((await bad.client.observe('line')).reason,'invalid-window-binding'); assert.equal(bad.spawns(),0);
});
test('wrong id/nonce/window, fake platform message IDs, malformed or oversized output rejected', async () => {
  for (const mutate of [r=>({...r,id:'wrong'}),r=>({...r,nonce:'wrong'}),r=>{r.result.witness.hwnd='789';return r;},r=>{r.result.platformMessageId='fake';return r;},()=>'{',()=> 'x'.repeat(131073)]) {
    assert.equal((await fixture(mutate).client.observe('line')).status,'unsupported');
  }
});
test('focus/provider failure stays unsupported and timeout terminates only owned helper', async () => {
  const noFocus = fixture(r=>({...r,ok:false,error:'focus-outside-target'}));
  assert.equal((await noFocus.client.observe('line')).reason,'focus-outside-target');
  const provider = fixture(r=>({...r,ok:false,error:'observation-provider-unavailable-focus-ancestry'}));
  assert.equal((await provider.client.observe('line')).reason,'observation-provider-unavailable-focus-ancestry');
  const arbitrary = fixture(r=>({...r,ok:false,error:'unexpected raw private exception'}));
  assert.equal((await arbitrary.client.observe('line')).reason,'selection-observation-unavailable');
  const stalled = fixture(()=>null);
  assert.equal((await stalled.client.observe('line')).reason,'selection-observation-timeout'); assert.equal(stalled.kills(),1);
});
test('observed source capture preserves honest provenance and ignores renderer-supplied witness', async () => {
  const { client } = fixture(); const drafts = createForwardingDrafts({observeSelection:p=>client.observe(p)});
  const capture = await drafts.captureObservedSelection({platform:'line',chatName:'Human declared source'});
  assert.equal(capture.provenance,'ui-selected-text-unverified-origin'); assert.equal(capture.messageId,undefined);
  const preview = await drafts.prepareSelection({selectionId:capture.selectionId,captureRevision:capture.captureRevision,routeText:'@slack:OwnedTarget'});
  assert.equal(preview.preview.text,'Owned selected text'); assert.equal(preview.source.provenance,'ui-selected-text-unverified-origin');
  assert.equal(preview.status,'unsupported');
  assert.equal((await drafts.captureObservedSelection({platform:'line',chatName:'Source',witness})).status,'rejected');
});
