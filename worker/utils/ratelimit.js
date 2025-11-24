const RATE_LIMIT_PREFIX = 'rl:';
const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_SECONDS = 60;

function rateLimitKey(pubkey, bucket) {
  return `${RATE_LIMIT_PREFIX}${pubkey}:${bucket}`;
}

function currentBucket(windowSeconds) {
  return Math.floor(Date.now() / (windowSeconds * 1000));
}

export async function checkAndIncrementRateLimit(kvNamespace, pubkey, limit = DEFAULT_LIMIT, windowSeconds = DEFAULT_WINDOW_SECONDS) {
  const bucket = currentBucket(windowSeconds);
  const key = rateLimitKey(pubkey, bucket);
  const currentValueRaw = await kvNamespace.get(key);
  const currentValue = currentValueRaw ? Number(currentValueRaw) : 0;

  if (Number.isNaN(currentValue)) {
    await kvNamespace.delete(key);
    return checkAndIncrementRateLimit(kvNamespace, pubkey, limit, windowSeconds);
  }

  if (currentValue >= limit) {
    return false;
  }

  await kvNamespace.put(key, String(currentValue + 1), { expirationTtl: windowSeconds });
  return true;
}
