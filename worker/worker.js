import { verifyEd25519Signature, generateToken } from './utils/crypto';
import { issueNonce, consumeNonce, isNonceValid } from './utils/nonce';
import { checkAndIncrementRateLimit } from './utils/ratelimit';
import { InboxDurable, INBOX_DELIVERY_TTL_MS, MAX_BATCH } from './inbox-do';

const SESSION_PREFIX = 'session:';
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60; // 1 hour default
const MIN_SESSION_TTL_SECONDS = 15 * 60; // 15 minutes minimum
const MAX_SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours maximum
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

const DEFAULT_SOLANA_HTTP_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana',
];
const DEFAULT_SOLANA_WS_ENDPOINT = 'wss://api.mainnet-beta.solana.com';

function parseEndpointList(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function httpEndpoints(env) {
  const list = parseEndpointList(env.SOLANA_RPC_URL);
  return list.length ? list : DEFAULT_SOLANA_HTTP_ENDPOINTS;
}

function deriveWsUrl(value) {
  if (!value) return null;
  if (value.startsWith('wss://') || value.startsWith('ws://')) {
    return value;
  }
  if (value.startsWith('https://')) {
    return `wss://${value.slice(8)}`;
  }
  if (value.startsWith('http://')) {
    return `ws://${value.slice(7)}`;
  }
  return null;
}

function wsEndpoint(env) {
  const list = parseEndpointList(env.SOLANA_WS_RPC_URL);
  if (list.length) {
    const direct = deriveWsUrl(list[0]);
    if (direct) return direct;
  }
  const httpList = httpEndpoints(env);
  for (const endpoint of httpList) {
    const ws = deriveWsUrl(endpoint);
    if (ws) return ws;
  }
  return DEFAULT_SOLANA_WS_ENDPOINT;
}

async function handleSolanaProxy(request, env) {
  if (request.method !== 'POST') {
    return errorResponse(env, 'Method Not Allowed', 405);
  }

  const endpoints = httpEndpoints(env);

  let body;

  try {
    body = await request.text();
  } catch {
    return errorResponse(env, 'Invalid request body', 400);
  }

  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type':
            request.headers.get('Content-Type') || 'application/json',
          Accept: 'application/json',
        },
        body,
      });

      if (upstream.ok) {
        const headers = {
          ...buildCorsHeaders(env),
          'Cache-Control': 'no-store',
          'Content-Type':
            upstream.headers.get('Content-Type') ||
            'application/json;charset=UTF-8',
        };

        return new Response(upstream.body, {
          status: upstream.status,
          headers,
        });
      }

      const text = await upstream.text().catch(() => '');
      lastError = `RPC ${endpoint} responded with ${upstream.status} ${text}`;
      console.warn('Solana RPC proxy warning:', lastError);
    } catch (error) {
      lastError = `RPC ${endpoint} error: ${error.message}`;
      console.warn('Solana RPC proxy warning:', lastError);
    }
  }

  console.error('Solana RPC proxy failed:', lastError);
  return errorResponse(env, `Solana RPC proxy failed: ${lastError}`, 502);
}

function wsToHttp(urlString) {
  const url = new URL(urlString);
  if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  } else if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  }
  return url.toString();
}

