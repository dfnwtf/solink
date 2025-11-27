import { fetchNonce, verifySignature, clearSessionToken, getSessionToken, getPersistedSession, SESSION_MAX_AGE_MS } from './api.js';

const AUTO_CONNECT_FLAG_KEY = 'solink-auto-connect';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = BASE58_ALPHABET.split('');
const MOBILE_REGEX = /android|iphone|ipad|ipod/i;

const state = {
  provider: null,
  walletPubkey: null,
  isAuthenticated: false,
  route: parseRoute(location.hash),
  isMobile: MOBILE_REGEX.test(navigator.userAgent || ''),
};

const listeners = new Set();
let sessionCheckTimer = null;

function enableAutoConnect() {
  try {
    localStorage.setItem(AUTO_CONNECT_FLAG_KEY, '1');
  } catch {
    // ignore storage errors
  }
}

function disableAutoConnect() {
  try {
    localStorage.removeItem(AUTO_CONNECT_FLAG_KEY);
  } catch {
    // ignore storage errors
  }
}

function shouldAutoConnect() {
  try {
    return localStorage.getItem(AUTO_CONNECT_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function encodeBase58(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Base58 encode expects Uint8Array');
  }

  if (bytes.length === 0) {
    return '';
  }

  let digits = [0];
  for (let i = 0; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      const x = digits[j] * 256 + carry;
      digits[j] = x % 58;
      carry = Math.floor(x / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  for (let k = 0; bytes[k] === 0 && k < bytes.length - 1; k += 1) {
    digits.push(0);
  }

  return digits
    .reverse()
    .map((digit) => BASE58_MAP[digit])
    .join('');
}

function parseRoute(hash) {
  if (hash?.startsWith('#/dm/')) {
    const pubkey = hash.slice('#/dm/'.length);
    return { name: 'dm', pubkey };
  }
  return { name: 'home' };
}

function emitState() {
  const snapshot = { ...state };
  listeners.forEach((callback) => {
    try {
      callback(snapshot);
    } catch (error) {
      console.error('State listener error', error);
    }
  });
}

function updateState(partial) {
  Object.assign(state, partial);
  emitState();
}

function scheduleSessionCheck() {
  clearTimeout(sessionCheckTimer);
  const session = getPersistedSession();
  if (!session?.timestamp) {
    return;
  }
  const age = Date.now() - session.timestamp;
  const remaining = Math.max(0, SESSION_MAX_AGE_MS - age);
  sessionCheckTimer = setTimeout(() => {
    if (!getSessionToken()) {
      updateState({ isAuthenticated: false });
    }
  }, Math.min(remaining + 1000, SESSION_MAX_AGE_MS));
}

function getProvider() {
  const phantom = window.phantom?.solana;
  if (phantom?.isPhantom) {
    return phantom;
  }
  const provider = window.solana;
  if (provider?.isPhantom) {
    return provider;
  }
  return null;
}

function redirectToPhantomApp() {
  const target = encodeURIComponent(window.location.href);
  window.location.href = `https://phantom.app/ul/browse/${target}`;
}

function refreshProvider() {
  const provider = getProvider();
  if (provider !== state.provider) {
    updateState({ provider });
    provider?.on?.('accountChanged', handleAccountChange);
  }
  return provider;
}

async function establishSession(pubkey) {
  const { nonce } = await fetchNonce(pubkey);
  const encoder = new TextEncoder();
  const message = encoder.encode(nonce);

  const provider = state.provider;
  const signed = await provider.signMessage(message, 'utf8');
  const signature = 'signature' in signed ? signed.signature : signed;
  const signatureBase58 = encodeBase58(signature);

  const result = await verifySignature({ pubkey, nonce, signature: signatureBase58 });
  updateState({ isAuthenticated: Boolean(result?.token) });
  scheduleSessionCheck();
}

async function connectWallet({ silent = false, allowRedirect = false } = {}) {
  const provider = state.provider || refreshProvider();

  if (!provider) {
    if (allowRedirect && state.isMobile) {
      redirectToPhantomApp();
      return;
    }
    const error = new Error('Phantom wallet not found');
    error.code = 'PHANTOM_NOT_FOUND';
    throw error;
  }

  if (provider !== state.provider) {
    updateState({ provider });
    provider.on?.('accountChanged', handleAccountChange);
  }

  const connectArgs = silent ? { onlyIfTrusted: true } : undefined;
  const response = await provider.connect(connectArgs);
  const pubkey = response.publicKey?.toBase58?.() || provider.publicKey?.toBase58?.();

  if (!pubkey) {
    throw new Error('Wallet did not return public key');
  }

  updateState({ walletPubkey: pubkey });

  const hasFreshSession = getPersistedSession()?.token && getPersistedSession()?.pubkey === pubkey;
  if (silent && hasFreshSession) {
    updateState({ isAuthenticated: true });
    enableAutoConnect();
    return;
  }

  if (!silent || !hasFreshSession) {
    await establishSession(pubkey);
  }

  enableAutoConnect();
}

function handleAccountChange(newPubkey) {
  if (newPubkey) {
    const base58 = typeof newPubkey === 'string' ? newPubkey : newPubkey.toBase58?.();
    const session = getPersistedSession();
    if (session?.pubkey && base58 && session.pubkey !== base58) {
      console.info('Wallet account switched in Phantom, keeping existing SOLink session');
      return;
    }
    updateState({ walletPubkey: base58 || null, isAuthenticated: Boolean(getSessionToken()) });
    if (base58 && (!session || session.pubkey !== base58)) {
      connectWallet().catch((error) => console.warn('Re-auth failed', error));
    }
  } else {
    const session = getPersistedSession();
    if (session?.pubkey && session.token) {
      updateState({ provider: null, walletPubkey: session.pubkey, isAuthenticated: true });
    } else {
      clearSessionToken();
      disableAutoConnect();
      updateState({ walletPubkey: null, isAuthenticated: false });
    }
  }
}

export function onStateChange(callback) {
  listeners.add(callback);
  callback({ ...state });
  return () => listeners.delete(callback);
}

export function getCurrentRoute() {
  return { ...state.route };
}

export function getWalletPubkey() {
  return state.walletPubkey;
}

export function isAuthenticated() {
  const token = getSessionToken();
  if (!token) {
    return false;
  }
  if (!state.isAuthenticated) {
    updateState({ isAuthenticated: true });
  }
  return true;
}

export function getProviderInstance() {
  return refreshProvider();
}

export async function requestConnect(options = {}) {
  try {
    await connectWallet({ allowRedirect: true });
    if (options.forceReload && typeof window !== 'undefined') {
      window.location.reload();
    }
  } catch (error) {
    console.error('Wallet connect error', error);
    throw error;
  }
}

export function initApp() {
  const provider = refreshProvider();

  const persisted = getPersistedSession();
  const hasPersistedSession = Boolean(persisted?.token && persisted.pubkey);
  if (hasPersistedSession) {
    updateState({ walletPubkey: persisted.pubkey, isAuthenticated: true });
    scheduleSessionCheck();
  }

  if (provider) {
    provider.on?.('accountChanged', handleAccountChange);
    if (shouldAutoConnect() && !hasPersistedSession) {
      connectWallet({ silent: true }).catch(() => {
        // ignore: user not yet trusted or not connected
      });
    }
  }

  window.addEventListener('focus', () => {
    const updated = refreshProvider();
    if (updated && state.walletPubkey && !state.isAuthenticated && shouldAutoConnect()) {
      connectWallet({ silent: true }).catch(() => {});
    }
  });

  window.addEventListener('hashchange', () => {
    updateState({ route: parseRoute(location.hash) });
  });

  emitState();
}

export async function logout() {
  try {
    await state.provider?.disconnect?.();
  } catch (error) {
    console.warn('Wallet disconnect failed', error);
  }
  disableAutoConnect();
  clearSessionToken();
  updateState({ walletPubkey: null, isAuthenticated: false });
  clearTimeout(sessionCheckTimer);
  sessionCheckTimer = null;
}
