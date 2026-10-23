import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
if (existsSync('.env')) {
  console.error('.env already exists; nothing was overwritten.');
  process.exitCode = 1;
} else {
  const key = () => randomBytes(32).toString('hex');
  writeFileSync('.env', `HOST=127.0.0.1\nPORT=8787\nDATABASE_PATH=./data/crosschat.sqlite\nADMIN_API_KEY=${key()}\nENCRYPTION_KEY=${key()}\nWEBHOOK_BASE_URL=\nOUTBOX_INTERVAL_MS=2000\n`, { mode: 0o600 });
  mkdirSync('data', { recursive: true });
  console.log('Generated .env with unique admin/encryption keys; keep it private.');
}
