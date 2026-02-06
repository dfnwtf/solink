import { verifyEd25519Signature, generateToken } from './utils/crypto';
import { issueNonce, consumeNonce, isNonceValid } from './utils/nonce';
import { checkAndIncrementRateLimit } from './utils/ratelimit';
import { InboxDurable, INBOX_DELIVERY_TTL_MS, MAX_BATCH } from './inbox-do';
import { logEvent, Category, EventType } from './utils/logger';

const SESSION_PREFIX = 'session:';
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60; // 1 hour default
const MIN_SESSION_TTL_SECONDS = 15 * 60; // 15 minutes minimum
const MAX_SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours maximum
const MAX_MESSAGE_LENGTH = 1024;
const MAX_VOICE_SIZE = 2 * 1024 * 1024; // 2MB max
const MAX_VOICE_DURATION_SEC = 120; // 2 minutes
const VOICE_PREFIX = 'voice/';

// CORS: Allowed origins for security
const ALLOWED_ORIGINS = [
  'https://solink.chat',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:8080',
];

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROFILE_PREFIX = 'profile:';
const NICKNAME_PREFIX = 'nickname:';
const NICKNAME_REGEX = /^[a-z][a-z0-9_]{2,15}$/;
const NICKNAME_BLOCKLIST = new Set([
  // Administrative
  "admin", "administrator", "mod", "moderator", "support", "help", "official",
  "staff", "team", "owner", "founder", "ceo", "cto", "dev", "developer",
  // Brand - SOLink
  "solink", "so_link", "solink_official", "solink_support", "solink_team",
  "solink_admin", "solinkapp", "solinkchat",
  // Brand - Solana ecosystem
  "solana", "phantom", "jupiter", "raydium", "orca", "marinade", "magic_eden",
  "magiceden", "tensor", "jito", "pyth", "serum", "mango", "drift", "kamino",
  "helium", "render", "bonk", "wif", "popcat", "samo",
  // Crypto exchanges & wallets
  "binance", "coinbase", "kraken", "okx", "bybit", "kucoin", "bitget", "mexc",
  "gateio", "huobi", "ftx", "gemini", "bitstamp", "metamask", "trustwallet",
  "ledger", "trezor", "exodus", "backpack",
  // System & technical
  "system", "bot", "root", "null", "undefined", "api", "server", "database",
  "console", "error", "test", "debug", "config", "settings",
  // Security & auth
  "security", "secure", "verify", "verified", "verification", "auth", "login",
  "password", "authenticate", "2fa", "mfa",
  // Scam keywords
  "giveaway", "airdrop", "claim", "free", "bonus", "prize", "winner", "reward",
  "promo", "promotion", "discount", "offer", "limited", "urgent", "act_now",
  "double", "triple", "multiply", "profit", "guaranteed", "investment",
  // Financial
  "bank", "wallet_support", "exchange", "transfer", "payment", "withdraw",
  "deposit", "refund", "recovery", "restore",
  // Impersonation patterns
  "customer_service", "customerservice", "tech_support", "techsupport",
  "helpdesk", "help_desk", "live_support", "livesupport",
]);
const INBOX_PULL_LIMIT = MAX_BATCH;
const NICKNAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sessionKey(token) {
  return `${SESSION_PREFIX}${token}`;
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow any localhost/127.0.0.1 port for development
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
    return true;
  }
  return false;
}

function buildCorsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '';
  const allowedOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(request, data, init = {}) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Cache-Control': 'no-store',
    ...buildCorsHeaders(request),
    ...(init.headers || {}),
  };

  return new Response(JSON.stringify(data), { ...init, headers });
}

function errorResponse(request, message, status = 400) {
  return jsonResponse(request, { error: message }, { status });
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
  const startTime = Date.now();
  
  if (request.method !== 'POST') {
    return errorResponse(request, 'Method Not Allowed', 405);
  }

  const endpoints = httpEndpoints(env);

  let body;
  let rpcMethod = 'unknown';

  try {
    body = await request.text();
    // Try to extract RPC method name
    try {
      const parsed = JSON.parse(body);
      rpcMethod = parsed.method || 'unknown';
    } catch {}
  } catch {
    return errorResponse(request, 'Invalid request body', 400);
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
          ...buildCorsHeaders(request),
          'Cache-Control': 'no-store',
          'Content-Type':
            upstream.headers.get('Content-Type') ||
            'application/json;charset=UTF-8',
        };

        logEvent(env, { type: EventType.INFO, category: Category.SOLANA, action: rpcMethod, status: 200, latency: Date.now() - startTime });
        
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
  logEvent(env, { type: EventType.ERROR, category: Category.SOLANA, action: rpcMethod, details: 'all endpoints failed', status: 502, latency: Date.now() - startTime });
  return errorResponse(request, `Solana RPC proxy failed: ${lastError}`, 502);
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
          ...buildCorsHeaders(request),
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
      case '/api/link-preview':
        return handleLinkPreview(request, url, env);
      case '/api/push/subscribe':
        return handlePushSubscribe(request, env);
      case '/api/push/unsubscribe':
        return handlePushUnsubscribe(request, env);
      case '/api/sync/backup':
        return handleSyncBackup(request, env);
      case '/api/sync/chats':
        return handleSyncChatsList(request, env);
      case '/api/voice/upload':
        return handleVoiceUpload(request, env);
      case '/api/voice/delete':
        return handleVoiceDelete(request, url, env);
      case '/api/voice':
        return handleVoiceDownload(request, url, env);
      // Dev Console API
      case '/api/dev/login':
        return handleDevLogin(request, env);
      case '/api/dev/stats':
        return handleDevStats(request, env);
      case '/api/dev/events':
        return handleDevEvents(request, url, env);
      default:
        // Handle dynamic routes like /api/sync/chat/:contactKey
        if (url.pathname.startsWith('/api/sync/chat/')) {
          return handleSyncChat(request, url, env);
        }
        // Handle dynamic route for /api/voice/:id
        if (url.pathname.startsWith('/api/voice/')) {
          return handleVoiceDownload(request, url, env);
        }
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
    return errorResponse(request, 'Missing pubkey');
  }

  const data = await issueNonce(env.SOLINK_KV, pubkey);
  return jsonResponse(request, data);
}

