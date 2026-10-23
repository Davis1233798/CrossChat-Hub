import { createCipheriv, createDecipheriv, createHmac, createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

export function equal(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function encryption(cryptoKey) {
  if (!/^[a-f0-9]{64}$/i.test(cryptoKey ?? '')) throw new Error('ENCRYPTION_KEY must be a 32-byte hex string');
  const key = Buffer.from(cryptoKey, 'hex');
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('base64url')).join('.');
    },
    open(value) {
      const parts = value.split('.').map(v => Buffer.from(v, 'base64url'));
      if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error('Invalid encrypted connection');
      const decipher = createDecipheriv('aes-256-gcm', key, parts[0]);
      decipher.setAuthTag(parts[1]);
      return JSON.parse(Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8'));
    },
  };
}

export function verifySlack(raw, headers, signingSecret, now = Date.now()) {
  const timestamp = headers['x-slack-request-timestamp'];
  if (!/^\d{10}$/.test(timestamp ?? '') || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(raw).digest('hex');
  return equal(expected, headers['x-slack-signature']);
}
export function verifyLine(raw, headers, channelSecret) {
  const signature = createHmac('sha256', channelSecret).update(raw).digest('base64');
  return equal(signature, headers['x-line-signature']);
}
export function verifyTelegram(headers, secret) {
  return Boolean(secret) && equal(headers['x-telegram-bot-api-secret-token'], secret);
}
export function verifyDiscord(raw, headers, publicKey) {
  const signature = headers['x-signature-ed25519'];
  const timestamp = headers['x-signature-timestamp'];
  if (!/^[0-9a-f]{128}$/i.test(signature ?? '') || !/^\d{10,}$/.test(timestamp ?? '') || !/^[0-9a-f]{64}$/i.test(publicKey ?? '')) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(timestamp), raw]), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}
export function eventHash(connectionId, value) {
  return createHash('sha256').update(`${connectionId}:${value}`).digest('hex');
}
