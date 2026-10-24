(() => {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const line = document.getElementById('line');
  const connecting = document.getElementById('connecting');
  const status = document.getElementById('status');
  const profileState = document.getElementById('profile-state');
  const clearProfile = document.getElementById('clear-profile');
  const clearingIds = new Set();
  const saved = window.localStorage.getItem('crosschat-last-tab');
  let selected = tabs.some(t => t.dataset.tab === saved) ? saved : 'telegram';
  function select(id, notify = true) {
    if (!tabs.some(tab => tab.dataset.tab === id)) return;
    selected = id;
    window.localStorage.setItem('crosschat-last-tab', id);
    document.getElementById('open-browser').hidden = id === 'line';
    clearProfile.hidden = id === 'line';
    clearProfile.disabled = clearingIds.has(id);
    profileState.hidden = true;
    for (const tab of tabs) {
      const active = tab.dataset.tab === id;
      tab.classList.toggle('selected', active);
      tab.setAttribute('aria-selected', String(active));
    }
    line.hidden = id !== 'line';
    connecting.hidden = id === 'line';
    status.textContent = id === 'line' ? 'LINE：官方個人聊天客戶端無法可靠嵌入 Electron' : `${id} · 官方網頁版 · 登入會話保留在此電腦`;
    if (notify) window.crosschatDesktop.switchTab(id).catch(() => { status.textContent = '分頁載入失敗'; });
  }
  tabs.forEach(tab => tab.addEventListener('click', () => select(tab.dataset.tab)));
  document.getElementById('reload').addEventListener('click', () => window.crosschatDesktop.reloadTab(selected));
  clearProfile.addEventListener('click', async () => {
    const id = selected;
    if (clearingIds.has(id)) return;
    clearingIds.add(id);
    clearProfile.disabled = true;
    try {
      const result = await window.crosschatDesktop.clearProfile(id);
      if (selected === id && result.state === 'cleared') status.textContent = `${id} · 已清除本機登入資料，請在官方頁面重新登入`;
    } catch {
      if (selected === id) status.textContent = `${id} · 無法清除本機登入資料，請稍後重試`;
    } finally {
      clearingIds.delete(id);
      clearProfile.disabled = clearingIds.has(selected);
    }
  });
  document.getElementById('open-browser').addEventListener('click', () => window.crosschatDesktop.openInBrowser(selected));
  document.getElementById('quit').addEventListener('click', () => window.crosschatDesktop.quit());
  document.querySelectorAll('[data-line-link]').forEach(button => button.addEventListener('click', () => window.crosschatDesktop.openLineOfficial(button.dataset.lineLink)));
  window.crosschatDesktop.onTabStatus(({ id, state, detail }) => {
    if (state === 'selected') { select(id, false); return; }
    const tab = tabs.find(t => t.dataset.tab === id);
    if (state === 'title' && tab) {
      const old = tab.querySelector('.unread');
      if (old) old.remove();
      if (detail) { const badge = document.createElement('span'); badge.className = 'unread'; badge.textContent = detail; tab.appendChild(badge); }
      return;
    }
    if (id !== selected) return;
    if (state === 'resetting' || state === 'reset-error') {
      connecting.hidden = true;
      profileState.hidden = false;
      document.getElementById('profile-state-title').textContent = state === 'resetting' ? '正在清除本機登入資料' : '本機資料尚未清除完成';
      document.getElementById('profile-state-detail').textContent = state === 'resetting' ? '此平台暫停載入，其他平台可以繼續使用。' : '此平台保持暫停，避免網站重新寫入資料。請按「清除登入」重試。';
    } else if (state === 'cleared' || state === 'loaded' || state === 'loading') {
      profileState.hidden = true;
    }
    const labels = {
      loaded: '已載入官方網頁；請在頁面內登入（這不代表已驗證成功）',
      failed: '無法載入網頁。可按「官方網站」在瀏覽器測試登入',
      loading: '正在載入…',
      downloaded: '附件儲存完成',
      'download-error': '附件下載中斷',
      'external-error': '無法開啟外部網站，請稍後再試',
      resetting: '正在清除此裝置上的登入資料…',
      cleared: '已清除本機登入資料，請重新登入',
      'reset-error': '清除未完成；此平台暫停載入，請重試',
      unsupported: 'LINE 只能使用官方獨立客戶端或 Chrome 擴充功能',
    };
    status.textContent = `${id} · ${labels[state] ?? state}`;
  });
  select(selected);
  const composeText = document.getElementById('compose-text');
  const composeStatus = document.getElementById('compose-status');
  const previewButton = document.getElementById('compose-preview');
  let draft = null, editVersion = 0;
  composeText.addEventListener('input', () => {
    editVersion++;
    composeStatus.textContent = '內容已變更，請重新預覽目的地。尚未發送。';
  });
  previewButton.addEventListener('click', async () => {
    const version = editVersion;
    previewButton.disabled = true;
    try {
      const input = { text: composeText.value, ...(draft ? { draftId: draft.draftId, revision: draft.revision } : {}) };
      const result = await window.crosschatDesktop.prepareDraft(input);
      if (result.draftId) draft = { draftId: result.draftId, revision: result.revision };
      if (version !== editVersion) return;
      const p = result.preview;
      if (p) composeStatus.textContent = `${p.platform} · 群組「${p.chatName}」${p.memberName ? ` · 提及「${p.memberName}」` : ''}。個人聊天傳送尚未支援，未發送。`;
      else {
        if (result.status === 'rejected') draft = null;
        composeStatus.textContent = '無法解析目的地，請使用 @line:群組名[:人名] 訊息。未發送。';
      }
    } catch { composeStatus.textContent = '無法預覽目的地，未發送。'; }
    finally { previewButton.disabled = false; }
  });
})();