async function handleSolanaWebSocketProxy(request, env) {
  const targetWs = wsEndpoint(env);
  if (!targetWs) {
    return new Response('Solana WS endpoint missing', { status: 502 });
  }

  const upstreamUrl = wsToHttp(targetWs);
  const upstreamRequest = new Request(upstreamUrl, request);
  return fetch(upstreamRequest);
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

async function createSession(kvNamespace, pubkey, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS) {
  // Clamp TTL to valid range
  const clampedTtl = Math.max(MIN_SESSION_TTL_SECONDS, Math.min(MAX_SESSION_TTL_SECONDS, ttlSeconds));
  const token = generateToken(24);
  await kvNamespace.put(sessionKey(token), JSON.stringify({ pubkey }), {
    expirationTtl: clampedTtl,
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

    const upgradeHeader = request.headers.get('Upgrade') || '';
    if (
      url.pathname === '/api/solana' &&
      upgradeHeader.toLowerCase() === 'websocket'
    ) {
      return handleSolanaWebSocketProxy(request, env);
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
      case '/api/solana':
        return handleSolanaProxy(request, env);
      case '/api/token/preview':
        return handleTokenPreview(request, url, env);
      case '/api/dex/preview':
        return handleDexPairPreview(request, url, env);
      case '/api/image-proxy':
        return handleImageProxy(request, url, env);
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

  const { pubkey, nonce, signature, sessionTtl } = body;
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

  // Use custom session TTL if provided, otherwise use default
  const ttlSeconds = typeof sessionTtl === 'number' && sessionTtl > 0 
    ? sessionTtl 
    : DEFAULT_SESSION_TTL_SECONDS;
  
  const token = await createSession(env.SOLINK_KV, pubkey, ttlSeconds);
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

  const { to, text, timestamp, ciphertext, nonce, version, tokenPreview } = body;
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

  // Sanitize token preview (limit size to prevent abuse)
  let sanitizedTokenPreview = null;
  if (tokenPreview && typeof tokenPreview === 'object') {
    sanitizedTokenPreview = {
      address: typeof tokenPreview.address === 'string' ? tokenPreview.address.slice(0, 50) : null,
      name: typeof tokenPreview.name === 'string' ? tokenPreview.name.slice(0, 100) : null,
      symbol: typeof tokenPreview.symbol === 'string' ? tokenPreview.symbol.slice(0, 20) : null,
      imageUrl: typeof tokenPreview.imageUrl === 'string' ? tokenPreview.imageUrl.slice(0, 500) : null,
      priceUsd: tokenPreview.priceUsd ?? null,
      priceChange24h: tokenPreview.priceChange24h ?? null,
      priceChange1h: tokenPreview.priceChange1h ?? null,
      priceChange5m: tokenPreview.priceChange5m ?? null,
      marketCap: tokenPreview.marketCap ?? null,
      liquidity: tokenPreview.liquidity ?? null,
      volume24h: tokenPreview.volume24h ?? null,
      txns24h: tokenPreview.txns24h ?? null,
      buys24h: tokenPreview.buys24h ?? null,
      sells24h: tokenPreview.sells24h ?? null,
      dexId: typeof tokenPreview.dexId === 'string' ? tokenPreview.dexId.slice(0, 50) : null,
      pairAddress: typeof tokenPreview.pairAddress === 'string' ? tokenPreview.pairAddress.slice(0, 50) : null,
      createdAt: tokenPreview.createdAt ?? null,
      bondingProgress: tokenPreview.bondingProgress ?? null,
      isComplete: Boolean(tokenPreview.isComplete),
      socials: Array.isArray(tokenPreview.socials) ? tokenPreview.socials.slice(0, 5).map(s => ({
        type: typeof s.type === 'string' ? s.type.slice(0, 20) : '',
        url: typeof s.url === 'string' ? s.url.slice(0, 200) : '',
      })).filter(s => s.type && s.url) : null,
    };
  }

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
    senderEncryptionKey: senderProfile?.encryptionPublicKey || null,
    tokenPreview: sanitizedTokenPreview,
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

// Token preview for pump.fun links
const PUMP_FUN_API = 'https://frontend-api.pump.fun'; // v2 API (no auth needed)
const DEXSCREENER_API = 'https://api.dexscreener.com/tokens/v1/solana';
const HELIUS_METADATA_API = 'https://api.helius.xyz/v0/token-metadata';

async function handleTokenPreview(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const tokenAddress = url.searchParams.get('address');
  if (!tokenAddress || !BASE58_REGEX.test(tokenAddress)) {
    return errorResponse(env, 'Invalid token address');
  }

  try {
    // Extract Helius API key from RPC URL
    const heliusApiKey = env.SOLANA_RPC_URL?.match(/api-key=([^&]+)/)?.[1] || null;

    // Fetch from all APIs in parallel
    const [pumpResponse, dexResponse, heliusResponse] = await Promise.allSettled([
      fetch(`${PUMP_FUN_API}/coins/${tokenAddress}`, {
        headers: { 
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin': 'https://pump.fun',
          'Referer': 'https://pump.fun/'
        }
      }),
      fetch(`${DEXSCREENER_API}/${tokenAddress}`, {
        headers: { 'Accept': 'application/json' }
      }),
      // Helius token metadata API
      heliusApiKey ? fetch(`${HELIUS_METADATA_API}?api-key=${heliusApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mintAccounts: [tokenAddress],
          includeOffChain: true,
          disableCache: false
        })
      }) : Promise.resolve(null)
    ]);

    let pumpData = null;
    let dexData = null;
    let heliusData = null;
    
    // Debug info
    const debugInfo = {
      pumpStatus: pumpResponse.status,
      pumpOk: pumpResponse.status === 'fulfilled' ? pumpResponse.value?.ok : false,
      dexStatus: dexResponse.status,
      dexOk: dexResponse.status === 'fulfilled' ? dexResponse.value?.ok : false,
      heliusStatus: heliusResponse.status,
      heliusOk: heliusResponse.status === 'fulfilled' ? heliusResponse.value?.ok : false,
    };

    // Parse pump.fun response
    if (pumpResponse.status === 'fulfilled' && pumpResponse.value.ok) {
      try {
        pumpData = await pumpResponse.value.json();
        debugInfo.pumpHasImage = !!pumpData?.image_uri;
      } catch (e) {
        debugInfo.pumpError = e.message;
      }
    }

    // Parse DexScreener response (new v1 API returns array directly)
    if (dexResponse.status === 'fulfilled' && dexResponse.value.ok) {
      try {
        const dexJson = await dexResponse.value.json();
        // DexScreener v1 API returns array of pairs directly
        const pairs = Array.isArray(dexJson) ? dexJson : (dexJson.pairs || []);
        if (pairs.length > 0) {
          // Sort by liquidity and take the best pair
          dexData = pairs.sort((a, b) => 
            (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
          )[0];
          debugInfo.dexHasImage = !!dexData?.info?.imageUrl;
        }
      } catch (e) {
        debugInfo.dexError = e.message;
      }
    }

    // Parse Helius response
    if (heliusResponse.status === 'fulfilled' && heliusResponse.value?.ok) {
      try {
        const heliusJson = await heliusResponse.value.json();
        if (Array.isArray(heliusJson) && heliusJson.length > 0) {
          heliusData = heliusJson[0];
          debugInfo.heliusHasOffChainImage = !!heliusData?.offChainMetadata?.metadata?.image;
          debugInfo.heliusHasOnChainImage = !!heliusData?.onChainMetadata?.metadata?.image;
        }
      } catch (e) {
        debugInfo.heliusError = e.message;
      }
    }
    
    console.log('Token preview debug:', tokenAddress, JSON.stringify(debugInfo));

    // If we have no data at all, return error
    if (!pumpData && !dexData && !heliusData) {
      return errorResponse(env, 'Token not found', 404);
    }

    // Build unified preview object
    // Try multiple image sources with logging
    const imageSources = {
      heliusOffChain: heliusData?.offChainMetadata?.metadata?.image,
      heliusOnChain: heliusData?.onChainMetadata?.metadata?.image,
      heliusLegacyUri: heliusData?.legacyMetadata?.logoURI,
      dexScreener: dexData?.info?.imageUrl,
      pumpFun: pumpData?.image_uri,
    };
    
    console.log('Image sources for token:', tokenAddress, JSON.stringify(imageSources));
    
    const imageUrl = 
      imageSources.heliusOffChain ||
      imageSources.heliusOnChain ||
      imageSources.heliusLegacyUri ||
      imageSources.dexScreener || 
      imageSources.pumpFun || 
      null;

    // Calculate transactions
    const txns24h = dexData?.txns?.h24 
      ? (dexData.txns.h24.buys || 0) + (dexData.txns.h24.sells || 0) 
      : null;
    const buys24h = dexData?.txns?.h24?.buys || null;
    const sells24h = dexData?.txns?.h24?.sells || null;

    // Get socials/links
    const socials = [];
    
    // DexScreener socials - has url and type fields
    if (dexData?.info?.socials && Array.isArray(dexData.info.socials)) {
      for (const s of dexData.info.socials) {
        if (s.url && s.type) {
          // DexScreener returns full URLs
          let url = s.url;
          let type = s.type.toLowerCase();
          // Normalize twitter to x
          if (type === 'twitter' && url.includes('twitter.com')) {
            url = url.replace('twitter.com', 'x.com');
          }
          socials.push({ type, url });
        }
      }
    }
    
    // DexScreener websites
    if (dexData?.info?.websites && Array.isArray(dexData.info.websites)) {
      for (const w of dexData.info.websites) {
        if (w.url) socials.push({ type: 'website', url: w.url });
      }
    }
    
    console.log('DexScreener socials raw:', JSON.stringify(dexData?.info?.socials));
    console.log('DexScreener websites raw:', JSON.stringify(dexData?.info?.websites));
    console.log('Parsed socials:', JSON.stringify(socials));
    
    // Pump.fun socials (fallback)
    if (pumpData?.twitter) {
      const tw = pumpData.twitter;
      const twUrl = tw.startsWith('http') ? tw.replace('twitter.com', 'x.com') : `https://x.com/${tw.replace('@', '')}`;
      socials.push({ type: 'twitter', url: twUrl });
    }
    if (pumpData?.telegram) {
      const tg = pumpData.telegram;
      const tgUrl = tg.startsWith('http') ? tg : `https://t.me/${tg.replace('@', '')}`;
      socials.push({ type: 'telegram', url: tgUrl });
    }
    if (pumpData?.website) socials.push({ type: 'website', url: pumpData.website });
    
    // Try Helius metadata for socials
    const heliusMeta = heliusData?.offChainMetadata?.metadata;
    if (heliusMeta?.external_url && !socials.some(s => s.type === 'website')) {
      socials.push({ type: 'website', url: heliusMeta.external_url });
    }
    // Check properties for socials
    const props = heliusMeta?.properties;
    if (props) {
      if (props.twitter && !socials.some(s => s.type === 'twitter')) {
        const tw = props.twitter;
        socials.push({ type: 'twitter', url: tw.startsWith('http') ? tw : `https://x.com/${tw.replace('@', '')}` });
      }
      if (props.telegram && !socials.some(s => s.type === 'telegram')) {
        const tg = props.telegram;
        socials.push({ type: 'telegram', url: tg.startsWith('http') ? tg : `https://t.me/${tg.replace('@', '')}` });
      }
      if (props.discord && !socials.some(s => s.type === 'discord')) {
        socials.push({ type: 'discord', url: props.discord });
      }
    }

    const preview = {
      address: tokenAddress,
      name: pumpData?.name || heliusData?.offChainMetadata?.metadata?.name || dexData?.baseToken?.name || 'Unknown',
      symbol: pumpData?.symbol || heliusData?.offChainMetadata?.metadata?.symbol || dexData?.baseToken?.symbol || '???',
      imageUrl,
      description: pumpData?.description ? pumpData.description.slice(0, 200) : (heliusData?.offChainMetadata?.metadata?.description?.slice(0, 200) || null),
      
      // Price data (prefer DexScreener for accuracy)
      priceUsd: dexData?.priceUsd || null,
      priceChange24h: dexData?.priceChange?.h24 || null,
      priceChange1h: dexData?.priceChange?.h1 || null,
      priceChange5m: dexData?.priceChange?.m5 || null,
      
      // Market data
      marketCap: dexData?.marketCap || dexData?.fdv || pumpData?.market_cap || null,
      liquidity: dexData?.liquidity?.usd || null,
      volume24h: dexData?.volume?.h24 || null,
      volume1h: dexData?.volume?.h1 || null,
      
      // Transactions
      txns24h,
      buys24h,
      sells24h,
      
      // DEX info
      dexId: dexData?.dexId || (pumpData ? 'pumpfun' : null),
      pairAddress: dexData?.pairAddress || null,
      
      // Pump.fun specific
      bondingProgress: pumpData?.bonding_curve_progress || null,
      isComplete: pumpData?.complete || false,
      
      // Social links
      socials: socials.length > 0 ? socials : null,
      
      // Metadata
      createdAt: dexData?.pairCreatedAt || pumpData?.created_timestamp || null,
      fetchedAt: Date.now(),
    };

    return jsonResponse(env, { preview });
  } catch (error) {
    console.error('Token preview error:', error);
    return errorResponse(env, 'Failed to fetch token data', 500);
  }
}

// DexScreener pair preview (by pair address)
const DEXSCREENER_PAIRS_API = 'https://api.dexscreener.com/latest/dex/pairs/solana';

async function handleDexPairPreview(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const pairAddress = url.searchParams.get('pair');
  if (!pairAddress || pairAddress.length < 30 || pairAddress.length > 50) {
    return errorResponse(env, 'Invalid pair address');
  }

  try {
    // Fetch from DexScreener pairs API
    const dexResponse = await fetch(`${DEXSCREENER_PAIRS_API}/${pairAddress}`, {
      headers: { 'User-Agent': 'SOLink/1.0' },
    });

    if (!dexResponse.ok) {
      return errorResponse(env, 'Pair not found', 404);
    }

    const dexData = await dexResponse.json();
    const pair = dexData.pair || dexData.pairs?.[0];
    
    if (!pair) {
      return errorResponse(env, 'Pair not found', 404);
    }

    // Extract token info from pair
    const baseToken = pair.baseToken || {};
    const quoteToken = pair.quoteToken || {};
    
    // Get social links
    const socials = [];
    if (pair.info?.socials) {
      pair.info.socials.forEach(s => {
        if (s.url && s.type) {
          let socialType = s.type.toLowerCase();
          let socialUrl = s.url;
          // Convert twitter to x.com
          if (socialType === 'twitter') {
            socialType = 'x';
            if (!socialUrl.includes('x.com')) {
              socialUrl = socialUrl.replace('twitter.com', 'x.com');
            }
          }
          socials.push({ type: socialType, url: socialUrl });
        }
      });
    }
    if (pair.info?.websites?.length) {
      pair.info.websites.forEach(w => {
        if (w.url) {
          socials.push({ type: 'website', url: w.url });
        }
      });
    }

    // Build preview response
    const preview = {
      address: baseToken.address || pairAddress,
      name: baseToken.name || 'Unknown',
      symbol: baseToken.symbol || '???',
      imageUrl: pair.info?.imageUrl || null,
      priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
      priceChange24h: pair.priceChange?.h24 ?? null,
      priceChange1h: pair.priceChange?.h1 ?? null,
      priceChange5m: pair.priceChange?.m5 ?? null,
      marketCap: pair.marketCap || pair.fdv || null,
      liquidity: pair.liquidity?.usd || null,
      volume24h: pair.volume?.h24 || null,
      txns24h: pair.txns?.h24 ? (pair.txns.h24.buys || 0) + (pair.txns.h24.sells || 0) : null,
      buys24h: pair.txns?.h24?.buys || null,
      sells24h: pair.txns?.h24?.sells || null,
      dexId: pair.dexId || null,
      pairAddress: pair.pairAddress || pairAddress,
      createdAt: pair.pairCreatedAt || null,
      bondingProgress: null, // Not applicable for DEX pairs
      isComplete: true, // DEX pairs are already graduated
      socials: socials.length > 0 ? socials : null,
    };

    return jsonResponse(env, preview);
  } catch (error) {
    console.error('DexScreener pair preview error:', error);
    return errorResponse(env, 'Failed to fetch pair data', 500);
  }
}

// Image proxy to bypass CORS restrictions
async function handleImageProxy(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) {
    return errorResponse(env, 'Missing url parameter');
  }

  // Only allow certain domains for security
  const allowedDomains = [
    'cdn.dexscreener.com',
    'pump.mypinata.cloud',
    'ipfs.io',
    'arweave.net',
    'cf-ipfs.com',
    'nftstorage.link',
    'gateway.pinata.cloud',
  ];

  try {
    const parsedUrl = new URL(imageUrl);
    const isAllowed = allowedDomains.some(domain => parsedUrl.hostname.endsWith(domain));
    
    if (!isAllowed) {
      return errorResponse(env, 'Domain not allowed', 403);
    }

    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'SOLink/1.0',
        'Accept': 'image/*',
      },
    });

    if (!response.ok) {
      return new Response('Image not found', { status: 404 });
    }

    const contentType = response.headers.get('Content-Type') || 'image/png';
    const imageData = await response.arrayBuffer();

    return new Response(imageData, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
        ...buildCorsHeaders(env),
      },
    });
  } catch (error) {
    console.error('Image proxy error:', error);
    return errorResponse(env, 'Failed to fetch image', 500);
  }
}

export { InboxDurable };

