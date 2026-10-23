const capabilities = () => ({
  worker: true,
  windowsCreate: typeof chrome.windows?.create === 'function',
  windowsRemoved: typeof chrome.windows?.onRemoved?.addListener === 'function',
  downloads: typeof chrome.downloads?.download === 'function',
  notifications: typeof chrome.notifications?.create === 'function',
  cookies: typeof chrome.cookies?.remove === 'function',
  display: typeof chrome.system?.display?.getInfo === 'function',
});
async function report() {
  const previous = (await chrome.storage.local.get('starts')).starts || 0;
  await chrome.storage.local.set({ starts: previous + 1, capabilities: capabilities() });
}
void report();
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'capabilities') {
    chrome.storage.local.get(['starts', 'capabilities']).then(reply);
    return true;
  }
  if (message?.type === 'worker-window') {
    chrome.windows.create({ url: chrome.runtime.getURL('probe.html?child=worker'), type: 'popup', width: 680, height: 480 })
      .then(window => reply({ id: window.id, created: true }), error => reply({ error: error.message }));
    return true;
  }
});
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('probe.html') });
});
