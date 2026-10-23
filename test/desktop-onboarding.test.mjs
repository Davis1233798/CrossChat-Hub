import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { createDemo } from '../src/demo.mjs';
import { createTelegramUser } from '../src/telegram-user.mjs';
import { createApp } from '../src/app.mjs';
import { closeWithDeadline } from '../src/shutdown.mjs';
const KEY = 'ab'.repeat(32);
const ADMIN = 'cd'.repeat(32);
const headers = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };

async function fixture(t, { demo, telegramUser } = {}) {
  const store = createStore(':memory:', KEY);
  const app = createApp({ store, adminKey: ADMIN, demo, telegramUser });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); store.close(); });
  return { store, base: `http://127.0.0.1:${app.address().port}` };
}

test('demo is explicitly offline, requires admin, persists simulated chats and forwards locally only', async t => {
  const store = createStore(':memory:', KEY);
  const demo = createDemo({ store, enabled: true });
  const app = createApp({ store, adminKey: ADMIN, demo });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base+'/api/demo/login',{method:'POST'})).status,401);
  const login = await fetch(base+'/api/demo/login',{method:'POST', headers, body:'{}'});
  assert.equal(login.status,200);
  const rooms = await (await fetch(base+'/api/demo/rooms',{headers})).json();
  assert.equal(rooms.length,3);
  const sent = await fetch(base+'/api/demo/messages',{method:'POST',headers,body:JSON.stringify({room:'demo-telegram',text:'@line:alice 測試'})});
  assert.equal(sent.status,201);
  const line = await (await fetch(base+'/api/demo/messages?room=demo-line',{headers})).json();
  assert.equal(line.length,2);
  assert.match(line.at(-1).text,/純本機模擬/);
  assert.equal((await fetch(base+'/api/demo/messages?room=not-a-room',{headers})).status,404);
  assert.equal((await fetch(base+'/api/demo/messages',{method:'POST',headers,body:JSON.stringify({room:'demo-line',text:''})})).status,400);
});

test('demo is explicitly unavailable on server deployments by default', async t => {
  const {base} = await fixture(t);
  assert.deepEqual(await (await fetch(base+'/api/demo/state',{headers})).json(),{available:false,active:false});
  assert.equal((await fetch(base+'/api/demo/login',{method:'POST',headers,body:'{}'})).status,404);
});

test('real Telegram login state machine: code + 2FA, encrypted session, scoped chats and send', async t => {
  const store = createStore(':memory:', KEY);
  t.after(() => store.close());
  let disconnected=0,sends=[];
  const factory=async ({session})=>({
    requestCode:async phone=>({phoneCodeHash:'test-hash',isCodeViaApp:true}),
    async signInCode(phone,hash,code){ assert.equal(phone,'+886912345678');if(code==='12345')throw new Error('SESSION_PASSWORD_NEEDED');},
    async signInPassword(password){assert.equal(password,'correct-password');},
    getMe:async()=>({id:12345n,firstName:'Alice'}),
    session:()=> 'THIS_IS_A_SECRET_SESSION',
    rooms:async()=>[{id:'55',name:'Example room'}],
    messages:async room=>{assert.equal(room,'55');return [{id:'3',text:'hello'}]},
    send:async (room,text)=>{sends.push([room,text]);return {id:'4'}},
    disconnect:async()=>{disconnected++},
  });
  const telegramUser=createTelegramUser({store,env:{TELEGRAM_API_ID:'123456',TELEGRAM_API_HASH:'a'.repeat(32)},clientFactory:factory});
  assert.equal(telegramUser.configured(),true);
  const pending=await telegramUser.begin('+886912345678');
  assert.equal(pending.delivery,'telegram_app');
  assert.deepEqual(await telegramUser.complete(pending.login_id,'12345'),{stage:'password_required'});
  const authenticated=await telegramUser.complete(pending.login_id,'','correct-password');
  assert.equal(authenticated.stage,'authenticated');
  assert.match(authenticated.display_name,/Alice/);
  assert.equal(store.listVerifiedAccounts().at(0).provider,'telegram');
  const connection=store.getConnection(authenticated.connection_id);
  assert.equal(connection.credentials.session,'THIS_IS_A_SECRET_SESSION');
  assert.equal(store.listConnections().at(0).session,undefined);
  assert.equal((await telegramUser.withSession(authenticated.connection_id,'rooms')).at(0).id,'55');
  assert.equal((await telegramUser.withSession(authenticated.connection_id,'messages','55')).at(0).text,'hello');
  await telegramUser.withSession(authenticated.connection_id,'send','55','hello there');
  assert.deepEqual(sends,[['55','hello there']]);
  await telegramUser.close();assert.equal(disconnected,1);
});

test('Telegram rejects invalid phone and login with no configured app ID', async()=>{
  const store=createStore(':memory:',KEY);
  try {
    const tg=createTelegramUser({store,env:{}});
    await assert.rejects(tg.begin('not-a-phone'), /E.164/);
    await assert.rejects(tg.begin('+886912345678'), /not configured/);
  }finally{store.close();}
});

test('app deadline returns timeout and does not wait forever for locked connections',async()=>{
  assert.equal(await closeWithDeadline(async()=>{}, 50),'closed');
  assert.equal(await closeWithDeadline(()=>new Promise(()=>{}), 20),'timeout');
  assert.equal(await closeWithDeadline(()=>Promise.reject(new Error('socket')), 50),'error');
});
