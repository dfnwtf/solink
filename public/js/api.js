const API_BASE = window.SOLINK_API_BASE || '/api';
const SESSION_STORAGE_KEY = 'solink.session.v1';
const SESSION_DURATION_KEY = 'solink.sessionDuration';
const DEFAULT_SESSION_DURATION_MS = 60 * 60 * 1000; // 1 hour default

let sessionToken = null;
let sessionMeta = null;
let sessionRestored = false;

// Session duration setting (can be changed by user)
export function getSessionDurationMs() {
  try {
    const stored = localStorage.getItem(SESSION_DURATION_KEY);
    if (stored) {
      const value = parseInt(stored, 10);
      // Validate range: 15 min to 12 hours
      if (value >= 15 * 60 * 1000 && value <= 12 * 60 * 60 * 1000) {
        return value;
      }
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_SESSION_DURATION_MS;
}

export function setSessionDurationMs(durationMs) {
  try {
    // Validate range: 15 min to 12 hours
    const clamped = Math.max(15 * 60 * 1000, Math.min(12 * 60 * 60 * 1000, durationMs));
    localStorage.setItem(SESSION_DURATION_KEY, String(clamped));
  } catch {
    // ignore storage errors
  }
}

// Legacy export for compatibility
export const SESSION_MAX_AGE_MS = DEFAULT_SESSION_DURATION_MS;

function removePersistedSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

function persistSessionMeta(meta) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // ignore storage errors
  }
}

function isSessionExpired(meta) {
  if (!meta?.timestamp) return true;
  const maxAge = meta.durationMs || getSessionDurationMs();
  return Date.now() - meta.timestamp > maxAge;
}

function restoreSessionFromStorage() {
  if (sessionRestored) return;
  sessionRestored = true;
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.pubkey || isSessionExpired(parsed)) {
      removePersistedSession();
      return;
    }
    sessionToken = parsed.token;
    sessionMeta = parsed;
  } catch (error) {
    console.warn('Failed to restore session', error);
  }
}

function ensureFreshSession() {
  restoreSessionFromStorage();
  if (sessionMeta && isSessionExpired(sessionMeta)) {
    sessionToken = null;
    sessionMeta = null;
    removePersistedSession();
  }
}

export function setSessionToken(token, pubkey, durationMs = null) {
  sessionToken = token || null;
  if (token && pubkey) {
    sessionMeta = { 
      token, 
      pubkey, 
      timestamp: Date.now(),
      durationMs: durationMs || getSessionDurationMs()
    };
    persistSessionMeta(sessionMeta);
  } else {
    sessionMeta = null;
    removePersistedSession();
  }
}

export function clearSessionToken() {
  sessionToken = null;
  sessionMeta = null;
  removePersistedSession();
}

export function getSessionToken() {
  ensureFreshSession();
  return sessionToken;
}

export function getPersistedSession() {
  ensureFreshSession();
  return sessionMeta ? { ...sessionMeta } : null;
}

function composeAbortSignals(signals) {
  const active = signals.filter(Boolean);
  if (!active.length) return null;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  const abort = (event) => controller.abort(event?.target?.reason || event?.reason);
  active.forEach((signal) => {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  });
  return controller.signal;
}

async function request(path, options = {}) {
  const { timeoutMs, signal, ...rest } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...(rest.headers || {}),
  };

  if (sessionToken) {
    headers.Authorization = `Bearer ${sessionToken}`;
  }

  let timeoutId;
  let timeoutController = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutController = new AbortController();
    timeoutId = setTimeout(() => {
      timeoutController.abort(new DOMException('Request timed out', 'TimeoutError'));
    }, timeoutMs);
  }

  const fetchSignal = composeAbortSignals([signal, timeoutController?.signal]);

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
    signal: fetchSignal || undefined,
  }).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });

  if (!response.ok) {
    const errorBody = await safeParseJson(response);
    const message = errorBody?.error || response.statusText || 'Request failed';
    const error = new Error(message);
    error.status = response.status;
    error.isUnauthorized = response.status === 401;
    throw error;
  }

  return safeParseJson(response);
}

async function safeParseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchNonce(pubkey) {
  if (!pubkey) {
    throw new Error('Missing pubkey');
  }
  const url = `/auth/nonce?pubkey=${encodeURIComponent(pubkey)}`;
  return request(url, { method: 'GET' });
}

export async function verifySignature({ pubkey, nonce, signature }) {
  if (!pubkey || !nonce || !signature) {
    throw new Error('Missing verification data');
  }

  const sessionDurationMs = getSessionDurationMs();
  const sessionDurationSeconds = Math.floor(sessionDurationMs / 1000);

  const result = await request('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ pubkey, nonce, signature, sessionTtl: sessionDurationSeconds }),
  });

  if (result?.token) {
    setSessionToken(result.token, pubkey, sessionDurationMs);
  }

  return result;
}

