// Owned synthetic windows only; the fixture selects its own immutable text.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createNativeSelectionClient } from '../../desktop/native-selection-client.mjs';
import { createForwardingDrafts } from '../../desktop/forwarding-drafts.mjs';
import { PassThrough } from 'node:stream';
const directory = mkdtempSync(join(tmpdir(), 'crosschat-native-client-owned-'));
const binaryPath = resolve('build/bin/native-routing/ReadOnlyRouting.exe');
const fixtures = [];
const delay = ms => new Promise(r=>setTimeout(r,ms));
const exited = p => new Promise((resolve,reject)=> {
  if (p.exitCode !== null) return resolve(p.exitCode);
  const timer = setTimeout(()=>reject(new Error('Owned process did not exit normally')),5000);
  p.once('exit',code=>{clearTimeout(timer);resolve(code);});
});
async function launch(name) {
  const manifest = join(directory, name+'.json');
  const process = spawn(resolve('build/bin/native-routing/SyntheticRouting.exe'),[manifest,'--preselected-owned'],{windowsHide:false});
  const item = {process,manifest}; fixtures.push(item);
  for(let i=0;i<100&&!existsSync(manifest);i++) await delay(50);
  assert.ok(existsSync(manifest),'Owned fixture ready');
  item.witness=JSON.parse(readFileSync(manifest,'utf8'));
  item.witness.selectionPath=[{automationId:'messageSelection',controlType:'Edit'}];
  assert.equal(item.witness.preselected,true); assert.equal(item.witness.active,true,'Owned fixture must activate itself');
  assert.equal(item.witness.focused,true); assert.equal(item.witness.selectionLength,'Only owned selected text'.length);
  return item;
}
async function raw(witness, wrongNonce=false) {
  const nonce=randomBytes(24).toString('hex');
  const child=spawn(binaryPath,[String(witness.pid),witness.startTicks,witness.exe,witness.hwnd,nonce],{windowsHide:true});
  let data='';child.stdout.on('data',b=>data+=b);child.stderr.resume();
  child.stdin.end(JSON.stringify({v:1,id:'owned-negative',op:'observe-selection',nonce:wrongNonce?'wrong':nonce})+'\n');
  const code=await exited(child);
  return {code,result:data?JSON.parse(data.trim().split('\n').at(-1)):null};
}
try {
  const first=await launch('first');
  let coordinateSelection=true;
  const client=createNativeSelectionClient({binaryPath,witnessFor:()=>first.witness,spawnProcess:(file,args,options)=>{
    const child=spawn(file,args,options); let response=''; child.stdout.on('data',b=>response+=b);
    if(coordinateSelection) {
      const realInput=child.stdin, staged=new PassThrough(); child.stdin=staged;
      let payload=''; staged.on('data',b=>payload+=b);
      staged.on('finish',async()=>{
        try {
          // Owned test timing only: actual helper output/receipt is untouched.
          writeFileSync(first.manifest+'.select','');
          for(let i=0;i<50&&!existsSync(first.manifest+'.selected');i++)await delay(20);
          assert.equal(readFileSync(first.manifest+'.selected','utf8'),'selected');
          realInput.end(payload);
        }catch(error){realInput.destroy(error);}
      });
    }
    child.on('close',code=>{if(process.env.CROSSCHAT_OWNED_ROUTING_DIAGNOSTIC==='1') {
      try {const r=JSON.parse(response.trim().split('\n').at(-1));console.log(JSON.stringify({ownedDiagnostic:true,code,ok:r.ok,error:r.error,phase:r.phase,idType:typeof r.id,nonceType:typeof r.nonce,provenance:r.result?.provenance,hasWitness:Boolean(r.result?.witness)}));}
      catch{console.log(JSON.stringify({ownedDiagnostic:true,code,responseBytes:Buffer.byteLength(response),validJson:false}));}
    }}); return child;
  }});
  const drafts=createForwardingDrafts({observeSelection:p=>client.observe(p)});
  const capture=await drafts.captureObservedSelection({platform:'line',chatName:'Owned label, not a verified LINE chat'});
  assert.equal(capture.status,'captured',capture.reason);
  assert.equal(capture.provenance,'ui-selected-text-unverified-origin');
  const preview=await drafts.prepareSelection({selectionId:capture.selectionId,captureRevision:capture.captureRevision,routeText:'@slack:OwnedTarget'});
  assert.equal(preview.preview.text,'Only owned selected text'); assert.equal(preview.status,'unsupported');
  assert.equal(capture.messageId,undefined);
  const nonce=await raw(first.witness,true);assert.equal(nonce.result.ok,false);assert.equal(nonce.result.error,'invalid-request');
  const mismatch=await raw({...first.witness,startTicks:'0'});assert.equal(mismatch.code,2);
  coordinateSelection=false;
  await launch('second'); // Only another owned window becomes foreground.
  const outside=await client.observe('line');assert.equal(outside.status,'unsupported');assert.equal(outside.reason,'focus-outside-target');
  console.log(JSON.stringify({ownedOnly:true,fixtureSelfSelected:true,clientToPrivateCapture:true,knownTextMatched:true,originUnverified:true,nonceRejected:true,sessionRejected:true,focusOutsideRejected:true,sendUnsupported:true}));
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {
  for(const item of fixtures) writeFileSync(item.manifest+'.close','');
  for(const item of fixtures) try{assert.equal(await exited(item.process),0);}catch(error){console.error(error.message);process.exitCode=1;}
}
