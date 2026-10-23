let apiKey = '';
const $ = id => document.getElementById(id);
const notify = (message, error = false) => {
  $('flash').style.display = 'block';
  $('flash').style.background = error ? '#593338' : '#1b3b41';
  $('flash').textContent = message;
};
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'authorization': `Bearer ${apiKey}`, ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body;
}
function formJson(form) { return Object.fromEntries(new FormData(form).entries()); }
function renderTable(id, columns, records) {
  const node = $(id);
  node.replaceChildren();
  if (!records.length) { node.textContent = '目前沒有資料'; return; }
  const table = document.createElement('table');
  const thead = table.createTHead().insertRow();
  for (const [key, title] of columns) { const cell = document.createElement('th'); cell.textContent = title; thead.append(cell); }
  const tbody = table.createTBody();
  for (const row of records) {
    const tr = tbody.insertRow();
    for (const [key] of columns) {
      const td = tr.insertCell(); td.textContent = row[key] == null ? '—' : String(row[key]);
      if (key === 'text') td.className = 'message';
    }
  }
  node.append(table);
}
function fillSelect(id, items, label) {
  const el = $(id); el.replaceChildren();
  for (const item of items) { const opt = document.createElement('option'); opt.value = item.id; opt.textContent = label(item); el.append(opt); }
}
async function refresh() {
  const [connections, identities, addresses, messages, deliveries, rules, accounts, gateway, oauthConfig, telegramConfig, demoState] = await Promise.all(
    ['connections','identities','addresses','messages','deliveries','bridge-rules','verified-accounts','gateway','oauth/config','user/telegram/config','demo/state'].map(name => request(`/api/${name}`))
  );
  $('n-connections').textContent = connections.length;
  $('n-identities').textContent = identities.length;
  $('n-messages').textContent = messages.length;
  $('n-pending').textContent = deliveries.filter(x => x.status !== 'sent').length;
  renderTable('connections', [['platform', '平台'], ['name', '名稱'], ['webhook_path', 'Webhook 路徑'], ['id', '連線 ID']], connections);
  renderTable('addresses', [['alias', '別名'], ['platform', '平台'], ['connection_name', '連線'], ['external_user_id', '使用者 ID']], addresses);
  renderTable('messages', [['created_at', '時間'], ['platform', '平台'], ['room_id', '聊天室'], ['author_id', '使用者 ID'], ['text', '訊息']], messages);
  renderTable('deliveries', [['created_at', '時間'], ['platform', '目標平台'], ['target_id', '收件者 ID'], ['status', '狀態'], ['attempts', '嘗試次數'], ['last_error', '錯誤']], deliveries);
  fillSelect('identity-select', identities, item => `${item.alias} · ${item.display_name}`);
  fillSelect('connection-select', connections, item => `${item.platform} · ${item.name}`);
  fillSelect('discord-identity-select', identities, item => `${item.alias} · ${item.display_name}`);
  fillSelect('discord-connection-select', connections.filter(x => x.platform === 'discord'), item => item.name);
  fillSelect('bridge-source', connections, item => `${item.platform} · ${item.name}`);
  fillSelect('bridge-target', connections, item => `${item.platform} · ${item.name}`);
  renderTable('verified-accounts', [['provider','平台'],['display_name','使用者'],['external_user_id','已驗證 ID'],['verified_at','時間']], accounts);
  renderTable('gateway-status', [['connection_id','連線 ID'],['connected','WebSocket 已連接'],['session_ready','Gateway Ready']], gateway);
  renderTable('bridge-rules', [['source_name','來源連線'],['source_room_id','來源房間'],['target_name','目標連線'],['target_room_id','目標房間']], rules);
  // Only administrators have access to this deletion control.
  const table = $('bridge-rules').querySelector('table');
  if (table) {
    table.tHead.rows[0].insertCell().textContent = '操作';
    for (const [idx, row] of [...table.tBodies[0].rows].entries()) {
      const btn = document.createElement('button'); btn.className = 'bridge-del'; btn.textContent = '刪除';
      btn.addEventListener('click', async () => { try { await request(`/api/bridge-rules/${rules[idx].id}`, { method: 'DELETE' }); await refresh(); } catch (e) { notify(e.message, true); } });
      row.insertCell().append(btn);
    }
  }
  // Account-first sign-in surfaces only verifiable OAuth identities. LINE and
  // Discord identity grants are NOT presented as personal chat access.
  renderPersonalAccounts(accounts, connections);
  $('telegram-state').textContent = telegramConfig.ready ? '可使用真實手機號碼登入' : '待設定應用程式 API';
  $('telegram-state').classList.toggle('unavailable', !telegramConfig.ready);
  $('telegram-open').disabled = !telegramConfig.ready;
  $('demo-login').disabled = !demoState.available;
  $('demo-login').textContent = demoState.active ? '繼續示範' : '開始示範';
  if (demoState.active) await showDemoRooms();
  const telegramConnections = connections.filter(c => c.platform === 'telegram' && accounts.some(a => a.provider === 'telegram' && a.connection_id === c.id));
  $('telegram-chat-panel').hidden = telegramConnections.length === 0;
  fillSelect('telegram-connection', telegramConnections, c => c.name);
  const users = connections.filter(c => c.platform === 'slack' && accounts.some(a => a.connection_id === c.id && a.provider === 'slack'));
  $('slack-chat-panel').hidden = users.length === 0;
  fillSelect('personal-slack-connection', users, c => c.name);

  for (const provider of ['slack','discord','line']) {
    const button = document.querySelector(`[data-login="${provider}"]`);
    button.disabled = !oauthConfig[provider];
    const state = $(`account-state-${provider}`);
    const linked = accounts.some(a => a.provider === provider);
    state.textContent = !oauthConfig[provider] ? '需由開發者設定 OAuth' : linked ? '已驗證身分' : '可登入';
    state.classList.toggle('unavailable', !oauthConfig[provider]);
  }
  for (const platform of ['slack','discord']) {
    $(`${platform}-oauth-button`).disabled = !oauthConfig[platform];
    $(`${platform}-oauth-state`).textContent = oauthConfig[platform] ? '可使用 OAuth 授權' : '尚未設定 Client ID / Secret / callback URL';
  }
}
function renderPersonalAccounts(accounts, connections) {
  const container = $('personal-accounts');
  container.replaceChildren();
  if (!accounts.length) { container.textContent = '尚未連結帳號。請使用上方的官方登入按鈕。'; return; }
  for (const account of accounts) {
    const item = document.createElement('article');
    item.className = 'account-tile';
    const name = document.createElement('strong');
    name.textContent = `${account.provider.toUpperCase()} · ${account.display_name}`;
    const caption = document.createElement('small');
    const connection = connections.find(c => c.id === account.connection_id);
    caption.textContent = account.provider === 'slack' && connection
      ? '已授權工作區使用者帳號；實際訊息操作依 OAuth 授權與頻道權限'
      : '已完成身分驗證；無個人聊天室同步或代發權限';
    item.append(name, caption); container.append(item);
  }
}
for (const button of document.querySelectorAll('[data-login]')) {
  button.addEventListener('click', async () => {
    const provider = button.dataset.login;
    if (!apiKey) return notify('請先連線本機桌面服務，或展開進階設定輸入管理金鑰。', true);
    try {
      const payload = provider === 'slack' ? { mode: 'user', name: '我的 Slack 工作區' } : {};
      const { url } = await request(`/api/oauth/${provider}/start`, { method: 'POST', body: JSON.stringify(payload) });
      window.open(url, '_blank', 'noopener,noreferrer');
      notify(`已開啟 ${provider.toUpperCase()} 官方授權頁。完成後請重新整理帳號狀態。`);
    } catch (error) { notify(error.message, true); }
  });
}
function activeSlackAccount() { return $('personal-slack-connection').value; }
function activeSlackRoom() { return $('personal-slack-room').value; }
function showSlackMessages(items) {
  const node = $('personal-slack-messages'); node.replaceChildren();
  if (!items.length) { node.textContent = '此聊天室目前沒有可存取的訊息。'; return; }
  for (const item of items.slice().reverse()) {
    const line = document.createElement('article'); line.className = 'chat-line';
    const sender = document.createElement('small'); sender.textContent = `${item.user} · ${item.ts ?? ''}`;
    const message = document.createElement('div'); message.textContent = item.text;
    line.append(sender, message); node.append(line);
  }
}
$('personal-slack-rooms').addEventListener('click', async () => {
  try {
    const id = activeSlackAccount(); if (!id) throw new Error('請先使用 Slack OAuth 登入。');
    const result = await request(`/api/user/slack/rooms?connection_id=${encodeURIComponent(id)}`);
    fillSelect('personal-slack-room', result.rooms, c => c.name);
    $('personal-slack-messages').textContent = `${result.rooms.length} 個可存取的聊天室，請選擇後點選讀取訊息。`;
  } catch (error) { notify(error.message, true); }
});
$('personal-slack-history').addEventListener('click', async () => {
  try {
    const conn = activeSlackAccount(), room = activeSlackRoom();
    if (!conn || !room) throw new Error('請先讀取並選擇聊天室。');
    const result = await request(`/api/user/slack/messages?connection_id=${encodeURIComponent(conn)}&channel=${encodeURIComponent(room)}`);
    showSlackMessages(result.messages);
  } catch (error) { notify(error.message, true); }
});
$('personal-slack-send').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const conn = activeSlackAccount(), room = activeSlackRoom();
    if (!conn || !room) throw new Error('請先選擇聊天室。');
    const text = event.currentTarget.elements.namedItem('text').value;
    await request('/api/user/slack/messages', { method: 'POST', body: JSON.stringify({ connection_id: conn, channel: room, text }) });
    event.currentTarget.reset();
    $('personal-slack-history').click();
    notify('訊息已經由你的 Slack 授權帳號傳送。');
  } catch (error) { notify(error.message, true); }
});
$('personal-refresh').addEventListener('click', () => refresh().catch(e => notify(e.message,true)));
let telegramLoginId = null;
$('telegram-open').addEventListener('click', () => { $('telegram-login-panel').hidden = !$('telegram-login-panel').hidden; });
$('telegram-phone-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await request('/api/user/telegram/start', { method:'POST', body:JSON.stringify(formJson(e.target)) });
    telegramLoginId = r.login_id;
    $('telegram-code-form').hidden = false;
    notify('已要求 Telegram 發出驗證碼；請查看你的 Telegram 應用程式或平台指定位置。');
  } catch (err) { notify(err.message, true); }
});
$('telegram-code-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await request('/api/user/telegram/complete', {method:'POST', body:JSON.stringify({login_id:telegramLoginId,...formJson(e.target)})});
    if (r.stage === 'password_required') return notify('此帳號要求雙重驗證密碼，請填寫密碼後再次送出。');
    telegramLoginId=null;
    e.target.reset(); $('telegram-code-form').hidden=true; $('telegram-login-panel').hidden=true;
    await refresh(); notify(`已登入 Telegram：${r.display_name}`);
  } catch (err) { notify(err.message,true); }
});
$('telegram-rooms').addEventListener('click',async()=>{
  try { const r=await request(`/api/user/telegram/rooms?connection_id=${encodeURIComponent($('telegram-connection').value)}`);
    fillSelect('telegram-room',r.rooms,x=>x.name);notify(`已載入 ${r.rooms.length} 個 Telegram 聊天室`); }
  catch(err){notify(err.message,true);}
});
function renderChat(nodeId,messages) {
  const el=$(nodeId);el.replaceChildren();
  for(const m of messages) {const item=document.createElement('article');item.className='chat-line';
    const sender=document.createElement('small');sender.textContent=m.author??'';
    const content=document.createElement('div');content.textContent=m.text??'';
    item.append(sender,content);el.append(item);}
  el.scrollTop=el.scrollHeight;
}
$('telegram-messages-refresh').addEventListener('click',async()=>{
 try {const r=await request(`/api/user/telegram/messages?connection_id=${encodeURIComponent($('telegram-connection').value)}&room=${encodeURIComponent($('telegram-room').value)}`);renderChat('telegram-messages',r.messages);}catch(err){notify(err.message,true);}
});
$('telegram-send').addEventListener('submit',async e=>{
 e.preventDefault();try {await request('/api/user/telegram/messages',{method:'POST',body:JSON.stringify({connection_id:$('telegram-connection').value,room:$('telegram-room').value,text:formJson(e.target).text})}); e.target.reset(); $('telegram-messages-refresh').click();notify('Telegram 訊息已發送');}catch(err){notify(err.message,true);}
});
async function showDemoRooms(){
 const rooms=await request('/api/demo/rooms');
 const last=$('demo-room').value;
 fillSelect('demo-room',rooms,r=>r.name);
 if (rooms.some(r=>r.id===last)) $('demo-room').value=last;
 $('demo-panel').hidden=rooms.length===0;
 if (rooms.length) await showDemoMessages();
}
async function showDemoMessages(){ renderChat('demo-messages',await request(`/api/demo/messages?room=${encodeURIComponent($('demo-room').value)}`)); }
$('demo-login').addEventListener('click',async()=>{
 try{await request('/api/demo/login',{method:'POST',body:'{}'});await showDemoRooms();notify('已登入本機示範帳號。這不是任何平台的真實帳號。');}catch(err){notify(err.message,true);}
});
$('demo-room').addEventListener('change',()=>showDemoMessages().catch(err=>notify(err.message,true)));
$('demo-refresh').addEventListener('click',()=>showDemoMessages().catch(err=>notify(err.message,true)));
$('demo-send').addEventListener('submit',async e=>{
 e.preventDefault();try{await request('/api/demo/messages',{method:'POST',body:JSON.stringify({room:$('demo-room').value,text:formJson(e.target).text})});e.target.reset();await showDemoMessages();notify('本機示範訊息已送出。@platform:alice 會顯示在模擬收件聊天室，不會對外發送。');}catch(err){notify(err.message,true);}
});
if(window.crosschatDesktop){
  const quit=document.createElement('button');quit.type='button';quit.className='secondary';quit.textContent='結束程式';
  quit.addEventListener('click',()=>window.crosschatDesktop.quit());
  document.querySelector('header').append(quit);
}
$('connect').addEventListener('click', async () => {
  apiKey = $('key').value.trim();
  $('key').value = '';
  try { await refresh(); $('state').textContent = '已連線'; }
  catch (error) { apiKey = ''; $('state').textContent = '驗證失敗'; notify(error.message, true); }
});
$('refresh').addEventListener('click', () => refresh().catch(error => notify(error.message, true)));
const secretTypes = { telegram: ['webhook_secret', 'Webhook Secret'], slack: ['signing_secret', 'Signing Secret'], line: ['channel_secret', 'Channel Secret'], discord: ['public_key', 'Application Public Key (hex)'] };
$('platform').addEventListener('change', () => {
  const discord = $('platform').value === 'discord';
  $('secret-label').firstChild.textContent = secretTypes[$('platform').value][1];
  $('gateway-options').hidden = !discord;
});
function bindForm(id, endpoint, build) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = build(formJson(event.target));
      const result = await request(endpoint, { method: 'POST', body: JSON.stringify(data) });
      notify(result.queued != null ? `已排入 ${result.queued} 筆通知，請查看轉送狀態。` : '建立成功');
      event.target.reset();
      await refresh();
    } catch (error) { notify(error.message, true); }
  });
}
bindForm('connection-form', '/api/connections', data => ({ platform: data.platform, name: data.name, credentials: { token: data.token, [secretTypes[data.platform][0]]: data.secret, gateway_enabled: data.gateway_enabled === 'on', message_content_intent: data.message_content_intent === 'on' } }));
bindForm('identity-form', '/api/identities', data => data);
bindForm('address-form', '/api/addresses', data => data);
bindForm('send-form', '/api/send', data => data);