export async function sendMessage({ to, text, ciphertext, nonce, version, timestamp, tokenPreview, senderEncryptionKey }) {
  if (!to) {
    throw new Error('Missing recipient');
  }

  const payload = {
    to,
    timestamp: timestamp || Date.now(),
  };

  if (ciphertext && nonce) {
    payload.ciphertext = ciphertext;
    payload.nonce = nonce;
    payload.version = Number.isFinite(version) && version > 0 ? Number(version) : 1;
    payload.text = text || '';
    // Include sender's encryption key for recipient to decrypt
    if (senderEncryptionKey) {
      payload.senderEncryptionKey = senderEncryptionKey;
    }
  } else {
    if (!text) {
      throw new Error('Missing message content');
    }
    payload.text = text;
  }

  // Add token preview if present
  if (tokenPreview) {
    payload.tokenPreview = tokenPreview;
  }

  return request('/messages/send', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function pollInbox({ waitMs = 0, signal } = {}) {
  const params = new URLSearchParams();
  if (Number.isFinite(waitMs) && waitMs > 0) {
    params.set('wait', Math.min(waitMs, 20000));
  }
  const query = params.toString();
  const result = await request(`/inbox/poll${query ? `?${query}` : ''}`, {
    method: 'GET',
    signal,
    timeoutMs: waitMs ? waitMs + 5000 : undefined,
  });
  return result?.messages || [];
}

export async function ackMessages(ids) {
  if (!Array.isArray(ids) || !ids.length) {
    return { ok: true };
  }
  return request('/messages/ack', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export async function lookupProfile(nickname) {
  if (!nickname) {
    throw new Error('Missing nickname');
  }
  const normalized = String(nickname).trim();
  const query = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  return request(`/profile/lookup?nickname=${encodeURIComponent(query)}`, { method: 'GET' });
}

export async function fetchProfileMe() {
  return request('/profile/me', { method: 'GET' });
}

export async function fetchProfileByPubkey(pubkey) {
  if (!pubkey) {
    throw new Error('Missing pubkey');
  }
  return request(`/profile/by-key?pubkey=${encodeURIComponent(pubkey)}`, { method: 'GET' });
}

export async function updateNicknameRequest(nickname) {
  if (!nickname) {
    throw new Error('Missing nickname');
  }
  return request('/profile/nickname', {
    method: 'POST',
    body: JSON.stringify({ nickname }),
  });
}

export async function updateEncryptionKey(publicKey) {
  if (!publicKey) {
    throw new Error('Missing encryption key');
  }
  return request('/profile/encryption-key', {
    method: 'POST',
    body: JSON.stringify({ publicKey }),
  });
}

// Token preview for pump.fun links
export async function fetchTokenPreview(tokenAddress) {
  if (!tokenAddress) {
    throw new Error('Missing token address');
  }
  return request(`/token/preview?address=${encodeURIComponent(tokenAddress)}`, {
    method: 'GET',
    timeoutMs: 10000, // 10 second timeout for external API calls
  });
}

// Token preview for DexScreener pair links
export async function fetchDexPairPreview(pairAddress) {
  if (!pairAddress) {
    throw new Error('Missing pair address');
  }
  return request(`/dex/preview?pair=${encodeURIComponent(pairAddress)}`, {
    method: 'GET',
    timeoutMs: 10000, // 10 second timeout for external API calls
  });
}

// Link preview for generic URLs (Open Graph)
export async function fetchLinkPreviewApi(url) {
  if (!url) {
    throw new Error('Missing URL');
  }
  return request(`/link-preview?url=${encodeURIComponent(url)}`, {
    method: 'GET',
    timeoutMs: 8000, // 8 second timeout
  });
}

// ============================================
// R2 CLOUD SYNC - Message history sync
// ============================================

/**
 * Sync encrypted chat history to cloud (R2)
 * @param {string} contactKey - Contact's public key
 * @param {string} encryptedData - Base64 encrypted chat data
 */
export async function syncChatToCloud(contactKey, encryptedData) {
  if (!contactKey || !encryptedData) {
    throw new Error('Missing contactKey or encrypted data');
  }
  return request(`/sync/chat/${encodeURIComponent(contactKey)}`, {
    method: 'PUT',
    body: JSON.stringify({ encrypted: encryptedData }),
  });
}

/**
 * Load encrypted chat history from cloud (R2)
 * @param {string} contactKey - Contact's public key
 * @returns {Promise<{found: boolean, encrypted?: string, updatedAt?: number}>}
 */
export async function loadChatFromCloud(contactKey) {
  if (!contactKey) {
    throw new Error('Missing contactKey');
  }
  return request(`/sync/chat/${encodeURIComponent(contactKey)}`, {
    method: 'GET',
  });
}

/**
 * Delete chat history from cloud (R2)
 * @param {string} contactKey - Contact's public key
 */
export async function deleteChatFromCloud(contactKey) {
  if (!contactKey) {
    throw new Error('Missing contactKey');
  }
  return request(`/sync/chat/${encodeURIComponent(contactKey)}`, {
    method: 'DELETE',
  });
}

/**
 * Get list of all synced chats from cloud (R2)
 * @returns {Promise<{chats: Array<{contactKey: string, updatedAt: number, size: number}>}>}
 */
export async function loadChatListFromCloud() {
  return request('/sync/chats', {
    method: 'GET',
  });
}
