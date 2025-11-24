import { generateToken } from './crypto';

const NONCE_PREFIX = 'nonce:';
const DEFAULT_TTL_SECONDS = 300; // 5 минут

function nonceKey(pubkey) {
  return `${NONCE_PREFIX}${pubkey}`;
}

export async function issueNonce(kvNamespace, pubkey, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const nonce = generateToken(16);
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const key = nonceKey(pubkey);
  const payload = JSON.stringify({ nonce, expiresAt });

  await kvNamespace.put(key, payload, { expirationTtl: ttlSeconds });

  return { nonce, expiresAt };
}

export async function consumeNonce(kvNamespace, pubkey) {
  const key = nonceKey(pubkey);
  const payload = await kvNamespace.get(key);
  if (!payload) {
    return null;
  }

  await kvNamespace.delete(key);

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function isNonceValid(record, nonce) {
  if (!record) return false;
  if (record.nonce !== nonce) return false;
  return record.expiresAt && Date.now() <= record.expiresAt;
}