async function handleVerifyRequest(request, env) {
  const startTime = Date.now();
  
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const body = await readJson(request);
  if (!body) {
    logEvent(env, { type: EventType.ERROR, category: Category.AUTH, action: 'verify', details: 'invalid json', status: 400 });
    return errorResponse(request, 'Invalid JSON payload');
  }

  const { pubkey, nonce, signature, sessionTtl } = body;
  if (!pubkey || !nonce || !signature) {
    logEvent(env, { type: EventType.ERROR, category: Category.AUTH, action: 'verify', details: 'missing fields', status: 400 });
    return errorResponse(request, 'Missing fields');
  }

  const nonceRecord = await consumeNonce(env.SOLINK_KV, pubkey);
  if (!isNonceValid(nonceRecord, nonce)) {
    logEvent(env, { type: EventType.WARN, category: Category.AUTH, action: 'verify', wallet: pubkey, details: 'invalid nonce', status: 401 });
    return errorResponse(request, 'Invalid or expired nonce', 401);
  }

  const isValidSignature = await verifyEd25519Signature(nonce, signature, pubkey);
  if (!isValidSignature) {
    logEvent(env, { type: EventType.WARN, category: Category.AUTH, action: 'verify', wallet: pubkey, details: 'invalid signature', status: 401 });
    return errorResponse(request, 'Invalid signature', 401);
  }

  // Use custom session TTL if provided, otherwise use default
  const ttlSeconds = typeof sessionTtl === 'number' && sessionTtl > 0 
    ? sessionTtl 
    : DEFAULT_SESSION_TTL_SECONDS;
  
  const token = await createSession(env.SOLINK_KV, pubkey, ttlSeconds);
  
  logEvent(env, { type: EventType.INFO, category: Category.AUTH, action: 'verify', wallet: pubkey, latency: Date.now() - startTime, status: 200 });
  
  return jsonResponse(request, {
    token,
    user: { pubkey },
  });
}

async function handleSendMessage(request, env) {
  const startTime = Date.now();
  
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const senderPubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!senderPubkey) {
    logEvent(env, { type: EventType.WARN, category: Category.MESSAGE, action: 'send', details: 'unauthorized', status: 401 });
    return errorResponse(request, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  if (!body) {
    logEvent(env, { type: EventType.ERROR, category: Category.MESSAGE, action: 'send', wallet: senderPubkey, details: 'invalid json', status: 400 });
    return errorResponse(request, 'Invalid JSON payload');
  }

  const { to, text, timestamp, ciphertext, nonce, version, tokenPreview, senderEncryptionKey: clientSenderKey, voiceKey, voiceDuration, voiceNonce, voiceMimeType, voiceWaveform } = body;
  if (!to || (!text && !ciphertext && !voiceKey)) {
    logEvent(env, { type: EventType.ERROR, category: Category.MESSAGE, action: 'send', wallet: senderPubkey, details: 'missing fields', status: 400 });
    return errorResponse(request, 'Missing fields');
  }

  const recipientPubkey = normalizePubkey(to);
  if (!recipientPubkey || !isValidPubkey(recipientPubkey)) {
    logEvent(env, { type: EventType.ERROR, category: Category.MESSAGE, action: 'send', wallet: senderPubkey, details: 'invalid recipient', status: 400 });
    return errorResponse(request, 'Invalid recipient', 400);
  }

  if (recipientPubkey === senderPubkey) {
    logEvent(env, { type: EventType.WARN, category: Category.MESSAGE, action: 'send', wallet: senderPubkey, details: 'self-send attempt', status: 400 });
    return errorResponse(request, 'Cannot send messages to yourself');
  }

  const allowed = await checkAndIncrementRateLimit(env.SOLINK_KV, senderPubkey);
  if (!allowed) {
    logEvent(env, { type: EventType.WARN, category: Category.MESSAGE, action: 'send', wallet: senderPubkey, details: 'rate limited', status: 429 });
    return errorResponse(request, 'Rate limit exceeded', 429);
  }

  const senderProfile = await readProfile(env.SOLINK_KV, senderPubkey);
  const senderNickname = senderProfile?.nickname || null;
  const senderDisplayName = senderNickname ? `@${senderNickname}` : senderProfile?.displayName || null;

  const sanitizedText = text ? sanitizeMessageText(text) : '';
  const sanitizedCiphertext = typeof ciphertext === 'string' && ciphertext.length ? ciphertext : null;
  const sanitizedNonce = typeof nonce === 'string' && nonce.length ? nonce : null;
  if (sanitizedCiphertext && !sanitizedNonce) {
    return errorResponse(request, 'Missing nonce for encrypted message');
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
    // Prioritize client-provided key (always fresh) over profile key (may be stale due to KV eventual consistency)
    senderEncryptionKey: clientSenderKey || senderProfile?.encryptionPublicKey || null,
    tokenPreview: sanitizedTokenPreview,
    // Voice message fields
    voiceKey: voiceKey || null,
    voiceDuration: Number.isFinite(voiceDuration) ? voiceDuration : null,
    voiceNonce: voiceNonce || null,
    voiceMimeType: voiceMimeType || null,
    voiceWaveform: voiceWaveform || null,
    expiresAt: Date.now() + INBOX_DELIVERY_TTL_MS,
  };

  try {
    await inboxStore(env, recipientPubkey, message);
    
    // Send push notification to recipient
    console.log(`[Push] Attempting to send push to ${recipientPubkey}`);
    const pushBody = voiceKey ? '🎤 Voice message' : 'New message';
    try {
      await sendPushNotification(env, recipientPubkey, {
        title: senderDisplayName || senderNickname || shortenPubkey(senderPubkey),
        body: pushBody,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag: `solink-${senderPubkey}`,
        data: {
          sender: senderPubkey,
          url: `/app?chat=${senderPubkey}`
        }
      });
      console.log(`[Push] Push notification completed`);
    } catch (pushErr) {
      console.error('[Push] Notification error:', pushErr.message || pushErr);
    }
    
  } catch (error) {
    console.error('Inbox store error', error);
    logEvent(env, { type: EventType.ERROR, category: Category.MESSAGE, action: 'send', wallet: senderPubkey, details: error.message, status: 500, latency: Date.now() - startTime });
    return errorResponse(request, error.message || 'Failed to enqueue message', 500);
  }
  
  const msgType = voiceKey ? 'voice' : (ciphertext ? 'encrypted' : 'text');
  logEvent(env, { type: EventType.INFO, category: Category.MESSAGE, action: 'send', wallet: senderPubkey, details: msgType, status: 200, latency: Date.now() - startTime });
  
  return jsonResponse(request, { ok: true, messageId: message.id });
}

function shortenPubkey(pubkey) {
  if (!pubkey || pubkey.length < 10) return pubkey || '';
  return pubkey.slice(0, 4) + '...' + pubkey.slice(-4);
}

async function handleInboxPoll(request, env) {
  const startTime = Date.now();
  
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const pubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!pubkey) {
    return errorResponse(request, 'Unauthorized', 401);
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
      logEvent(env, { type: EventType.ERROR, category: Category.MESSAGE, action: 'poll', wallet: pubkey, details: error.message, status: 500 });
      return errorResponse(request, error.message || 'Inbox fetch failed', 500);
    }
    if (messages.length || waitMs === 0 || Date.now() - start >= waitMs) {
      const normalizedMessages = messages.map((message) => ({
        ...message,
        from: normalizePubkey(message.from) || message.from,
        to: normalizePubkey(message.to) || pubkey,
      }));
      
      // Only log if messages received (to reduce noise)
      if (messages.length > 0) {
        logEvent(env, { type: EventType.INFO, category: Category.MESSAGE, action: 'poll', wallet: pubkey, details: `${messages.length} msgs`, status: 200, latency: Date.now() - startTime });
      }
      
      return jsonResponse(request, { messages: normalizedMessages });
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
    return errorResponse(request, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id.length) : [];
  if (!ids.length) {
    return jsonResponse(request, { ok: true });
  }

  await inboxAck(env, pubkey, ids);
  return jsonResponse(request, { ok: true });
}

async function handleProfileMe(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const pubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!pubkey) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  const profile = (await readProfile(env.SOLINK_KV, pubkey)) || createProfile(pubkey);
  return jsonResponse(request, { profile: sanitizeProfile(profile) });
}

