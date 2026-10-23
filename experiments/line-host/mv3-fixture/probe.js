const result = document.getElementById('result');
async function inspect() {
  try {
    result.textContent = JSON.stringify({ extensionId: chrome.runtime.id, ...await chrome.runtime.sendMessage({ type: 'capabilities' }) }, null, 2);
  } catch (error) { result.textContent = error.message; }
}
document.getElementById('refresh').onclick = inspect;
document.getElementById('popup').onclick = () => { window.open(chrome.runtime.getURL('probe.html?child=ordinary'), 'fixture-popup', 'width=680,height=480'); };
document.getElementById('worker').onclick = async () => {
  try { result.textContent = JSON.stringify(await chrome.runtime.sendMessage({ type: 'worker-window' }), null, 2); }
  catch (error) { result.textContent = error.message; }
};
void inspect();
