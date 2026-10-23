// Developer-only diagnostic for the synthetic fixture in an owned CEF process.
// Start the host with a fresh profile and loopback-only debugging port first.
const origin = 'chrome-extension://hcmjeeijoifmcgjhocekmfmepgijdjgb/';
const endpoint = 'http://127.0.0.1:19377';
const mode = process.argv[2] || 'both';
if (!['ordinary', 'worker', 'both'].includes(mode)) throw new Error('Usage: node inspect-cef.mjs [ordinary|worker|both]');
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
    close: () => { for (const request of pending.values()) clearTimeout(request.timer); socket.close(); },
  };
}
const main = (await targets()).find(target => target.type === 'page' && target.url === `${origin}probe.html`);
if (!main) throw new Error('Start the isolated CEF host with the fixture probe URL first');
const client = await connect(main);
const report = { fixtureOnly: true, realLineLogin: false };
try {
  const evaluate = async (expression, userGesture = false) => {
    const reply = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (reply.error || reply.result?.exceptionDetails) throw new Error('Fixture evaluation failed');
    return reply.result.result.value;
  };
  report.page = await evaluate('({title:document.title, result:document.getElementById("result")?.textContent})');
  async function windowFor(target) {
    const child = await connect(target);
    try {
      const reply = await child.call('Browser.getWindowForTarget', { targetId: target.id });
      if (reply.error || !Number.isInteger(reply.result?.windowId)) throw new Error('No authoritative CDP window ID');
      return { targetId: target.id, url: target.url, ...reply.result };
    }
    finally { child.close(); }
  }
  report.mainWindow = await windowFor(main);
  report.paths = [];
  for (const path of mode === 'both' ? ['ordinary', 'worker'] : [mode]) {
    const url = `${origin}probe.html?child=${path}`;
    if ((await targets()).some(target => target.url === url)) throw new Error(`Existing ${path} child: use a fresh fixture session`);
    const request = path === 'worker'
      ? await evaluate('chrome.runtime.sendMessage({type:"worker-window"})', true)
      : await evaluate('document.getElementById("popup").click(); true', true);
    let matches = [];
    const deadline = Date.now() + 10000;
    do {
      matches = (await targets()).filter(target => target.type === 'page' && target.url === url);
      if (matches.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if (matches.length !== 1) throw new Error(`Expected one ${path} child target; observed ${matches.length}`);
    const childWindow = await windowFor(matches[0]);
    report.paths.push({ path, request, childWindow, sameWindow: childWindow.windowId === report.mainWindow.windowId });
  }
  // Compare CDP window IDs to CDP window IDs, never chrome.windows API IDs.
  report.sameWindow = report.paths.every(path => path.sameWindow);
  console.log(JSON.stringify(report, null, 2));
  if (!report.sameWindow) process.exitCode = 1;
} finally { client.close(); }
