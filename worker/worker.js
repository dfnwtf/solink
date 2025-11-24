import { verifyEd25519Signature, generateToken } from './utils/crypto';
import { issueNonce, consumeNonce, isNonceValid } from './utils/nonce';
import { checkAndIncrementRateLimit } from './utils/ratelimit';
import { InboxDurable, INBOX_DELIVERY_TTL_MS, MAX_BATCH } from './inbox-do';

const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 15 * 60; // 15 минут
const MAX_MESSAGE_LENGTH = 1024;
const DEFAULT_CORS = {
  origin: '*',
  methods: 'GET,POST,OPTIONS',
  headers: 'Content-Type,Authorization',
};
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROFILE_PREFIX = 'profile:';
const NICKNAME_PREFIX = 'nickname:';
const NICKNAME_REGEX = /^[a-z0-9_.-]{3,24}$/;
const INBOX_PULL_LIMIT = MAX_BATCH;

function sessionKey(token) {
  return `${SESSION_PREFIX}${token}`;
}

function buildCorsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.CORS_ALLOW_ORIGIN || DEFAULT_CORS.origin,
    'Access-Control-Allow-Methods': env.CORS_ALLOW_METHODS || DEFAULT_CORS.methods,
    'Access-Control-Allow-Headers': env.CORS_ALLOW_HEADERS || DEFAULT_CORS.headers,
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(env, data, init = {}) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Cache-Control': 'no-store',
    ...buildCorsHeaders(env),
    ...(init.headers || {}),
  };

  return new Response(JSON.stringify(data), { ...init, headers });
}

function errorResponse(env, message, status = 400) {
  return jsonResponse(env, { error: message }, { status });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function extractBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const [, token] = header.match(/^Bearer (.+)$/) || [];
  return token || null;
}

