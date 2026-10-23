(() => {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const line = document.getElementById('line');
  const connecting = document.getElementById('connecting');
  const status = document.getElementById('status');
  let selected = 'telegram';
  function select(id) {
    if (!tabs.some(tab => tab.dataset.tab === id)) return;
    selected = id;
    for (const tab of tabs) {
      const active = tab.dataset.tab === id;
      tab.classList.toggle('selected', active);
      tab.setAttribute('aria-selected', String(active));
    }
    line.hidden = id !== 'line';
    connecting.hidden = id === 'line';
    status.textContent = id === 'line' ? 'LINE：官方個人聊天客戶端無法可靠嵌入 Electron' : `${id} · 官方網頁版 · 登入會話保留在此電腦`;
    window.crosschatDesktop.switchTab(id).catch(() => { status.textContent = '分頁載入失敗'; });
  }
  tabs.forEach(tab => tab.addEventListener('click', () => select(tab.dataset.tab)));
  document.getElementById('reload').addEventListener('click', () => window.crosschatDesktop.reloadTab(selected));
  document.getElementById('quit').addEventListener('click', () => window.crosschatDesktop.quit());
  document.querySelectorAll('[data-line-link]').forEach(button => button.addEventListener('click', () => window.crosschatDesktop.openLineOfficial(button.dataset.lineLink)));
  window.crosschatDesktop.onTabStatus(({ id, state }) => {
    if (id !== selected) return;
    status.textContent = `${id} · ${state === 'loaded' ? '已載入網頁（登入狀態由平台決定）' : state === 'failed' ? '連線失敗，請檢查網路或平台限制' : '載入中'}`;
  });
  select('telegram');
})();
