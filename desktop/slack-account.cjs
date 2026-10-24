'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const safeStatus = (state, detail = '') => Object.freeze({ state, detail });
const ownIdentity = account => account ? Object.freeze({
  platform: 'slack', accountKind: 'personal', accountId: account.accountId,
  teamId: account.teamId, userId: account.userId,
}) : null;

/** Main-only personal Slack account lifecycle. No method returns credentials. */
function createSlackAccountService({ pkce, userApi, safeStorage, filePath, clientId, registeredLoopbackRedirectUri, now = Date.now, fsPromises = fs } = {}) {
  let generation = 0;
  let token = null;
  let account = null;
  let state = 'unavailable';
  let pending = null;
  let closed = false;
  let disconnectNeedsRetry = false;
  let storageAvailable = false;
  let storageTail = Promise.resolve();
  const serializeStorage = operation => {
    const next = storageTail.then(operation, operation);
    storageTail = next.catch(() => {});
    return next;
  };

  async function encryptedWrite(payload, expectedGeneration) {
    if (!storageAvailable || typeof safeStorage?.encryptStringAsync !== 'function') throw new Error('secure-storage-unavailable');
    await serializeStorage(async () => {
      if (expectedGeneration !== undefined && (expectedGeneration !== generation || closed)) return;
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(payload));
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('secure-storage-encryption-failed');
      if (expectedGeneration !== undefined && (expectedGeneration !== generation || closed)) return;
      const dir = path.dirname(filePath);
      await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${filePath}.${process.pid}.${expectedGeneration ?? generation}.tmp`;
      let handle;
      try {
        handle = await fsPromises.open(temp, 'wx', 0o600);
        await handle.writeFile(encrypted); await handle.sync();
        await handle.close(); handle = null;
        if (expectedGeneration !== undefined && (expectedGeneration !== generation || closed)) { await fsPromises.unlink(temp); return; }
        await fsPromises.rename(temp, filePath);
        await fsPromises.unlink(`${filePath}.disabled`).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      } catch (error) {
        try { await handle?.close(); } catch {}
        try { await fsPromises.unlink(temp); } catch {}
        throw error;
      }
    });
  }

  async function removeStored() {
    await serializeStorage(async () => {
      const marker = `${filePath}.disabled`;
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await fsPromises.open(marker, 'wx', 0o600);
        await handle.writeFile('disabled'); await handle.sync();
        await handle.close(); handle = null;
      } catch (error) {
        try { await handle?.close(); } catch {}
        if (error?.code !== 'EEXIST') {
          // If marker creation fails, atomically move the encrypted blob itself
          // out of the load path before reporting an incomplete cleanup.
          try { await fsPromises.rename(filePath, marker); await fsPromises.unlink(marker); }
          catch (renameError) { if (renameError?.code !== 'ENOENT') throw renameError; }
          return;
        }
      }
      try { await fsPromises.unlink(filePath); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    });
  }

  async function verifyAndAdopt(candidate, expectedGeneration, persist = true, expectedAccount = null) {
    if (closed || expectedGeneration !== generation) return safeStatus('disconnected');
    if (candidate.expiresAt && candidate.expiresAt <= now()) {
      token = null; account = null; state = 'reauthorization-required';
      return safeStatus(state, 'expired');
    }
    const verified = await userApi.verifyAccount(candidate.accessToken);
    if (closed || expectedGeneration !== generation) return safeStatus('disconnected');
    if (verified.status !== 'verified') {
      token = null; account = null;
      state = verified.status === 'unavailable' ? 'verification-unavailable' : 'reauthorization-required';
      return safeStatus(state);
    }
    if ((candidate.expectedUserId && candidate.expectedUserId !== verified.account.userId) ||
        (candidate.expectedTeamId && candidate.expectedTeamId !== verified.account.teamId) ||
        (expectedAccount && (expectedAccount.userId !== verified.account.userId || expectedAccount.teamId !== verified.account.teamId))) {
      token = null; account = null; state = 'reauthorization-required';
      return safeStatus(state, 'oauth-identity-mismatch');
    }
    token = Object.freeze({ accessToken: candidate.accessToken, expiresAt: candidate.expiresAt ?? null });
    account = ownIdentity(verified.account);
    state = 'connected';
    if (persist) {
      try { await encryptedWrite({ version: 1, token, account }, expectedGeneration); }
      catch {
        if (expectedGeneration === generation) { token = null; account = null; state = 'storage-unavailable'; }
        return safeStatus(state);
      }
    }
    return safeStatus(state);
  }

  async function reload() {
    if (closed) return safeStatus('disconnected');
    if (disconnectNeedsRetry) return safeStatus('disconnect-incomplete');
    if (pending || state === 'connecting') return safeStatus('connecting');
    const current = ++generation;
    token = null; account = null;
    try {
      storageAvailable = await safeStorage.isAsyncEncryptionAvailable() === true;
    } catch { storageAvailable = false; }
    if (closed || current !== generation) return safeStatus(state);
    if (!storageAvailable) { state = pkce?.isConfigured ? 'secure-storage-unavailable' : 'unavailable'; return safeStatus(state); }
    try { await fsPromises.access(`${filePath}.disabled`); if (closed || current !== generation) return safeStatus(state); state = 'signed-out'; return safeStatus(state); }
    catch (error) { if (closed || current !== generation) return safeStatus(state); if (error?.code !== 'ENOENT') { state = 'storage-unavailable'; return safeStatus(state); } }
    if (closed || current !== generation) return safeStatus(state);
    let encrypted;
    try { encrypted = await fsPromises.readFile(filePath); }
    catch (error) {
      if (closed || current !== generation) return safeStatus(state);
      if (error?.code === 'ENOENT') { state = pkce?.isConfigured ? 'signed-out' : 'unavailable'; return safeStatus(state); }
      state = 'storage-unavailable'; return safeStatus(state);
    }
    if (closed || current !== generation) return safeStatus(state);
    try {
      const decoded = await safeStorage.decryptStringAsync(encrypted);
      if (closed || current !== generation) return safeStatus(state);
      const text = decoded?.result;
      const stored = JSON.parse(text);
      if (stored?.version !== 1 || typeof stored?.token?.accessToken !== 'string' || !stored.token.accessToken) throw new Error('invalid-account-blob');
      if (stored.token.expiresAt && stored.token.expiresAt <= now()) { state = 'reauthorization-required'; return safeStatus(state, 'expired'); }
      if (decoded?.shouldReEncrypt) {
        await encryptedWrite({ version: 1, token: stored.token, account: stored.account }, current);
        if (closed || current !== generation) return safeStatus(state);
      }
      state = 'verifying';
      if (closed || current !== generation) return safeStatus(state);
      return await verifyAndAdopt(stored.token, current, false, stored.account);
    } catch {
      if (!closed && current === generation) { token = null; account = null; state = 'storage-unavailable'; }
      return safeStatus(state);
    }
  }

  async function connect(openExternal) {
    if (closed) return safeStatus('disconnected');
    if (disconnectNeedsRetry) return safeStatus('disconnect-incomplete');
    if (!pkce?.isConfigured) { state = 'unavailable'; return safeStatus(state, 'slack-oauth-not-configured'); }
    if (pending || state === 'connecting') return safeStatus('connecting');
    const current = ++generation;
    state = 'connecting';
    if (!storageAvailable) {
      try { storageAvailable = await safeStorage.isAsyncEncryptionAvailable() === true; } catch { storageAvailable = false; }
      if (closed || current !== generation || disconnectNeedsRetry) return safeStatus(state);
    }
    if (closed || current !== generation || disconnectNeedsRetry) return safeStatus(state);
    if (!storageAvailable) { state = 'secure-storage-unavailable'; return safeStatus(state); }
    let login;
    try { login = await pkce.begin(); }
    catch {
      if (!closed && current === generation && !disconnectNeedsRetry) state = 'connect-failed';
      return safeStatus(state);
    }
    if (closed || current !== generation || disconnectNeedsRetry) { login?.cancel?.(); return safeStatus(state); }
    if (login.status !== 'ready' || !isFixedAuthorizeUrl(login.authorizeUrl, { clientId, registeredLoopbackRedirectUri })) {
      state = login.status === 'unavailable' ? 'unavailable' : 'connect-failed';
      return safeStatus(state, login.reason || 'invalid-authorize-url');
    }
    pending = login;
    try {
      await openExternal(login.authorizeUrl);
    } catch {
      login.cancel();
      if (current !== generation || closed) return safeStatus(state);
      pending = null; state = 'connect-failed'; return safeStatus(state);
    }
    if (current !== generation || closed) return safeStatus(state);
    const completion = login.completion;
    void Promise.resolve(completion).then(async result => {
      if (current !== generation || closed) return;
      pending = null;
      if (result?.status !== 'authorized') { state = result?.reason === 'authorization-cancelled' ? 'signed-out' : 'connect-failed'; return; }
      const expiresAt = Number.isFinite(result.token.expiresIn) ? now() + result.token.expiresIn * 1000 : null;
      await verifyAndAdopt({ accessToken: result.token.accessToken, expiresAt,
        expectedUserId: result.token.userId, expectedTeamId: result.token.teamId }, current, true);
    }).catch(() => { if (current === generation && !closed) { pending = null; state = 'connect-failed'; } });
    return safeStatus('connecting');
  }

  function cancel() {
    if (!pending && state !== 'connecting') return safeStatus(state);
    generation++;
    const login = pending; pending = null; token = null; account = null;
    state = pkce?.isConfigured ? 'signed-out' : 'unavailable';
    try { login.cancel(); } catch {}
    return safeStatus(state);
  }

  async function disconnect() {
    generation++;
    disconnectNeedsRetry = true;
    const login = pending; pending = null; token = null; account = null;
    state = 'signed-out';
    try { login?.cancel?.(); } catch {}
    try { await removeStored(); disconnectNeedsRetry = false; }
    catch { state = 'disconnect-incomplete'; }
    return safeStatus(state);
  }

  function close() {
    closed = true;
    generation++;
    try { pending?.cancel?.(); } catch {}
    pending = null; token = null; account = null; state = 'disconnected';
  }

  function getStatus() {
    return Object.freeze({ state, account: state === 'connected' ? account : null,
      configured: Boolean(pkce?.isConfigured), canCancel: Boolean(pending) });
  }

  // Main-process scoped token access. The token is never returned or persisted
  // by the forwarding layer; every callback is bound to the current generation.
  async function withVerifiedAccount(expected, operation) {
    const current = generation;
    if (closed || state !== 'connected' || !token?.accessToken || !account ||
        !expected || expected.accountId !== account.accountId || expected.teamId !== account.teamId || expected.userId !== account.userId ||
        typeof operation !== 'function') return safeStatus('rejected', 'slack-account-changed');
    const snapshot = account;
    const verified = await userApi.verifyAccount(token.accessToken);
    if (closed || current !== generation || state !== 'connected' || token?.accessToken === undefined || account?.accountId !== snapshot.accountId) return safeStatus('rejected', 'slack-account-changed');
    if (verified.status !== 'verified' || verified.account.accountId !== snapshot.accountId || verified.account.teamId !== snapshot.teamId || verified.account.userId !== snapshot.userId) return safeStatus('rejected', 'slack-account-changed');
    const result = await operation({ account: snapshot, accessToken: token.accessToken, generation: current });
    if (current !== generation || closed || state !== 'connected' || account?.accountId !== snapshot.accountId) return result?.status === 'submitted' ? result : safeStatus('unknown', 'reconcile-before-retry');
    return result;
  }
  function getGeneration() { return generation; }

  return Object.freeze({ reload, connect, cancel, disconnect, close, getStatus, withVerifiedAccount, getGeneration });
}

function isFixedAuthorizeUrl(value, { clientId, registeredLoopbackRedirectUri } = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== 'https://slack.com' || url.hostname !== 'slack.com' || url.port ||
        url.pathname !== '/oauth/v2/authorize' || url.username || url.password || url.hash || !clientId || !registeredLoopbackRedirectUri) return false;
    const expectedKeys = ['client_id', 'redirect_uri', 'state', 'scope', 'user_scope', 'code_challenge', 'code_challenge_method'];
    const keys = [...url.searchParams.keys()];
    if (keys.length !== expectedKeys.length || new Set(keys).size !== keys.length || expectedKeys.some(key => !url.searchParams.has(key))) return false;
    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');
    const validHash = value => /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
    return url.searchParams.get('client_id') === clientId && url.searchParams.get('redirect_uri') === registeredLoopbackRedirectUri &&
      url.searchParams.get('scope') === '' && url.searchParams.get('user_scope') === 'chat:write' &&
      url.searchParams.get('code_challenge_method') === 'S256' && validHash(state) && validHash(challenge);
  }
  catch { return false; }
}

module.exports = { createSlackAccountService, isFixedAuthorizeUrl };
