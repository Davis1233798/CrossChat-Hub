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
  const [connections, identities, addresses, messages, deliveries, rules, accounts, gateway, oauthConfig] = await Promise.all(
    ['connections','identities','addresses','messages','deliveries','bridge-rules','verified-accounts','gateway','oauth/config'].map(name => request(`/api/${name}`))
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
  for (const platform of ['slack','discord']) {
    $(`${platform}-oauth-button`).disabled = !oauthConfig[platform];
    $(`${platform}-oauth-state`).textContent = oauthConfig[platform] ? '可使用 OAuth 授權' : '尚未設定 Client ID / Secret / callback URL';
  }
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
      const result = await request(`/api/oauth/${provider}/start`, { method: 'POST', body: JSON.stringify(payload) });
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