async function handleNicknameUpdate(request, env) {
  const startTime = Date.now();
  
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const pubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!pubkey) {
    logEvent(env, { type: EventType.WARN, category: Category.PROFILE, action: 'nickname', details: 'unauthorized', status: 401 });
    return errorResponse(request, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  const nicknameValue = body?.nickname;
  const normalized = normalizeNickname(nicknameValue);
  if (!normalized) {
    return errorResponse(request, 'Invalid nickname');
  }

  const existingProfile = await readProfile(env.SOLINK_KV, pubkey);
  const currentNickname = existingProfile?.nickname || null;

  if (currentNickname === normalized) {
    return jsonResponse(request, { profile: sanitizeProfile(existingProfile) });
  }

  // Check nickname change cooldown (only if user already has a nickname)
  if (currentNickname) {
    const lastChange = existingProfile?.nicknameChangedAt || 0;
    const now = Date.now();
    const timeSinceLastChange = now - lastChange;
    
    if (timeSinceLastChange < NICKNAME_CHANGE_COOLDOWN_MS) {
      const remainingMs = NICKNAME_CHANGE_COOLDOWN_MS - timeSinceLastChange;
      const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
      return errorResponse(request, `Nickname can only be changed once every 7 days. Try again in ${remainingDays} day(s).`, 429);
    }
  }

  const mappedPubkey = await env.SOLINK_KV.get(nicknameKey(normalized));
  if (mappedPubkey && mappedPubkey !== pubkey) {
    return errorResponse(request, 'Nickname already taken', 409);
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
    nicknameChangedAt: now,
    updatedAt: now,
    createdAt: existingProfile?.createdAt || now,
  };

  await env.SOLINK_KV.put(profileKey(pubkey), JSON.stringify(profile));
  await env.SOLINK_KV.put(nicknameKey(normalized), pubkey);

  logEvent(env, { type: EventType.INFO, category: Category.PROFILE, action: 'nickname', wallet: pubkey, details: `@${normalized}`, status: 200, latency: Date.now() - startTime });
  
  return jsonResponse(request, { profile: sanitizeProfile(profile) });
}

async function handleEncryptionKeyUpdate(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const pubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!pubkey) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  const publicKey = typeof body?.publicKey === 'string' ? body.publicKey.trim() : '';
  if (!publicKey || publicKey.length < 32) {
    return errorResponse(request, 'Invalid encryption key');
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
  return jsonResponse(request, { profile: sanitizeProfile(profile) });
}

async function handleProfileLookup(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const nicknameParam = url.searchParams.get('nickname') || url.searchParams.get('nick');
  const normalized = normalizeNickname(nicknameParam);
  if (!normalized) {
    return errorResponse(request, 'Invalid nickname');
  }

  const mappedPubkey = await env.SOLINK_KV.get(nicknameKey(normalized));
  if (!mappedPubkey) {
    return errorResponse(request, 'Profile not found', 404);
  }

  const profile = (await readProfile(env.SOLINK_KV, mappedPubkey)) || {
    pubkey: mappedPubkey,
    nickname: normalized,
    displayName: `@${normalized}`,
  };

  return jsonResponse(request, { profile: sanitizeProfile(profile) });
}

async function handleProfileByKey(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const pubkeyParam = url.searchParams.get('pubkey') || url.searchParams.get('pk');
  const normalized = normalizePubkey(pubkeyParam);
  if (!normalized || !isValidPubkey(normalized)) {
    return errorResponse(request, 'Invalid pubkey', 400);
  }

  const profile = await readProfile(env.SOLINK_KV, normalized);
  if (!profile) {
    return errorResponse(request, 'Profile not found', 404);
  }

  return jsonResponse(request, { profile: sanitizeProfile(profile) });
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
  // Check blocklist
  if (NICKNAME_BLOCKLIST.has(trimmed)) {
    return '';
  }
  // Check for blocklist partial matches
  for (const blocked of NICKNAME_BLOCKLIST) {
    if (trimmed.includes(blocked) || blocked.includes(trimmed)) {
      return '';
    }
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
    nicknameChangedAt: profile.nicknameChangedAt || null,
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
    return errorResponse(request, 'Invalid token address');
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
      return errorResponse(request, 'Token not found', 404);
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

    return jsonResponse(request, { preview });
  } catch (error) {
    console.error('Token preview error:', error);
    return errorResponse(request, 'Failed to fetch token data', 500);
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
    return errorResponse(request, 'Invalid pair address');
  }

  try {
    // Fetch from DexScreener pairs API
    const dexResponse = await fetch(`${DEXSCREENER_PAIRS_API}/${pairAddress}`, {
      headers: { 'User-Agent': 'SOLink/1.0' },
    });

    if (!dexResponse.ok) {
      return errorResponse(request, 'Pair not found', 404);
    }

    const dexData = await dexResponse.json();
    const pair = dexData.pair || dexData.pairs?.[0];
    
    if (!pair) {
      return errorResponse(request, 'Pair not found', 404);
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

    return jsonResponse(request, preview);
  } catch (error) {
    console.error('DexScreener pair preview error:', error);
    return errorResponse(request, 'Failed to fetch pair data', 500);
  }
}

// Link preview - fetch Open Graph metadata from URLs
async function handleLinkPreview(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return errorResponse(request, 'Missing url parameter');
  }

  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return errorResponse(request, 'Invalid URL protocol');
    }
  } catch {
    return errorResponse(request, 'Invalid URL');
  }

  // Block internal/localhost URLs
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.startsWith('127.') || hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname === '0.0.0.0') {
    return errorResponse(request, 'Internal URLs not allowed', 403);
  }

  try {
    // Fetch the page with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'SOLink/1.0 (Link Preview Bot)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return errorResponse(request, 'Failed to fetch URL', response.status);
    }

    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return errorResponse(request, 'URL is not an HTML page');
    }

    // Limit response size (first 100KB should be enough for meta tags)
    const text = await response.text();
    const html = text.slice(0, 100000);

    // Parse Open Graph and meta tags
    const preview = parseOpenGraphTags(html, parsedUrl);

    // Add cache headers
    return jsonResponse(request, preview, {
      headers: {
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      },
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      return errorResponse(request, 'Request timeout', 504);
    }
    console.error('Link preview error:', error);
    return errorResponse(request, 'Failed to fetch link preview', 500);
  }
}

