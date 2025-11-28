import { fetchNonce, verifySignature, clearSessionToken, getSessionToken, getPersistedSession, SESSION_MAX_AGE_MS } from './api.js';
import {
  hasPhantomCallback,
  parsePhantomCallback,
  processConnectCallback,
  processSignCallback,
  processTransactionCallback,
  clearPhantomParams,
  initiateMobileConnect,
  initiateMobileSign,
  initiateMobileTransaction,
  getMobileSession,
  clearMobileSessionData,
  redirectToPhantomBrowser,
  getPendingAction,
  hasMobileSession
} from './phantom-mobile.js';

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

// Storage key for pending nonce (survives redirect) - using localStorage for iOS Safari
const PENDING_NONCE_KEY = 'solink.phantom.pending.nonce';

function savePendingNonce(pubkey, nonce) {
  try {
    localStorage.setItem(PENDING_NONCE_KEY, JSON.stringify({ 
      pubkey, 
      nonce,
      timestamp: Date.now()
    }));
    console.log('[Phantom Mobile] Pending nonce saved for:', pubkey);
  } catch (e) {
    console.warn('Failed to save pending nonce', e);
  }
}

function loadPendingNonce() {
  try {
    const data = localStorage.getItem(PENDING_NONCE_KEY);
    if (!data) {
      console.log('[Phantom Mobile] No pending nonce found');
      return null;
    }
    const parsed = JSON.parse(data);
    // Check if nonce is not too old (10 minutes max)
    if (parsed.timestamp && Date.now() - parsed.timestamp > 10 * 60 * 1000) {
      console.log('[Phantom Mobile] Pending nonce expired');
      clearPendingNonce();
      return null;
    }
    console.log('[Phantom Mobile] Pending nonce loaded for:', parsed.pubkey);
    return parsed;
  } catch (e) {
    console.error('[Phantom Mobile] Failed to load pending nonce', e);
    return null;
  }
}

function clearPendingNonce() {
  try {
    localStorage.removeItem(PENDING_NONCE_KEY);
  } catch (e) {
    // ignore
  }
}

