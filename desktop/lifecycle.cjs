'use strict';

async function flushSessions(sessions) {
  const results = await Promise.allSettled([...new Set(sessions)].flatMap(isolated => [
    Promise.resolve().then(() => isolated.flushStorageData()),
    Promise.resolve().then(() => isolated.cookies.flushStore()),
  ]));
  if (results.some(result => result.status === 'rejected')) throw new Error('Session persistence failed');
}

// Native close, app quit and installer WM_CLOSE must share one bounded operation.
// A hung network/storage process must never hold the executable open indefinitely.
function createShutdown({ prepare, flush, exit, onFailure = () => {}, timeoutMs = 5000 }) {
  let pending;
  return function shutdown() {
    if (pending) return pending;
    pending = new Promise(resolve => {
      let finished = false;
      const finish = ok => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (!ok) onFailure();
        resolve(ok);
        exit(ok ? 0 : 1);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      // Deferring prepare also makes reentrant native close events join pending.
      Promise.resolve().then(prepare).then(flush).then(() => finish(true), () => finish(false));
    });
    return pending;
  };
}
module.exports = { createShutdown, flushSessions };
