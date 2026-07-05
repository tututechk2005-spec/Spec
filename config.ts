import 'dotenv/config';
import crypto from 'crypto';
import CryptoJS from 'crypto-js';

function resolveEncryptionKey(): string {
  const explicit = process.env.ENCRYPTION_KEY;
  if (explicit && explicit.length >= 32) return explicit;
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('Cannot derive encryption key: BOT_TOKEN is not set.');
  return crypto.createHmac('sha256', 'tg-bot-enc-v1').update(token).digest('hex');
}

let _encKey: string | null = null;
function getEncKey(): string {
  if (!_encKey) _encKey = resolveEncryptionKey();
  return _encKey;
}

export function encrypt(plaintext: string): string {
  return CryptoJS.AES.encrypt(plaintext, getEncKey()).toString();
}

export function decrypt(ciphertext: string): string {
  const bytes = CryptoJS.AES.decrypt(ciphertext, getEncKey());
  const result = bytes.toString(CryptoJS.enc.Utf8);
  if (!result) throw new Error('Decryption failed — wrong key or corrupted data');
  return result;
}

export function maskKey(apiKey: string): string {
  if (apiKey.length < 8) return '****';
  return apiKey.slice(0, 4) + '****' + apiKey.slice(-4);
}

export function validateEnv(): void {
  for (const key of ['BOT_TOKEN', 'ADMIN_CHAT_ID']) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  getEncKey();
}