// Parse Open Graph meta tags from HTML
function parseOpenGraphTags(html, url) {
  const getMetaContent = (property) => {
    // Try og: tags first
    const ogMatch = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']og:${property}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:${property}["']`, 'i'));
    if (ogMatch) return ogMatch[1];

    // Try twitter: tags
    const twitterMatch = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']twitter:${property}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']twitter:${property}["']`, 'i'));
    if (twitterMatch) return twitterMatch[1];

    // Try standard meta tags
    const metaMatch = html.match(new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i'));
    if (metaMatch) return metaMatch[1];

    return null;
  };

  // Get title
  let title = getMetaContent('title');
  if (!title) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    title = titleMatch ? titleMatch[1].trim() : null;
  }

  // Get description
  const description = getMetaContent('description');

  // Get image
  let image = getMetaContent('image');
  if (image && !image.startsWith('http')) {
    // Convert relative URL to absolute
    try {
      image = new URL(image, url.origin).href;
    } catch {
      image = null;
    }
  }

  // Get site name
  let siteName = getMetaContent('site_name');
  if (!siteName) {
    siteName = url.hostname.replace(/^www\./, '');
  }

  // Get favicon
  let favicon = null;
  const faviconMatch = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
  if (faviconMatch) {
    favicon = faviconMatch[1];
    if (!favicon.startsWith('http')) {
      try {
        favicon = new URL(favicon, url.origin).href;
      } catch {
        favicon = null;
      }
    }
  }
  if (!favicon) {
    favicon = `${url.origin}/favicon.ico`;
  }

  return {
    url: url.href,
    title: title ? decodeHtmlEntities(title).slice(0, 200) : null,
    description: description ? decodeHtmlEntities(description).slice(0, 500) : null,
    image: image || null,
    siteName: siteName ? decodeHtmlEntities(siteName).slice(0, 100) : null,
    favicon: favicon,
  };
}

// Decode HTML entities
function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// Image proxy to bypass CORS restrictions
async function handleImageProxy(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) {
    return errorResponse(request, 'Missing url parameter');
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
      return errorResponse(request, 'Domain not allowed', 403);
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
        ...buildCorsHeaders(request),
      },
    });
  } catch (error) {
    console.error('Image proxy error:', error);
    return errorResponse(request, 'Failed to fetch image', 500);
  }
}

// =====================
// Push Notifications
// =====================

const PUSH_SUBSCRIPTION_PREFIX = 'push_sub:';
const VAPID_PRIVATE_KEY = 'jRK-AHoshKkmhKKhIzupOCqhrkqjHH-UiM-QJJcPC9w';
const VAPID_PUBLIC_KEY = 'BJoy9eenwraBkfPbPYcMTRV_Rw6z2uYfIPrGgkukwJI06A8zD_tPBec6-eB8dzi13BFxayeS7wZLPgvSvVb7WMY';
const VAPID_SUBJECT = 'mailto:support@solink.chat';

async function handlePushSubscribe(request, env) {
  const startTime = Date.now();
  console.log('[Push] handlePushSubscribe called');
  
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const body = await readJson(request);
  console.log('[Push] Received body:', JSON.stringify(body).slice(0, 200));
  
  if (!body || !body.pubkey || !body.subscription) {
    console.log('[Push] Missing pubkey or subscription');
    logEvent(env, { type: EventType.ERROR, category: Category.PUSH, action: 'subscribe', details: 'missing fields', status: 400 });
    return errorResponse(request, 'Missing pubkey or subscription');
  }

  const { pubkey, subscription } = body;
  console.log(`[Push] Processing subscription for pubkey: ${pubkey}`);

  // Validate pubkey format
  if (!BASE58_REGEX.test(pubkey)) {
    console.log('[Push] Invalid pubkey format');
    return errorResponse(request, 'Invalid pubkey format');
  }

  try {
    // Store subscription in KV
    // We store as an array to support multiple devices per user
    const key = `${PUSH_SUBSCRIPTION_PREFIX}${pubkey}`;
    console.log(`[Push] KV key: ${key}`);
    
    const existing = await env.SOLINK_KV.get(key, 'json') || [];
    console.log(`[Push] Existing subscriptions: ${existing.length}`);
    
    // Check if this endpoint already exists
    const endpointExists = existing.some(sub => sub.endpoint === subscription.endpoint);
    console.log(`[Push] Endpoint exists: ${endpointExists}`);
    
    if (!endpointExists) {
      existing.push(subscription);
      // Limit to 5 subscriptions per user (5 devices)
      while (existing.length > 5) {
        existing.shift();
      }
    }
    
    console.log(`[Push] Saving ${existing.length} subscriptions to KV...`);
    await env.SOLINK_KV.put(key, JSON.stringify(existing), {
      expirationTtl: 60 * 60 * 24 * 30 // 30 days
    });

    console.log(`[Push] Subscription saved for ${pubkey}, total: ${existing.length}`);
    logEvent(env, { type: EventType.INFO, category: Category.PUSH, action: 'subscribe', wallet: pubkey, details: `${existing.length} devices`, status: 200, latency: Date.now() - startTime });
    return jsonResponse(request, { success: true });
  } catch (error) {
    console.error('[Push] Subscribe error:', error.message || error);
    logEvent(env, { type: EventType.ERROR, category: Category.PUSH, action: 'subscribe', wallet: pubkey, details: error.message, status: 500 });
    return errorResponse(request, 'Failed to save subscription', 500);
  }
}