async function callInbox(env, pubkey, payload) {
  if (!env.INBOX_DO) {
    throw new Error('INBOX_DO binding missing');
  }
  if (!pubkey) {
    throw new Error('Missing pubkey for inbox call');
  }
  const id = env.INBOX_DO.idFromName(pubkey);
  const stub = env.INBOX_DO.get(id);
  const response = await stub.fetch('https://inbox', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Inbox action "${payload.action}" failed: ${response.status} ${text}`);
  }
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return null;
}

async function inboxStore(env, pubkey, message) {
  await callInbox(env, pubkey, { action: 'store', message });
}

async function inboxPull(env, pubkey, limit = INBOX_PULL_LIMIT) {
  const result = await callInbox(env, pubkey, { action: 'pull', limit });
  return result?.messages || [];
}

async function inboxAck(env, pubkey, ids) {
  await callInbox(env, pubkey, { action: 'ack', ids });
}

async function getSessionPubkey(kvNamespace, token) {
  if (!token) return null;
  const payload = await kvNamespace.get(sessionKey(token));
  if (!payload) return null;

  try {
    const data = JSON.parse(payload);
    return data.pubkey || null;
  } catch {
    await kvNamespace.delete(sessionKey(token));
    return null;
  }
}

async function createSession(kvNamespace, pubkey) {
  const token = generateToken(24);
  await kvNamespace.put(sessionKey(token), JSON.stringify({ pubkey }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

function sanitizeMessageText(text = '') {
  if (typeof text !== 'string') return '';
  return text.slice(0, MAX_MESSAGE_LENGTH);
}

function normalizePubkey(value) {
  if (!value) return '';
  const raw = String(value).trim();

  const shareMatch = raw.match(/#\/dm\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (shareMatch) {
    return shareMatch[1];
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const fromHash = normalizePubkey(url.hash);
      if (fromHash) {
        return fromHash;
      }
      const lastSegment = url.pathname.split('/').filter(Boolean).pop();
      if (lastSegment && BASE58_REGEX.test(lastSegment)) {
        return lastSegment;
      }
    } catch {
      // ignore malformed URLs
    }
  }

  const hashless = raw.replace(/^#\/?/, '');
  if (hashless.startsWith('dm/')) {
    return normalizePubkey(hashless.slice(3));
  }

  const base58Match = raw.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (base58Match && BASE58_REGEX.test(base58Match[0])) {
    return base58Match[0];
  }

  return BASE58_REGEX.test(raw) ? raw : '';
}

function isValidPubkey(value) {
  return BASE58_REGEX.test(value);
}

export default {
  async fetch(request, env) {
    if (!env.SOLINK_KV) {
      return new Response('KV binding SOLINK_KV is missing', { status: 500 });
    }

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...buildCorsHeaders(env),
          'Content-Length': '0',
        },
      });
    }

    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not Found', { status: 404 });
    }

    switch (url.pathname) {
      case '/api/auth/nonce':
        return handleNonceRequest(request, url, env);
      case '/api/auth/verify':
        return handleVerifyRequest(request, env);
      case '/api/messages/send':
        return handleSendMessage(request, env);
      case '/api/messages/ack':
        return handleAckMessages(request, env);
      case '/api/inbox/poll':
        return handleInboxPoll(request, env);
      case '/api/profile/me':
        return handleProfileMe(request, env);
      case '/api/profile/nickname':
        return handleNicknameUpdate(request, env);
      case '/api/profile/encryption-key':
        return handleEncryptionKeyUpdate(request, env);
      case '/api/profile/lookup':
        return handleProfileLookup(request, url, env);
      case '/api/profile/by-key':
        return handleProfileByKey(request, url, env);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

async function handleNonceRequest(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const pubkey = url.searchParams.get('pubkey');
  if (!pubkey) {
    return errorResponse(env, 'Missing pubkey');
  }

  const data = await issueNonce(env.SOLINK_KV, pubkey);
  return jsonResponse(env, data);
}

async function handleVerifyRequest(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const body = await readJson(request);
  if (!body) {
    return errorResponse(env, 'Invalid JSON payload');
  }

  const { pubkey, nonce, signature } = body;
  if (!pubkey || !nonce || !signature) {
    return errorResponse(env, 'Missing fields');
  }

  const nonceRecord = await consumeNonce(env.SOLINK_KV, pubkey);
  if (!isNonceValid(nonceRecord, nonce)) {
    return errorResponse(env, 'Invalid or expired nonce', 401);
  }

  const isValidSignature = await verifyEd25519Signature(nonce, signature, pubkey);
  if (!isValidSignature) {
    return errorResponse(env, 'Invalid signature', 401);
  }

  const token = await createSession(env.SOLINK_KV, pubkey);
  return jsonResponse(env, {
    token,
    user: { pubkey },
  });
}

async function handleSendMessage(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const senderPubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!senderPubkey) {
    return errorResponse(env, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  if (!body) {
    return errorResponse(env, 'Invalid JSON payload');
  }

  const { to, text, timestamp, ciphertext, nonce, version } = body;
  if (!to || (!text && !ciphertext)) {
    return errorResponse(env, 'Missing fields');
  }

  const recipientPubkey = normalizePubkey(to);
  if (!recipientPubkey || !isValidPubkey(recipientPubkey)) {
    return errorResponse(env, 'Invalid recipient', 400);
  }

  if (recipientPubkey === senderPubkey) {
    return errorResponse(env, 'Cannot send messages to yourself');
  }

  const allowed = await checkAndIncrementRateLimit(env.SOLINK_KV, senderPubkey);
  if (!allowed) {
    return errorResponse(env, 'Rate limit exceeded', 429);
  }

  const senderProfile = await readProfile(env.SOLINK_KV, senderPubkey);
  const senderNickname = senderProfile?.nickname || null;
  const senderDisplayName = senderNickname ? `@${senderNickname}` : senderProfile?.displayName || null;

  const sanitizedText = text ? sanitizeMessageText(text) : '';
  const sanitizedCiphertext = typeof ciphertext === 'string' && ciphertext.length ? ciphertext : null;
  const sanitizedNonce = typeof nonce === 'string' && nonce.length ? nonce : null;
  if (sanitizedCiphertext && !sanitizedNonce) {
    return errorResponse(env, 'Missing nonce for encrypted message');
  }
  const encryptionVersion =
    Number.isFinite(version) && version > 0 ? Number(version) : sanitizedCiphertext ? 1 : null;

  const message = {
    id: crypto.randomUUID(),
    from: senderPubkey,
    to: recipientPubkey,
    text: sanitizedText,
    ciphertext: sanitizedCiphertext,
    nonce: sanitizedNonce,
    encryptionVersion,
    timestamp: Number.isFinite(timestamp) ? Number(timestamp) : Date.now(),
    senderNickname,
    senderDisplayName,
    expiresAt: Date.now() + INBOX_DELIVERY_TTL_MS,
  };

  try {
    await inboxStore(env, recipientPubkey, message);
  } catch (error) {
    console.error('Inbox store error', error);
    return errorResponse(env, error.message || 'Failed to enqueue message', 500);
  }
  return jsonResponse(env, { ok: true, messageId: message.id });
}

async function handleInboxPoll(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const pubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!pubkey) {
    return errorResponse(env, 'Unauthorized', 401);
  }

  const url = new URL(request.url);
  const waitParam = Number(url.searchParams.get('wait') || 0);
  const maxWaitMs = 15000;
  const waitMs = Math.max(0, Math.min(waitParam, maxWaitMs));
  const waitIntervalMs = 800;
  const start = Date.now();

  while (true) {
    let messages = [];
    try {
      messages = await inboxPull(env, pubkey, INBOX_PULL_LIMIT);
    } catch (error) {
      console.error('Inbox pull error', error);
      return errorResponse(env, error.message || 'Inbox fetch failed', 500);
    }
    if (messages.length || waitMs === 0 || Date.now() - start >= waitMs) {
      const normalizedMessages = messages.map((message) => ({
        ...message,
        from: normalizePubkey(message.from) || message.from,
        to: normalizePubkey(message.to) || pubkey,
      }));
      return jsonResponse(env, { messages: normalizedMessages });
    }
    const elapsed = Date.now() - start;
    const remaining = waitMs - elapsed;
    await sleep(Math.min(waitIntervalMs, remaining));
  }
}

async function handleAckMessages(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const pubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!pubkey) {
    return errorResponse(env, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id.length) : [];
  if (!ids.length) {
    return jsonResponse(env, { ok: true });
  }

  await inboxAck(env, pubkey, ids);
  return jsonResponse(env, { ok: true });
}

async function handleProfileMe(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const pubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!pubkey) {
    return errorResponse(env, 'Unauthorized', 401);
  }

  const profile = (await readProfile(env.SOLINK_KV, pubkey)) || createProfile(pubkey);
  return jsonResponse(env, { profile: sanitizeProfile(profile) });
}

async function handleNicknameUpdate(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const pubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!pubkey) {
    return errorResponse(env, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  const nicknameValue = body?.nickname;
  const normalized = normalizeNickname(nicknameValue);
  if (!normalized) {
    return errorResponse(env, 'Invalid nickname');
  }

  const existingProfile = await readProfile(env.SOLINK_KV, pubkey);
  const currentNickname = existingProfile?.nickname || null;

  if (currentNickname === normalized) {
    return jsonResponse(env, { profile: sanitizeProfile(existingProfile) });
  }

  const mappedPubkey = await env.SOLINK_KV.get(nicknameKey(normalized));
  if (mappedPubkey && mappedPubkey !== pubkey) {
    return errorResponse(env, 'Nickname already taken', 409);
  }

  if (currentNickname && currentNickname !== normalized) {
    await env.SOLINK_KV.delete(nicknameKey(currentNickname));
  }

  const now = Date.now();
  const profile = {
    ...(existingProfile || createProfile(pubkey)),
    pubkey,
    nickname: normalized,
    displayName: `@${normalized}`,
    updatedAt: now,
    createdAt: existingProfile?.createdAt || now,
  };

  await env.SOLINK_KV.put(profileKey(pubkey), JSON.stringify(profile));
  await env.SOLINK_KV.put(nicknameKey(normalized), pubkey);

  return jsonResponse(env, { profile: sanitizeProfile(profile) });
}

async function handleEncryptionKeyUpdate(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const pubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!pubkey) {
    return errorResponse(env, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  const publicKey = typeof body?.publicKey === 'string' ? body.publicKey.trim() : '';
  if (!publicKey || publicKey.length < 32) {
    return errorResponse(env, 'Invalid encryption key');
  }

  const existingProfile = (await readProfile(env.SOLINK_KV, pubkey)) || createProfile(pubkey);
  const now = Date.now();
  const profile = {
    ...existingProfile,
    pubkey,
    encryptionPublicKey: publicKey,
    updatedAt: now,
    createdAt: existingProfile?.createdAt || now,
  };

  await env.SOLINK_KV.put(profileKey(pubkey), JSON.stringify(profile));
  return jsonResponse(env, { profile: sanitizeProfile(profile) });
}

async function handleProfileLookup(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const nicknameParam = url.searchParams.get('nickname') || url.searchParams.get('nick');
  const normalized = normalizeNickname(nicknameParam);
  if (!normalized) {
    return errorResponse(env, 'Invalid nickname');
  }

  const mappedPubkey = await env.SOLINK_KV.get(nicknameKey(normalized));
  if (!mappedPubkey) {
    return errorResponse(env, 'Profile not found', 404);
  }

  const profile = (await readProfile(env.SOLINK_KV, mappedPubkey)) || {
    pubkey: mappedPubkey,
    nickname: normalized,
    displayName: `@${normalized}`,
  };

  return jsonResponse(env, { profile: sanitizeProfile(profile) });
}

async function handleProfileByKey(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const pubkeyParam = url.searchParams.get('pubkey') || url.searchParams.get('pk');
  const normalized = normalizePubkey(pubkeyParam);
  if (!normalized || !isValidPubkey(normalized)) {
    return errorResponse(env, 'Invalid pubkey', 400);
  }

  const profile = await readProfile(env.SOLINK_KV, normalized);
  if (!profile) {
    return errorResponse(env, 'Profile not found', 404);
  }

  return jsonResponse(env, { profile: sanitizeProfile(profile) });
}

function profileKey(pubkey) {
  return `${PROFILE_PREFIX}${pubkey}`;
}

function nicknameKey(nickname) {
  return `${NICKNAME_PREFIX}${nickname}`;
}

function normalizeNickname(value) {
  if (!value) return '';
  const trimmed = String(value).trim().replace(/^@+/, '').toLowerCase();
  if (!trimmed || !NICKNAME_REGEX.test(trimmed)) {
    return '';
  }
  return trimmed;
}

async function readProfile(kv, pubkey) {
  const raw = await kv.get(profileKey(pubkey));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createProfile(pubkey) {
  const now = Date.now();
  return {
    pubkey,
    nickname: null,
    displayName: null,
    avatarSeed: null,
    encryptionPublicKey: null,
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeProfile(profile) {
  if (!profile) return null;
  return {
    pubkey: profile.pubkey,
    nickname: profile.nickname || null,
    displayName: profile.nickname ? `@${profile.nickname}` : profile.displayName || null,
    avatarSeed: profile.avatarSeed || null,
    encryptionPublicKey: profile.encryptionPublicKey || null,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { InboxDurable };

