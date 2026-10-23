// Developer-only diagnostic for the synthetic fixture in an owned CEF process.
// Start the host with a fresh profile and loopback-only debugging port first.
const origin = 'chrome-extension://hcmjeeijoifmcgjhocekmfmepgijdjgb/';
const endpoint = 'http://127.0.0.1:19377';
async function targets() { return (await fetch(`${endpoint}/json/list`)).json(); }
async function connect(target) {
  if (!target.url.startsWith(origin) || !target.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:19377/')) throw new Error('Not the synthetic fixture');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
  };
  return {
    call: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 10000);
      pending.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    close: () => socket.close(),
  };
}
const main = (await targets()).find(target => target.type === 'page' && target.url === `${origin}probe.html`);
if (!main) throw new Error('Start the isolated CEF host with the fixture probe URL first');
const client = await connect(main);
const report = { fixtureOnly: true, realLineLogin: false };
try {
  const evaluate = async expression => {
    const reply = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.error || reply.result?.exceptionDetails) throw new Error('Fixture evaluation failed');
    return reply.result.result.value;
  };
  report.page = await evaluate('({title:document.title, result:document.getElementById("result")?.textContent})');
  report.mainWindow = (await client.call('Browser.getWindowForTarget', { targetId: main.id })).result;
  report.created = await evaluate('chrome.runtime.sendMessage({type:"worker-window"})');
  report.windows = [];
  for (const target of (await targets()).filter(item => item.type === 'page' && item.url.startsWith(origin))) {
    const child = await connect(target);
    try { report.windows.push({ url: target.url, ...(await child.call('Browser.getWindowForTarget', { targetId: target.id })).result }); }
    finally { child.close(); }
  }
  report.sameWindow = report.created?.created === true && report.created.id === report.mainWindow?.windowId;
  console.log(JSON.stringify(report, null, 2));
} finally { client.close(); }