async function handlePushUnsubscribe(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const body = await readJson(request);
  if (!body || !body.pubkey) {
    return errorResponse(request, 'Missing pubkey');
  }

  const { pubkey, endpoint } = body;

  try {
    const key = `${PUSH_SUBSCRIPTION_PREFIX}${pubkey}`;
    
    if (endpoint) {
      // Remove specific endpoint
      const existing = await env.SOLINK_KV.get(key, 'json') || [];
      const filtered = existing.filter(sub => sub.endpoint !== endpoint);
      if (filtered.length > 0) {
        await env.SOLINK_KV.put(key, JSON.stringify(filtered));
      } else {
        await env.SOLINK_KV.delete(key);
      }
    } else {
      // Remove all subscriptions for this user
      await env.SOLINK_KV.delete(key);
    }

    console.log(`[Push] Subscription removed for ${pubkey}`);
    return jsonResponse(request, { success: true });
  } catch (error) {
    console.error('[Push] Unsubscribe error:', error);
    return errorResponse(request, 'Failed to remove subscription', 500);
  }
}

// Send push notification to a user
async function sendPushNotification(env, recipientPubkey, payload) {
  try {
    const key = `${PUSH_SUBSCRIPTION_PREFIX}${recipientPubkey}`;
    const subscriptions = await env.SOLINK_KV.get(key, 'json');
    
    console.log(`[Push] Checking subscriptions for ${recipientPubkey}, found: ${subscriptions?.length || 0}`);
    
    if (!subscriptions || subscriptions.length === 0) {
      console.log(`[Push] No subscriptions for ${recipientPubkey}`);
      return;
    }

    const payloadString = JSON.stringify(payload);
    const expiredEndpoints = [];

    for (const subscription of subscriptions) {
      try {
        console.log(`[Push] Sending to endpoint: ${subscription.endpoint?.slice(0, 50)}...`);
        const response = await sendWebPush(subscription, payloadString);
        console.log(`[Push] Response status: ${response.status}`);
        
        if (response.status === 410 || response.status === 404) {
          // Subscription expired or invalid
          expiredEndpoints.push(subscription.endpoint);
          console.log(`[Push] Subscription expired/invalid`);
        } else if (response.status === 201) {
          console.log(`[Push] Successfully sent!`);
        } else {
          const text = await response.text();
          console.log(`[Push] Unexpected response: ${response.status} - ${text}`);
        }
      } catch (error) {
        console.error('[Push] Send error:', error.message || error);
        if (error.message?.includes('expired') || error.message?.includes('invalid')) {
          expiredEndpoints.push(subscription.endpoint);
        }
      }
    }

    // Clean up expired subscriptions
    if (expiredEndpoints.length > 0) {
      const filtered = subscriptions.filter(sub => !expiredEndpoints.includes(sub.endpoint));
      if (filtered.length > 0) {
        await env.SOLINK_KV.put(key, JSON.stringify(filtered));
      } else {
        await env.SOLINK_KV.delete(key);
      }
    }
  } catch (error) {
    console.error('[Push] sendPushNotification error:', error.message || error);
  }
}

