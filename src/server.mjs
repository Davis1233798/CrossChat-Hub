import { startHub } from './runtime.mjs';
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const hub = await startHub({ port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`CrossChat Hub listening on http://127.0.0.1:${hub.port}`);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await hub.close(); process.exitCode = 0; }
  catch (e) { console.error(e); process.exitCode = 1; }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
