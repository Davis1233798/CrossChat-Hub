/** A blocked websocket/HTTP client must not keep the desktop executable locked forever. */
export async function closeWithDeadline(close, timeoutMs = 2500) {
  if (!close) return 'closed';
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(close).then(() => 'closed', () => 'error'),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
