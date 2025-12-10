import { fetchNonce, verifySignature, clearSessionToken, getSessionToken, getPersistedSession, SESSION_MAX_AGE_MS, initMobileAuth, verifyMobileAuth } from './api.js';
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
  hasMobileSession,
  loadMobileChallenge,
  clearMobileChallenge,
  getDappPublicKey,
  prepareMobileAuth
} from './phantom-mobile.js';

const AUTO_CONNECT_FLAG_KEY = 'solink-auto-connect';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = BASE58_ALPHABET.split('');
const MOBILE_REGEX = /android|iphone|ipad|ipod/i;

// Better detection for iPad with Desktop UA (iPadOS 13+)
function detectMobile() {
  const ua = navigator.userAgent || '';
  if (MOBILE_REGEX.test(ua)) return true;
  
  // iPad with Desktop UA: appears as Mac but has touch support
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) {
    return true;
  }
  
  return false;
}

const state = {
  provider: null,
  walletPubkey: null,
  isAuthenticated: false,
  route: parseRoute(location.hash),
  isMobile: detectMobile(),
  pendingMobileSign: false, // Flag for iOS: user needs to tap to continue signing
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
      
      // New mobile auth: verify with challenge (no second signature needed!)
      const savedChallenge = loadMobileChallenge();
      
      console.log('[Phantom Mobile] Saved challenge data:', savedChallenge);
      
      // Use dappPublicKey from saved challenge (more reliable than getDappPublicKey)
      if (savedChallenge?.challenge && savedChallenge?.dappPublicKey) {
        // Use new challenge-based auth
        console.log('[Phantom Mobile] Using challenge-based auth (single step!)');
        console.log('[Phantom Mobile] Challenge:', savedChallenge.challenge);
        console.log('[Phantom Mobile] DappPublicKey:', savedChallenge.dappPublicKey);
        
        try {
          const verifyResult = await verifyMobileAuth({
            pubkey,
            dappPublicKey: savedChallenge.dappPublicKey,
            challenge: savedChallenge.challenge
          });
          
          console.log('[Phantom Mobile] Verify result:', verifyResult);
          clearMobileChallenge();
          
          updateState({
            walletPubkey: pubkey,
            isAuthenticated: Boolean(verifyResult?.token),
            pendingMobileSign: false
          });
          
          if (verifyResult?.token) {
            enableAutoConnect();
            scheduleSessionCheck();
            console.log('[Phantom Mobile] SUCCESS! User authenticated (single step).');
          }
          
          return true;
        } catch (error) {
          console.error('[Phantom Mobile] Challenge verification failed:', error);
          clearMobileChallenge();
          // Fall through to legacy flow
        }
      } else {
        console.log('[Phantom Mobile] No valid challenge found, falling back to legacy flow');
      }
      
      // Legacy flow: need second signature (fallback)
      console.log('[Phantom Mobile] Falling back to legacy sign flow...');
      console.log('[Phantom Mobile] Fetching nonce for:', pubkey);
      const { nonce } = await fetchNonce(pubkey);
      console.log('[Phantom Mobile] Got nonce:', nonce);
      savePendingNonce(pubkey, nonce);
      
      // iOS Safari blocks programmatic redirects without user gesture
      // Set flag to show "Continue" button instead of auto-redirect
      console.log('[Phantom Mobile] Setting pendingMobileSign flag (iOS requires user tap)');
      updateState({ pendingMobileSign: true });
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

async function redirectToPhantomApp() {
  // Mobile auth flow: get challenge from server, then redirect to Phantom
  try {
    console.log('[Phantom Mobile] Starting mobile auth flow...');
    
    // Step 1: Generate keypair and get dappPublicKey
    const dappPublicKey = prepareMobileAuth();
    console.log('[Phantom Mobile] Generated dappPublicKey:', dappPublicKey);
    
    // Step 2: Get challenge from server
    const { challenge } = await initMobileAuth(dappPublicKey);
    console.log('[Phantom Mobile] Got challenge from server:', challenge);
    
    // Step 3: Save challenge locally and redirect to Phantom
    initiateMobileConnect(challenge);
  } catch (error) {
    console.error('[Phantom Mobile] Failed to start mobile auth:', error);
    // Fallback: open in Phantom browser (works but user stays inside Phantom)
    redirectToPhantomBrowser();
  }
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
      await redirectToPhantomApp();
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

// Check if there's a pending mobile sign (iOS Safari flow)
// This checks localStorage directly - survives page reload/new tab
export function hasPendingMobileSign() {
  console.log('[Phantom Mobile] hasPendingMobileSign check:');
  console.log('[Phantom Mobile] - isMobile:', state.isMobile);
  
  // Only show on mobile devices
  if (!state.isMobile) {
    console.log('[Phantom Mobile] - Not mobile, returning false');
    return false;
  }
  
  // Check if we have a pending nonce in localStorage
  const pending = loadPendingNonce();
  console.log('[Phantom Mobile] - pending nonce:', pending);
  if (!pending?.nonce) {
    console.log('[Phantom Mobile] - No pending nonce, returning false');
    return false;
  }
  
  // Also need mobile session (from connect callback)
  const hasSession = hasMobileSession();
  console.log('[Phantom Mobile] - hasMobileSession:', hasSession);
  if (!hasSession) {
    console.log('[Phantom Mobile] - No mobile session, returning false');
    return false;
  }
  
  console.log('[Phantom Mobile] - All checks passed, returning true');
  return true;
}

// Continue mobile sign flow (called from user click on iOS)
export function continueMobileSign() {
  console.log('[Phantom Mobile] continueMobileSign called');
  
  try {
    const pending = loadPendingNonce();
    console.log('[Phantom Mobile] Pending nonce data:', pending);
    
    if (!pending?.nonce) {
      console.error('[Phantom Mobile] No pending nonce for sign');
      updateState({ pendingMobileSign: false });
      return false;
    }
    
    // Check if we have mobile session
    const session = getMobileSession();
    console.log('[Phantom Mobile] Mobile session:', session);
    
    if (!session) {
      console.error('[Phantom Mobile] No mobile session found');
      updateState({ pendingMobileSign: false });
      return false;
    }
    
    console.log('[Phantom Mobile] Continuing sign flow with nonce:', pending.nonce);
    updateState({ pendingMobileSign: false });
    
    // This redirect should work because it's triggered by user click
    initiateMobileSign(pending.nonce);
    return true;
  } catch (error) {
    console.error('[Phantom Mobile] Error in continueMobileSign:', error);
    updateState({ pendingMobileSign: false });
    return false;
  }
}

// Clear pending mobile sign state
export function clearPendingMobileSign() {
  updateState({ pendingMobileSign: false });
  clearPendingNonce();
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

export async function initApp() {
  // Clear stale mobile session data on fresh load (no callback expected)
  // This prevents showing "Continue to sign" panel when not needed
  if (!hasPhantomCallback()) {
    clearMobileSessionData();
    clearPendingNonce();
  }
  
  // Check for Phantom mobile callback
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
      clearMobileChallenge();
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
  clearMobileChallenge();
  updateState({ walletPubkey: null, isAuthenticated: false, pendingMobileSign: false });
  clearTimeout(sessionCheckTimer);
  sessionCheckTimer = null;
}