bindForm('bridge-form', '/api/bridge-rules', data => data);
for (const provider of ['slack', 'discord']) {
  $(`${provider}-oauth-form`).addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const payload = formJson(event.target);
      const result = await request(`/api/oauth/${provider}/start`, { method: 'POST', body: JSON.stringify(provider === 'slack' ? { ...payload, mode: 'bot' } : payload) });
      // Browser version opens another tab; packaged desktop routes approved OAuth URL to the OS browser.
      window.open(result.url, '_blank', 'noopener,noreferrer');
      notify(`已開啟 ${provider} 的官方授權頁。授權後重新整理可看到連線或已驗證帳號。`);
    } catch (e) { notify(e.message, true); }
  });
}
if (window.crosschatDesktop) {
  $('key-panel').hidden = true;
  window.crosschatDesktop.adminKey().then(async key => {
    apiKey = key;
    await refresh();
    $('state').textContent = '桌面版已連線';
  }).catch(error => notify(error.message, true));
}
if (new URLSearchParams(window.location.search).has('oauth')) {
  const success = new URLSearchParams(window.location.search).get('oauth') === 'success';
  notify(success ? 'OAuth 授權已完成，重新整理連線列表。' : 'OAuth 授權失敗或過期，請重新操作。', !success);
}

$('discord-install-button').addEventListener('click', async () => { try { const {url} = await request('/api/oauth/discord/install'); window.open(url, '_blank', 'noopener,noreferrer'); } catch(e) { notify(e.message, true); } });
