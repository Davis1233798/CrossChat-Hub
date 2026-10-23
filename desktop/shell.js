(() => {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const line = document.getElementById('line');
  const connecting = document.getElementById('connecting');
  const status = document.getElementById('status');
  const saved = window.localStorage.getItem('crosschat-last-tab');
  let selected = tabs.some(t => t.dataset.tab === saved) ? saved : 'telegram';
  function select(id, notify = true) {
    if (!tabs.some(tab => tab.dataset.tab === id)) return;
    selected = id;
    window.localStorage.setItem('crosschat-last-tab', id);
    document.getElementById('open-browser').hidden = id === 'line';
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
    const labels = {
      loaded: '已載入官方網頁；請在頁面內登入（這不代表已驗證成功）',
      failed: '無法載入網頁。可按「官方網站」在瀏覽器測試登入',
      loading: '正在載入…',
      downloaded: '附件儲存完成',
      'download-error': '附件下載中斷',
      'external-error': '無法開啟外部網站，請稍後再試',
      unsupported: 'LINE 只能使用官方獨立客戶端或 Chrome 擴充功能',
    };
    status.textContent = `${id} · ${labels[state] ?? state}`;
  });
  select(selected);
})();
