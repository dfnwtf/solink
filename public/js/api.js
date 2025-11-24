const API_BASE = window.SOLINK_API_BASE || '/api';

let sessionToken = null;

export function setSessionToken(token) {
  sessionToken = token;
}

export function clearSessionToken() {
  sessionToken = null;
}

export function getSessionToken() {
  return sessionToken;
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
    throw new Error(message);
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

  const result = await request('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ pubkey, nonce, signature }),
  });

  if (result?.token) {
    setSessionToken(result.token);
  }

  return result;
}

export async function sendMessage({ to, text, ciphertext, nonce, version, timestamp }) {
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
  } else {
    if (!text) {
      throw new Error('Missing message content');
    }
    payload.text = text;
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
