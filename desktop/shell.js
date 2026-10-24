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
  const lineCandidateList = document.getElementById('line-candidate-list');
  const lineBindingStatus = document.getElementById('line-binding-status');
  const lineUnbind = document.getElementById('line-unbind');
  let lineBindingBusy = false;
  function clearLineCandidates() { lineCandidateList.replaceChildren(); }
  document.getElementById('line-candidates-refresh').addEventListener('click', async () => {
    if (lineBindingBusy) return;
    lineBindingBusy = true; clearLineCandidates(); lineBindingStatus.textContent = '正在檢查 LINE 主視窗中繼資料…';
    try {
      const result = await window.crosschatDesktop.listLineCandidates();
      lineUnbind.hidden = !result.bound;
      if (result.status === 'stale') { lineBindingStatus.textContent = '候選清單已更新，請重新列出 LINE 視窗。'; return; }
      if (result.status !== 'available') { lineBindingStatus.textContent = '目前無法確認 LINE 主視窗（Windows 開發版 helper 或官方簽章驗證不可用）。'; return; }
      lineBindingStatus.textContent = result.candidates.length ? '請逐一確認視窗；程式不會替你選擇。' : '未找到符合條件的官方 LINE 主視窗。';
      for (const candidate of result.candidates) {
        const row = document.createElement('li');
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `確認：第 ${candidate.sequence} 個視窗是我已登入的聊天主視窗，並綁定`;
        button.addEventListener('click', async () => {
          if (lineBindingBusy) return;
          lineBindingBusy = true; button.disabled = true;
          try {
            const bound = await window.crosschatDesktop.bindLineCandidate({ candidateId: candidate.candidateId, confirmed: true });
            clearLineCandidates();
            if (bound.status === 'bound') { lineBindingStatus.textContent = '已綁定你確認的 LINE 主視窗。每次觀察前都會重新驗證。'; lineUnbind.hidden = false; }
            else { lineBindingStatus.textContent = '候選視窗已失效，請重新列出並確認。'; lineUnbind.hidden = true; }
          } catch { lineBindingStatus.textContent = '無法綁定此視窗，請重新列出並確認。'; }
          finally { lineBindingBusy = false; }
        });
        row.append(button); lineCandidateList.append(row);
      }
    } catch { lineBindingStatus.textContent = '無法列出 LINE 主視窗。'; }
    finally { lineBindingBusy = false; }
  });
  lineUnbind.addEventListener('click', async () => {
    if (lineBindingBusy) return;
    lineBindingBusy = true;
    try { await window.crosschatDesktop.unbindLine(); lineUnbind.hidden = true; clearLineCandidates(); lineBindingStatus.textContent = '已解除 LINE 主視窗綁定。'; }
    catch { lineBindingStatus.textContent = '無法解除綁定。'; }
    finally { lineBindingBusy = false; }
  });
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
  const mode = document.getElementById('compose-mode');
  const sourcePlatform = document.getElementById('source-platform');
  const sourceChat = document.getElementById('source-chat');
  const routeInput = document.getElementById('compose-route');
  let draft = null, capture = null, editVersion = 0;
  const selectionArm = document.getElementById('selection-arm');
  const selectionCancel = document.getElementById('selection-cancel');
  const selectionHint = document.getElementById('selection-source-hint');
  let armedSelection = null, armRequestPending = false;
  function revoke(ref) { if (ref) void window.crosschatDesktop.revokeSelection(ref).catch(() => {}); }
  function cancelArmedSelection() {
    const arm = armedSelection; armedSelection = null;
    selectionArm.hidden = mode.value !== 'selection' || sourcePlatform.value !== 'line';
    selectionCancel.hidden = true;
    selectionHint.textContent = '人工貼入，來源未經平台驗證';
    if (arm) void window.crosschatDesktop.cancelSelectionCapture({ armId: arm.armId }).catch(() => {});
  }
  function changed() {
    editVersion++;
    cancelArmedSelection();
    revoke(capture); capture = null; draft = null;
    composeStatus.textContent = '內容已變更，請重新預覽目的地。尚未發送。';
  }
  for (const input of [composeText, sourceChat, routeInput]) input.addEventListener('input', changed);
  sourcePlatform.addEventListener('change', changed);
  mode.addEventListener('change', () => {
    changed();
    const forwarding = mode.value === 'selection';
    document.getElementById('compose-source').hidden = !forwarding;
    document.getElementById('compose-route-row').hidden = !forwarding;
    document.getElementById('compose-text-label').textContent = forwarding ? '貼入要轉發的單則原文' : '跨軟體訊息';
    document.getElementById('compose-help').textContent = forwarding ? '請自行核對來源及原文；預覽不會發送訊息' : '例如 @line:群組名:人名 要說的話；名稱含空白請用雙引號';
    composeText.placeholder = forwarding ? '貼入你選擇的單則文字；不會自動讀取聊天記錄' : '@line:群組名 訊息內容';
    selectionArm.hidden = !forwarding || sourcePlatform.value !== 'line';
  });
  sourcePlatform.addEventListener('change', () => { selectionArm.hidden = mode.value !== 'selection' || sourcePlatform.value !== 'line'; });
  selectionArm.addEventListener('click', async () => {
    if (armedSelection || mode.value !== 'selection' || sourcePlatform.value !== 'line' || !sourceChat.value.trim()) {
      composeStatus.textContent = '請選擇 LINE 並填寫來源聊天室名稱。尚未讀取或發送。'; return;
    }
    const requestVersion = editVersion;
    armRequestPending = true;
    selectionArm.disabled = true;
    try {
      const result = await window.crosschatDesktop.armSelectionCapture({ platform: 'line', chatName: sourceChat.value });
      if (result.status === 'prepared') {
        if (requestVersion !== editVersion || mode.value !== 'selection' || sourcePlatform.value !== 'line') {
          void window.crosschatDesktop.cancelSelectionCapture({ armId: result.armId }).catch(() => {});
          return;
        }
        armedSelection = { armId: result.armId, editVersion };
        selectionArm.hidden = true; selectionCancel.hidden = false;
        selectionHint.textContent = '30 秒內切回 LINE，選取單則文字後按 Ctrl+Shift+Alt+S。尚未讀取或發送。';
        composeStatus.textContent = '等待你在已綁定的 LINE 視窗選取文字並按快捷鍵。';
        const activated = await window.crosschatDesktop.activateSelectionCapture({ armId: result.armId });
        if (activated.status !== 'armed' && armedSelection?.armId === result.armId) {
          cancelArmedSelection();
          composeStatus.textContent = activated.reason === 'shortcut-unavailable' ? '快捷鍵正在被其他程式使用。請關閉該程式後重試。' : '讀取準備已取消，請重試。';
        }
      } else if (result.reason === 'shortcut-unavailable') composeStatus.textContent = '快捷鍵正在被其他程式使用。請關閉該程式後重試。';
      else if (result.reason === 'line-window-not-bound') composeStatus.textContent = '請先在 LINE 分頁綁定你確認的 LINE 主視窗。';
      else composeStatus.textContent = '目前無法準備讀取選取文字，請確認來源欄位後重試。';
    } catch { composeStatus.textContent = '無法準備讀取選取文字。尚未讀取或發送。'; }
    finally { armRequestPending = false; selectionArm.disabled = false; }
  });
  selectionCancel.addEventListener('click', cancelArmedSelection);
  window.crosschatDesktop.onObservedSelection(result => {
    const arm = armedSelection;
    if (!arm || result.armId !== arm.armId || arm.editVersion !== editVersion) return;
    armedSelection = null; selectionCancel.hidden = true;
    selectionArm.hidden = mode.value !== 'selection' || sourcePlatform.value !== 'line';
    if (result.status !== 'captured') {
      selectionHint.textContent = '讀取失敗；原文欄內容已保留。';
      composeStatus.textContent = result.status === 'expired' ? '讀取準備已逾時。原文欄未變更。' : '未能讀取單則選取文字。請確認焦點仍在 LINE、僅選取一則文字，然後重試。原文欄未變更。';
      return;
    }
    changed();
    composeText.value = result.text;
    const ref = { selectionId: result.selectionId, captureRevision: result.captureRevision };
    capture = ref;
    selectionHint.textContent = '來自 LINE 介面選取文字；來源聊天室由你填寫，未經平台驗證。';
    composeStatus.textContent = '已讀取選取文字。請核對來源與原文，再預覽目的地；未發送。';
    void window.crosschatDesktop.acknowledgeSelectionCapture({ armId: result.armId, ...ref }).then(ack => {
      if (ack.status !== 'accepted' && capture === ref) {
        revoke(ref); capture = null;
        selectionHint.textContent = '讀取結果已逾時；請重新準備讀取。';
        composeStatus.textContent = '讀取結果未能保留，請重試。原文欄內容已保留。';
      }
    }).catch(() => { if (capture === ref) { revoke(ref); capture = null; } });
  });
  previewButton.addEventListener('click', async () => {
    if (armedSelection || armRequestPending) { editVersion++; cancelArmedSelection(); }
    const version = editVersion;
    previewButton.disabled = true;
    try {
      let result;
      if (mode.value === 'selection') {
        if (!capture) {
          const saved = await window.crosschatDesktop.captureSelection({ text: composeText.value, platform: sourcePlatform.value, chatName: sourceChat.value });
          if (saved.status !== 'captured') { composeStatus.textContent = '請填寫來源聊天室並貼入單則文字。未發送。'; return; }
          const ref = { selectionId: saved.selectionId, captureRevision: saved.captureRevision };
          if (version !== editVersion) { revoke(ref); return; }
          capture = ref;
        }
        result = await window.crosschatDesktop.prepareSelection({ ...capture, routeText: routeInput.value });
      } else {
        const input = { text: composeText.value, ...(draft ? { draftId: draft.draftId, revision: draft.revision } : {}) };
        result = await window.crosschatDesktop.prepareDraft(input);
      }
      if (version !== editVersion) return;
      if (result.draftId) draft = { draftId: result.draftId, revision: result.revision };
      const p = result.preview;
      const source = result.source ? `來源：${result.source.platform}「${result.source.chatName}」（${result.source.provenance === 'ui-selected-text-unverified-origin' ? '介面選取，來源未經平台驗證' : '人工確認，未經平台驗證'}） → ` : '';
      if (p) composeStatus.textContent = `${source}${p.platform}「${p.chatName}」${p.memberName ? ` · 提及「${p.memberName}」` : ''}。此平台尚未接通傳送，未發送。`;
      else {
        if (result.status === 'rejected') draft = null;
        composeStatus.textContent = mode.value === 'selection' ? '請只填目的地 @平台:聊天室[:人名]，原文由來源欄保留。未發送。' : '無法解析目的地，請使用 @line:群組名[:人名] 訊息。未發送。';
      }
    } catch { composeStatus.textContent = '無法預覽目的地，未發送。'; }
    finally { previewButton.disabled = false; }
  });
})();