// Web Push implementation using VAPID
async function sendWebPush(subscription, payload) {
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys.p256dh;
  const auth = subscription.keys.auth;

  try {
    // Create VAPID JWT
    const jwt = await createVapidJwt(endpoint);
    console.log(`[Push] VAPID JWT created`);
    
    // Encrypt payload using RFC 8291 (aes128gcm)
    const encryptedPayload = await encryptPushPayload(payload, p256dh, auth);
    console.log(`[Push] Payload encrypted, size: ${encryptedPayload.byteLength}`);
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
        'Authorization': `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
      },
      body: encryptedPayload,
    });

    return response;
  } catch (error) {
    console.error('[Push] sendWebPush error:', error.message || error);
    throw error;
  }
}

// Create VAPID JWT for push authorization
async function createVapidJwt(endpoint) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const expiration = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: expiration,
    sub: VAPID_SUBJECT,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  // Import VAPID private key as JWK
  // VAPID private key is 32-byte raw scalar, need to convert to JWK
  const privateKeyBytes = base64UrlDecode(VAPID_PRIVATE_KEY);
  const publicKeyBytes = base64UrlDecode(VAPID_PUBLIC_KEY);
  
  // JWK format for P-256 private key
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    // Public key X and Y coordinates (from 65-byte uncompressed key: 0x04 || X || Y)
    x: base64UrlEncode(publicKeyBytes.slice(1, 33)),
    y: base64UrlEncode(publicKeyBytes.slice(33, 65)),
    // Private key D value (32 bytes)
    d: base64UrlEncode(privateKeyBytes),
  };

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  // Sign the token
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  // Convert signature from DER to raw format (r || s, each 32 bytes)
  const signatureBytes = new Uint8Array(signature);
  const signatureB64 = base64UrlEncode(signatureBytes);
  return `${unsignedToken}.${signatureB64}`;
}

// Encrypt push payload using RFC 8291 (aes128gcm)
async function encryptPushPayload(payload, p256dhKey, authSecret) {
  // Decode subscriber keys
  const subscriberPublicKeyBytes = base64UrlDecode(p256dhKey);
  const authSecretBytes = base64UrlDecode(authSecret);
  
  // Generate ephemeral key pair for ECDH
  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  // Import subscriber's public key
  const subscriberKey = await crypto.subtle.importKey(
    'raw',
    subscriberPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // Derive shared secret via ECDH
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subscriberKey },
    localKeyPair.privateKey,
    256
  ));

  // Export local public key
  const localPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', localKeyPair.publicKey));

  // Generate random salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 key derivation
  // IKM = ECDH(localPrivate, subscriberPublic)
  // PRK = HKDF-Extract(auth_secret, IKM)
  // Then derive CEK and nonce
  
  // Step 1: Create info for key derivation
  const keyInfoBuf = createInfo('aesgcm', subscriberPublicKeyBytes, localPublicKeyBytes);
  const nonceInfoBuf = createInfo('nonce', subscriberPublicKeyBytes, localPublicKeyBytes);
  
  // Step 2: Derive PRK from shared secret and auth
  const prkKey = await crypto.subtle.importKey('raw', sharedSecret, { name: 'HKDF' }, false, ['deriveBits', 'deriveKey']);
  
  // Intermediate key material
  const ikmInfo = concatUint8Arrays(
    new TextEncoder().encode('WebPush: info\0'),
    subscriberPublicKeyBytes,
    localPublicKeyBytes
  );
  
  const ikm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', salt: authSecretBytes, info: ikmInfo, hash: 'SHA-256' },
    prkKey,
    256
  ));
  
  // Import IKM for final key derivation
  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits', 'deriveKey']);
  
  // Derive content encryption key (CEK) - 16 bytes
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const cek = await crypto.subtle.deriveKey(
    { name: 'HKDF', salt: salt, info: cekInfo, hash: 'SHA-256' },
    ikmKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt']
  );
  
  // Derive nonce - 12 bytes
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const nonceBits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', salt: salt, info: nonceInfo, hash: 'SHA-256' },
    ikmKey,
    96
  ));

  // Prepare plaintext with padding (RFC 8291 requires delimiter byte)
  const payloadBytes = new TextEncoder().encode(payload);
  const paddedPayload = new Uint8Array(payloadBytes.length + 1);
  paddedPayload.set(payloadBytes);
  paddedPayload[payloadBytes.length] = 2; // Delimiter

  // Encrypt with AES-128-GCM
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBits, tagLength: 128 },
    cek,
    paddedPayload
  ));

  // Build aes128gcm header: salt (16) + rs (4) + idlen (1) + keyid (65)
  const recordSize = 4096;
  const header = new Uint8Array(86); // 16 + 4 + 1 + 65
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = 65; // Length of uncompressed P-256 public key
  header.set(localPublicKeyBytes, 21);

  // Combine header and ciphertext
  const result = new Uint8Array(header.length + encrypted.length);
  result.set(header);
  result.set(encrypted, header.length);

  return result;
}

function createInfo(type, subscriberKey, localKey) {
  const typeBytes = new TextEncoder().encode(type);
  return concatUint8Arrays(
    new TextEncoder().encode('Content-Encoding: '),
    typeBytes,
    new Uint8Array([0]),
    new TextEncoder().encode('P-256'),
    new Uint8Array([0, 65]),
    subscriberKey,
    new Uint8Array([0, 65]),
    localKey
  );
}

function concatUint8Arrays(...arrays) {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function base64UrlEncode(data) {
  let str;
  if (typeof data === 'string') {
    str = btoa(data);
  } else {
    str = btoa(String.fromCharCode(...data));
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - str.length % 4) % 4);
  const decoded = atob(str + padding);
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}

// ============================================
// R2 SYNC HANDLERS - Cloud message storage
// ============================================

async function handleSyncChat(request, url, env) {
  // Extract contactKey from URL: /api/sync/chat/:contactKey
  const pathParts = url.pathname.split('/');
  const contactKey = pathParts[pathParts.length - 1];
  
  if (!contactKey || !BASE58_REGEX.test(contactKey)) {
    return errorResponse(request, 'Invalid contact key', 400);
  }

  // Authenticate
  const token = extractBearerToken(request);
  const walletAddress = await getSessionPubkey(env.SOLINK_KV, token);
  if (!walletAddress) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  // R2 key structure: {walletAddress}/chats/{contactKey}.enc
  const r2Key = `${walletAddress}/chats/${contactKey}.enc`;

  if (request.method === 'PUT') {
    // Save encrypted chat history to R2
    try {
      const body = await request.json();
      if (!body.encrypted || typeof body.encrypted !== 'string') {
        return errorResponse(request, 'Missing encrypted data', 400);
      }

      // Store in R2 with metadata
      await env.SOLINK_STORAGE.put(r2Key, body.encrypted, {
        customMetadata: {
          contactKey,
          updatedAt: Date.now().toString(),
          version: '1'
        }
      });

      console.log(`[Sync] Saved chat: ${walletAddress} -> ${contactKey}`);
      return jsonResponse(request, { success: true, key: contactKey });
    } catch (err) {
      console.error('[Sync] Save error:', err);
      return errorResponse(request, 'Failed to save', 500);
    }

  } else if (request.method === 'GET') {
    // Retrieve encrypted chat history from R2
    try {
      const object = await env.SOLINK_STORAGE.get(r2Key);
      
      if (!object) {
        return jsonResponse(request, { found: false });
      }

      const encrypted = await object.text();
      const metadata = object.customMetadata || {};

      return jsonResponse(request, {
        found: true,
        encrypted,
        updatedAt: parseInt(metadata.updatedAt) || null,
        version: metadata.version || '1'
      });
    } catch (err) {
      console.error('[Sync] Get error:', err);
      return errorResponse(request, 'Failed to retrieve', 500);
    }

  } else if (request.method === 'DELETE') {
    // Delete chat history from R2
    try {
      await env.SOLINK_STORAGE.delete(r2Key);
      console.log(`[Sync] Deleted chat: ${walletAddress} -> ${contactKey}`);
      return jsonResponse(request, { success: true });
    } catch (err) {
      console.error('[Sync] Delete error:', err);
      return errorResponse(request, 'Failed to delete', 500);
    }

  } else {
    return new Response('Method Not Allowed', { status: 405 });
  }
}

async function handleSyncChatsList(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Authenticate
  const token = extractBearerToken(request);
  const walletAddress = await getSessionPubkey(env.SOLINK_KV, token);
  if (!walletAddress) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  try {
    // List all chats for this wallet from R2
    const prefix = `${walletAddress}/chats/`;
    const listed = await env.SOLINK_STORAGE.list({ prefix, limit: 1000 });

    const chats = listed.objects.map(obj => {
      // Extract contact key from path: {wallet}/chats/{contactKey}.enc
      const filename = obj.key.replace(prefix, '');
      const contactKey = filename.replace('.enc', '');
      return {
        contactKey,
        updatedAt: parseInt(obj.customMetadata?.updatedAt) || obj.uploaded?.getTime() || null,
        size: obj.size
      };
    });

    console.log(`[Sync] Listed ${chats.length} chats for ${walletAddress}`);
    return jsonResponse(request, { chats });
  } catch (err) {
    console.error('[Sync] List error:', err);
    return errorResponse(request, 'Failed to list chats', 500);
  }
}

// ============================================
// FULL BACKUP SYNC - Complete database backup
// ============================================

async function handleSyncBackup(request, env) {
  // Authenticate
  const token = extractBearerToken(request);
  const walletAddress = await getSessionPubkey(env.SOLINK_KV, token);
  if (!walletAddress) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  // R2 key: {walletAddress}/backup.enc
  const r2Key = `${walletAddress}/backup.enc`;

  if (request.method === 'PUT') {
    // Save full backup to R2
    try {
      const body = await request.json();
      if (!body.encrypted || typeof body.encrypted !== 'string') {
        return errorResponse(request, 'Missing encrypted data', 400);
      }

      // Validate size (max 50MB)
      const dataSize = body.encrypted.length;
      if (dataSize > 50 * 1024 * 1024) {
        return errorResponse(request, 'Backup too large (max 50MB)', 400);
      }

      await env.SOLINK_STORAGE.put(r2Key, body.encrypted, {
        customMetadata: {
          walletAddress,
          updatedAt: Date.now().toString(),
          size: dataSize.toString(),
          version: '2' // Full backup version
        }
      });

      console.log(`[Backup] Saved full backup for ${walletAddress}, size: ${dataSize} bytes`);
      logEvent(env, { type: EventType.INFO, category: Category.SYNC, action: 'backup_save', wallet: walletAddress, details: `${Math.round(dataSize / 1024)}KB`, status: 200 });
      return jsonResponse(request, { success: true, size: dataSize });
    } catch (err) {
      console.error('[Backup] Save error:', err);
      logEvent(env, { type: EventType.ERROR, category: Category.SYNC, action: 'backup_save', wallet: walletAddress, details: err.message, status: 500 });
      return errorResponse(request, 'Failed to save backup', 500);
    }

  } else if (request.method === 'GET') {
    // Retrieve full backup from R2
    try {
      const object = await env.SOLINK_STORAGE.get(r2Key);
      
      if (!object) {
        console.log(`[Backup] No backup found for ${walletAddress}`);
        return jsonResponse(request, { found: false });
      }

      const encrypted = await object.text();
      const updatedAt = parseInt(object.customMetadata?.updatedAt) || null;
      const size = parseInt(object.customMetadata?.size) || encrypted.length;

      console.log(`[Backup] Retrieved backup for ${walletAddress}, size: ${size} bytes`);
      return jsonResponse(request, { 
        found: true, 
        encrypted, 
        updatedAt,
        size
      });
    } catch (err) {
      console.error('[Backup] Retrieve error:', err);
      return errorResponse(request, 'Failed to retrieve backup', 500);
    }

  } else if (request.method === 'DELETE') {
    // Delete backup from R2
    try {
      await env.SOLINK_STORAGE.delete(r2Key);
      console.log(`[Backup] Deleted backup for ${walletAddress}`);
      return jsonResponse(request, { success: true });
    } catch (err) {
      console.error('[Backup] Delete error:', err);
      return errorResponse(request, 'Failed to delete backup', 500);
    }

  } else {
    return new Response('Method Not Allowed', { status: 405 });
  }
}

// ============================================
// VOICE MESSAGE HANDLERS
// ============================================

async function handleVoiceUpload(request, env) {
  const startTime = Date.now();
  
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const senderPubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!senderPubkey) {
    logEvent(env, { type: EventType.WARN, category: Category.VOICE, action: 'upload', details: 'unauthorized', status: 401 });
    return errorResponse(request, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  if (!body) {
    return errorResponse(request, 'Invalid JSON payload');
  }

  const { recipientPubkey, messageId, encryptedAudio, duration, mimeType } = body;

  // Validation
  if (!recipientPubkey || !BASE58_REGEX.test(recipientPubkey)) {
    return errorResponse(request, 'Invalid recipient');
  }
  if (!messageId || typeof messageId !== 'string') {
    return errorResponse(request, 'Invalid messageId');
  }
  if (!encryptedAudio || typeof encryptedAudio !== 'string') {
    return errorResponse(request, 'Missing encrypted audio');
  }
  if (encryptedAudio.length > MAX_VOICE_SIZE * 1.4) { // base64 overhead
    logEvent(env, { type: EventType.WARN, category: Category.VOICE, action: 'upload', wallet: senderPubkey, details: 'too large', status: 413 });
    return errorResponse(request, 'Audio too large', 413);
  }
  if (duration > MAX_VOICE_DURATION_SEC) {
    logEvent(env, { type: EventType.WARN, category: Category.VOICE, action: 'upload', wallet: senderPubkey, details: 'too long', status: 400 });
    return errorResponse(request, 'Audio too long');
  }

  // Rate limit check
  const allowed = await checkAndIncrementRateLimit(env.SOLINK_KV, senderPubkey);
  if (!allowed) {
    return errorResponse(request, 'Rate limit exceeded', 429);
  }

  // R2 key: voice/{recipientPubkey}/{messageId}.enc
  const r2Key = `${VOICE_PREFIX}${recipientPubkey}/${messageId}.enc`;

  try {
    await env.SOLINK_STORAGE.put(r2Key, encryptedAudio, {
      customMetadata: {
        senderPubkey,
        recipientPubkey,
        messageId,
        duration: String(duration || 0),
        mimeType: mimeType || 'audio/webm',
        uploadedAt: Date.now().toString(),
      }
    });

    console.log(`[Voice] Uploaded: ${r2Key}, size: ${encryptedAudio.length}`);
    logEvent(env, { type: EventType.INFO, category: Category.VOICE, action: 'upload', wallet: senderPubkey, details: `${Math.round(encryptedAudio.length / 1024)}KB`, status: 200, latency: Date.now() - startTime });
    return jsonResponse(request, { 
      success: true, 
      voiceKey: r2Key,
      size: encryptedAudio.length 
    });
  } catch (err) {
    console.error('[Voice] Upload error:', err);
    logEvent(env, { type: EventType.ERROR, category: Category.VOICE, action: 'upload', wallet: senderPubkey, details: err.message, status: 500 });
    return errorResponse(request, 'Failed to upload voice', 500);
  }
}

async function handleVoiceDownload(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const userPubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!userPubkey) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  // Extract voice key from URL: /api/voice/{recipientPubkey}/{messageId}.enc
  // or from query param: /api/voice?key=voice/xxx/yyy.enc
  let voiceKey = url.searchParams.get('key');
  if (!voiceKey) {
    // Try to extract from path
    const pathMatch = url.pathname.match(/^\/api\/voice\/(.+)$/);
    if (pathMatch) {
      voiceKey = `${VOICE_PREFIX}${pathMatch[1]}`;
    }
  }

  if (!voiceKey || !voiceKey.startsWith(VOICE_PREFIX)) {
    return errorResponse(request, 'Invalid voice key', 400);
  }

  try {
    const object = await env.SOLINK_STORAGE.get(voiceKey);
    if (!object) {
      return errorResponse(request, 'Voice not found', 404);
    }

    const metadata = object.customMetadata || {};
    
    // Security: user can only download voices they sent OR received
    const recipientFromKey = voiceKey.replace(VOICE_PREFIX, '').split('/')[0];
    const senderPubkey = metadata.senderPubkey;
    
    if (recipientFromKey !== userPubkey && senderPubkey !== userPubkey) {
      console.log(`[Voice] Access denied: user=${userPubkey}, recipient=${recipientFromKey}, sender=${senderPubkey}`);
      return errorResponse(request, 'Access denied', 403);
    }

    const encryptedAudio = await object.text();

    return jsonResponse(request, {
      found: true,
      encryptedAudio,
      duration: parseInt(metadata.duration) || 0,
      mimeType: metadata.mimeType || 'audio/webm',
      senderPubkey: senderPubkey,
    });
  } catch (err) {
    console.error('[Voice] Download error:', err);
    return errorResponse(request, 'Failed to download voice', 500);
  }
}

async function handleVoiceDelete(request, url, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = extractBearerToken(request);
  const userPubkey = await getSessionPubkey(env.SOLINK_KV, token);
  if (!userPubkey) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  const body = await readJson(request);
  const voiceKey = body?.voiceKey;

  if (!voiceKey || !voiceKey.startsWith(VOICE_PREFIX)) {
    return errorResponse(request, 'Invalid voice key', 400);
  }

  // Security: only recipient can delete
  const keyParts = voiceKey.replace(VOICE_PREFIX, '').split('/');
  const recipientFromKey = keyParts[0];
  if (recipientFromKey !== userPubkey) {
    return errorResponse(request, 'Access denied', 403);
  }

  try {
    await env.SOLINK_STORAGE.delete(voiceKey);
    console.log(`[Voice] Deleted: ${voiceKey}`);
    return jsonResponse(request, { success: true });
  } catch (err) {
    console.error('[Voice] Delete error:', err);
    return errorResponse(request, 'Failed to delete voice', 500);
  }
}

// ============================================
// DEV CONSOLE API
// ============================================

const DEV_TOKEN_PREFIX = 'dev_token:';
const DEV_LOG_KEY = 'dev_logs';
const DEV_TOKEN_TTL = 24 * 60 * 60; // 24 hours
const MAX_DEV_LOGS = 500;

async function handleDevLogin(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const body = await readJson(request);
  if (!body || !body.password) {
    return errorResponse(request, 'Missing password', 400);
  }

  const correctPassword = env.DEV_PASSWORD || 'solink-dev-2024';
  
  if (body.password !== correctPassword) {
    logEvent(env, { type: EventType.WARN, category: Category.SYSTEM, action: 'dev_login', details: 'wrong password', status: 401 });
    return errorResponse(request, 'Invalid password', 401);
  }

  // Generate dev token
  const token = generateToken(32);
  await env.SOLINK_KV.put(`${DEV_TOKEN_PREFIX}${token}`, 'valid', {
    expirationTtl: DEV_TOKEN_TTL,
  });

  logEvent(env, { type: EventType.INFO, category: Category.SYSTEM, action: 'dev_login', details: 'success', status: 200 });
  
  return jsonResponse(request, { token, expiresIn: DEV_TOKEN_TTL });
}

async function verifyDevToken(env, request) {
  const token = extractBearerToken(request);
  if (!token) return false;
  
  const valid = await env.SOLINK_KV.get(`${DEV_TOKEN_PREFIX}${token}`);
  return valid === 'valid';
}

async function handleDevStats(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!await verifyDevToken(env, request)) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  // Get logs from KV
  const logsData = await env.SOLINK_KV.get(DEV_LOG_KEY, 'json') || [];
  const url = new URL(request.url);
  const period = url.searchParams.get('period') || '1h';
  
  // Calculate time filter
  const periodMs = {
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
  };
  
  const cutoff = Date.now() - (periodMs[period] || periodMs['1h']);
  const filteredLogs = logsData.filter(log => log.timestamp > cutoff);
  
  // Calculate stats
  const total = filteredLogs.length;
  const errors = filteredLogs.filter(l => l.type === 'error').length;
  const warnings = filteredLogs.filter(l => l.type === 'warn').length;
  const avgLatency = total > 0 
    ? Math.round(filteredLogs.reduce((sum, l) => sum + (l.latency || 0), 0) / total)
    : 0;
  
  // Category breakdown
  const categories = {};
  filteredLogs.forEach(log => {
    categories[log.category] = (categories[log.category] || 0) + 1;
  });
  
  // Unique wallets
  const uniqueWallets = new Set(filteredLogs.filter(l => l.wallet && l.wallet !== '-').map(l => l.wallet)).size;

  return jsonResponse(request, {
    period,
    stats: {
      total,
      errors,
      warnings,
      avgLatency,
      uniqueWallets,
    },
    categories,
  });
}

async function handleDevEvents(request, url, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!await verifyDevToken(env, request)) {
    return errorResponse(request, 'Unauthorized', 401);
  }

  // Get logs from KV
  const logsData = await env.SOLINK_KV.get(DEV_LOG_KEY, 'json') || [];
  
  // Parse filters
  const period = url.searchParams.get('period') || '1h';
  const type = url.searchParams.get('type') || null;
  const category = url.searchParams.get('category') || null;
  const search = url.searchParams.get('search') || null;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  
  // Calculate time filter
  const periodMs = {
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
  };
  
  const cutoff = Date.now() - (periodMs[period] || periodMs['1h']);
  
  // Apply filters
  let filtered = logsData.filter(log => {
    if (log.timestamp < cutoff) return false;
    if (type && log.type !== type) return false;
    if (category && log.category !== category) return false;
    if (search) {
      const searchLower = search.toLowerCase();
      const searchable = `${log.action} ${log.wallet} ${log.details}`.toLowerCase();
      if (!searchable.includes(searchLower)) return false;
    }
    return true;
  });
  
  // Sort by timestamp descending
  filtered.sort((a, b) => b.timestamp - a.timestamp);
  
  const total = filtered.length;
  const events = filtered.slice(offset, offset + limit);

  return jsonResponse(request, {
    events,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  });
}

export { InboxDurable };