// Handle Phantom mobile callback
async function handlePhantomMobileCallback() {
  console.log('[Phantom Mobile] Checking for callback...');
  console.log('[Phantom Mobile] URL:', window.location.href);
  console.log('[Phantom Mobile] hasPhantomCallback:', hasPhantomCallback());
  
  if (!hasPhantomCallback()) return false;
  
  const callback = parsePhantomCallback();
  console.log('[Phantom Mobile] Parsed callback:', callback);
  
  if (!callback) {
    clearPhantomParams();
    return false;
  }
  
  try {
    if (callback.error) {
      console.error('[Phantom Mobile] Error:', callback.errorMessage);
      clearPhantomParams();
      clearPendingNonce();
      return false;
    }
    
    if (callback.action === 'connect') {
      console.log('[Phantom Mobile] Processing CONNECT callback...');
      // Process connect response
      const session = processConnectCallback(callback);
      console.log('[Phantom Mobile] Connect session:', session);
      const pubkey = session.publicKey;
      
      updateState({ walletPubkey: pubkey });
      clearPhantomParams();
      
      // Now we need to sign a message for authentication
      // Fetch nonce from server and save it for later verification
      console.log('[Phantom Mobile] Fetching nonce for:', pubkey);
      const { nonce } = await fetchNonce(pubkey);
      console.log('[Phantom Mobile] Got nonce:', nonce);
      savePendingNonce(pubkey, nonce);
      
      // Initiate sign with the nonce as message
      console.log('[Phantom Mobile] Initiating sign...');
      initiateMobileSign(nonce);
      return true;
    }
    
    if (callback.action === 'sign') {
      console.log('[Phantom Mobile] Processing SIGN callback...');
      // Process sign response
      const result = processSignCallback(callback);
      console.log('[Phantom Mobile] Sign result:', result);
      
      const mobileSession = getMobileSession();
      const pendingNonce = loadPendingNonce();
      console.log('[Phantom Mobile] Mobile session:', mobileSession);
      console.log('[Phantom Mobile] Pending nonce:', pendingNonce);
      
      const pubkey = pendingNonce?.pubkey || mobileSession?.publicKey || result.publicKey;
      const nonce = pendingNonce?.nonce;
      
      clearPhantomParams();
      
      if (!nonce) {
        console.error('[Phantom Mobile] No pending nonce found!');
        clearPendingNonce();
        return false;
      }
      
      // Verify signature with backend
      console.log('[Phantom Mobile] Verifying signature...');
      console.log('[Phantom Mobile] pubkey:', pubkey);
      console.log('[Phantom Mobile] nonce:', nonce);
      console.log('[Phantom Mobile] signature:', result.signature);
      
      const verifyResult = await verifySignature({
        pubkey,
        nonce,
        signature: result.signature
      });
      
      console.log('[Phantom Mobile] Verify result:', verifyResult);
      clearPendingNonce();
      
      updateState({
        walletPubkey: pubkey,
        isAuthenticated: Boolean(verifyResult?.token)
      });
      
      if (verifyResult?.token) {
        enableAutoConnect();
        scheduleSessionCheck();
        console.log('[Phantom Mobile] SUCCESS! User authenticated.');
      }
      
      return true;
    }
    
    if (callback.action === 'transaction') {
      console.log('[Phantom Mobile] Processing TRANSACTION callback...');
      try {
        const result = processTransactionCallback(callback);
        console.log('[Phantom Mobile] Transaction result:', result);
        clearPhantomParams();
        
        // Store the signature for the pending transaction
        if (result.signature) {
          localStorage.setItem('solink.pending.tx.signature', result.signature);
        }
        
        return true;
      } catch (error) {
        console.error('[Phantom Mobile] Transaction callback error:', error);
        clearPhantomParams();
        return false;
      }
    }
  } catch (error) {
    console.error('[Phantom Mobile] Callback error:', error);
    clearPhantomParams();
    clearPendingNonce();
  }
  
  return false;
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
  // Use deeplink connect instead of browse
  initiateMobileConnect();
}

function handleDisconnect() {
  console.info('Wallet disconnected');
  clearSessionToken();
  disableAutoConnect();
  updateState({ walletPubkey: null, isAuthenticated: false });
}

function refreshProvider() {
  const provider = getProvider();
  if (provider !== state.provider) {
    updateState({ provider });
    provider?.on?.('accountChanged', handleAccountChange);
    provider?.on?.('disconnect', handleDisconnect);
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
    provider.on?.('disconnect', handleDisconnect);
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

export function isMobileDevice() {
  return state.isMobile;
}

export { initiateMobileTransaction, hasMobileSession };

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

export async function initApp() {
  // Check for Phantom mobile callback first
  if (hasPhantomCallback()) {
    try {
      const handled = await handlePhantomMobileCallback();
      if (handled) {
        // Callback handled, emit state and continue with normal init
        emitState();
      }
    } catch (error) {
      console.error('Mobile callback handling failed:', error);
      clearPhantomParams();
    }
  }
  
  const provider = refreshProvider();

  const persisted = getPersistedSession();
  const hasPersistedSession = Boolean(persisted?.token && persisted.pubkey);
  if (hasPersistedSession) {
    updateState({ walletPubkey: persisted.pubkey, isAuthenticated: true });
    scheduleSessionCheck();
  }

  if (provider) {
    provider.on?.('accountChanged', handleAccountChange);
    provider.on?.('disconnect', handleDisconnect);
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
  clearMobileSessionData();
  clearPendingNonce();
  updateState({ walletPubkey: null, isAuthenticated: false });
  clearTimeout(sessionCheckTimer);
  sessionCheckTimer = null;
}
