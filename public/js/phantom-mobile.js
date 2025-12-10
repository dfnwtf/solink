/**
 * Phantom Mobile Deeplink Integration
 * Handles wallet connection on mobile devices via deeplinks
 */

import nacl from "https://cdn.skypack.dev/tweetnacl@1.0.3?min";

const PHANTOM_CONNECT_URL = 'https://phantom.app/ul/v1/connect';
const PHANTOM_SIGN_MESSAGE_URL = 'https://phantom.app/ul/v1/signMessage';
const PHANTOM_SIGN_TRANSACTION_URL = 'https://phantom.app/ul/v1/signAndSendTransaction';

const MOBILE_SESSION_KEY = 'solink.phantom.mobile.session';
const MOBILE_KEYPAIR_KEY = 'solink.phantom.mobile.keypair';
const MOBILE_CHALLENGE_KEY = 'solink.phantom.mobile.challenge';

// Base58 encoding/decoding
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    bytes = new Uint8Array(bytes);
  }
  if (bytes.length === 0) return '';
  
  let digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      const x = digits[j] * 256 + carry;
      digits[j] = x % 58;
      carry = Math.floor(x / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  
  for (let k = 0; bytes[k] === 0 && k < bytes.length - 1; k++) {
    digits.push(0);
  }
  
  return digits.reverse().map(d => BASE58_ALPHABET[d]).join('');
}

function decodeBase58(str) {
  if (!str || str.length === 0) return new Uint8Array(0);
  
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const index = BASE58_ALPHABET.indexOf(str[i]);
    if (index === -1) throw new Error('Invalid base58 character');
    
    let carry = index;
    for (let j = 0; j < bytes.length; j++) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x % 256;
      carry = Math.floor(x / 256);
    }
    while (carry > 0) {
      bytes.push(carry % 256);
      carry = Math.floor(carry / 256);
    }
  }
  
  for (let k = 0; str[k] === '1' && k < str.length - 1; k++) {
    bytes.push(0);
  }
  
  return new Uint8Array(bytes.reverse());
}

// Prepare mobile auth - generate keypair and return dappPublicKey
// Call this BEFORE getting challenge from server
export function prepareMobileAuth() {
  const keypair = nacl.box.keyPair();
  saveKeypair(keypair);
  const dappPublicKey = encodeBase58(keypair.publicKey);
  console.log('[Phantom Mobile] Prepared keypair, dappPublicKey:', dappPublicKey);
  return dappPublicKey;
}

// Storage helpers - using localStorage to survive redirects on iOS Safari
function saveKeypair(keypair) {
  try {
    localStorage.setItem(MOBILE_KEYPAIR_KEY, JSON.stringify({
      publicKey: encodeBase58(keypair.publicKey),
      secretKey: encodeBase58(keypair.secretKey),
      timestamp: Date.now()
    }));
    console.log('[Phantom Mobile] Keypair saved');
  } catch (e) {
    console.warn('Failed to save keypair', e);
  }
}

function loadKeypair() {
  try {
    const data = localStorage.getItem(MOBILE_KEYPAIR_KEY);
    if (!data) {
      console.log('[Phantom Mobile] No keypair found');
      return null;
    }
    const parsed = JSON.parse(data);
    // Check if keypair is not too old (10 minutes max)
    if (parsed.timestamp && Date.now() - parsed.timestamp > 10 * 60 * 1000) {
      console.log('[Phantom Mobile] Keypair expired');
      clearKeypair();
      return null;
    }
    console.log('[Phantom Mobile] Keypair loaded');
    return {
      publicKey: decodeBase58(parsed.publicKey),
      secretKey: decodeBase58(parsed.secretKey)
    };
  } catch (e) {
    console.error('[Phantom Mobile] Failed to load keypair', e);
    return null;
  }
}

function clearKeypair() {
  try {
    localStorage.removeItem(MOBILE_KEYPAIR_KEY);
  } catch (e) {
    // ignore
  }
}

function saveMobileSession(session) {
  try {
    localStorage.setItem(MOBILE_SESSION_KEY, JSON.stringify({
      ...session,
      timestamp: Date.now()
    }));
    console.log('[Phantom Mobile] Session saved:', session.publicKey);
  } catch (e) {
    console.warn('Failed to save mobile session', e);
  }
}

function loadMobileSession() {
  try {
    const data = localStorage.getItem(MOBILE_SESSION_KEY);
    if (!data) {
      console.log('[Phantom Mobile] No session found');
      return null;
    }
    const parsed = JSON.parse(data);
    // Check if session is not too old (10 minutes max)
    if (parsed.timestamp && Date.now() - parsed.timestamp > 10 * 60 * 1000) {
      console.log('[Phantom Mobile] Session expired');
      clearMobileSession();
      return null;
    }
    console.log('[Phantom Mobile] Session loaded:', parsed.publicKey);
    return parsed;
  } catch (e) {
    console.error('[Phantom Mobile] Failed to load session', e);
    return null;
  }
}

function clearMobileSession() {
  try {
    localStorage.removeItem(MOBILE_SESSION_KEY);
    localStorage.removeItem(MOBILE_KEYPAIR_KEY);
  } catch (e) {
    // ignore
  }
}

// Pending action storage (survives redirect)
const PENDING_ACTION_KEY = 'solink.phantom.pending';

function savePendingAction(action) {
  try {
    localStorage.setItem(PENDING_ACTION_KEY, JSON.stringify({
      ...action,
      timestamp: Date.now()
    }));
    console.log('[Phantom Mobile] Pending action saved:', action.type);
  } catch (e) {
    console.warn('Failed to save pending action', e);
  }
}

function loadPendingAction() {
  try {
    const data = localStorage.getItem(PENDING_ACTION_KEY);
    if (!data) return null;
    const parsed = JSON.parse(data);
    // Check if action is not too old (10 minutes max)
    if (parsed.timestamp && Date.now() - parsed.timestamp > 10 * 60 * 1000) {
      clearPendingAction();
      return null;
    }
    console.log('[Phantom Mobile] Pending action loaded:', parsed.type);
    return parsed;
  } catch (e) {
    return null;
  }
}

function clearPendingAction() {
  try {
    localStorage.removeItem(PENDING_ACTION_KEY);
  } catch (e) {
    // ignore
  }
}

// Challenge storage for mobile auth (survives redirect)
function saveMobileChallenge(challenge, dappPublicKey) {
  try {
    const data = {
      challenge,
      dappPublicKey,
      timestamp: Date.now()
    };
    localStorage.setItem(MOBILE_CHALLENGE_KEY, JSON.stringify(data));
    console.log('[Phantom Mobile] Challenge saved:', data);
  } catch (e) {
    console.warn('Failed to save challenge', e);
  }
}

export function loadMobileChallenge() {
  try {
    const data = localStorage.getItem(MOBILE_CHALLENGE_KEY);
    if (!data) {
      console.log('[Phantom Mobile] No challenge found');
      return null;
    }
    const parsed = JSON.parse(data);
    // Check if challenge is not too old (5 minutes max)
    if (parsed.timestamp && Date.now() - parsed.timestamp > 5 * 60 * 1000) {
      console.log('[Phantom Mobile] Challenge expired');
      clearMobileChallenge();
      return null;
    }
    console.log('[Phantom Mobile] Challenge loaded');
    return parsed;
  } catch (e) {
    console.error('[Phantom Mobile] Failed to load challenge', e);
    return null;
  }
}

export function clearMobileChallenge() {
  try {
    localStorage.removeItem(MOBILE_CHALLENGE_KEY);
  } catch (e) {
    // ignore
  }
}

// Build redirect URL for current page
function buildRedirectUrl(action) {
  const url = new URL(window.location.href);
  // Clean existing phantom params
  url.searchParams.delete('phantom_action');
  url.searchParams.delete('data');
  url.searchParams.delete('nonce');
  url.searchParams.delete('phantom_encryption_public_key');
  url.searchParams.delete('errorCode');
  url.searchParams.delete('errorMessage');
  // Add action
  url.searchParams.set('phantom_action', action);
  return url.toString();
}

// Build Phantom connect deeplink
export function buildConnectUrl(challenge = null) {
  // Use existing keypair if available (from prepareMobileAuth), otherwise generate new
  let existingKeypair = loadKeypair();
  let dappPublicKey;
  
  if (existingKeypair) {
    // Use existing keypair
    dappPublicKey = encodeBase58(existingKeypair.publicKey);
    console.log('[Phantom Mobile] Using existing keypair');
  } else {
    // Generate new X25519 keypair
    const keypair = nacl.box.keyPair();
    saveKeypair(keypair);
    dappPublicKey = encodeBase58(keypair.publicKey);
    console.log('[Phantom Mobile] Generated new keypair');
  }
  
  // Save challenge with dappPublicKey for later verification
  if (challenge) {
    saveMobileChallenge(challenge, dappPublicKey);
  }
  
  const params = new URLSearchParams({
    app_url: window.location.origin,
    dapp_encryption_public_key: dappPublicKey,
    redirect_link: buildRedirectUrl('connect'),
    cluster: 'mainnet-beta'
  });
  
  return `${PHANTOM_CONNECT_URL}?${params.toString()}`;
}

// Get dapp public key (for server verification)
export function getDappPublicKey() {
  const keypair = loadKeypair();
  if (!keypair) return null;
  return encodeBase58(keypair.publicKey);
}

// Generate new keypair and return dappPublicKey (for mobile auth init)
export function generateDappKeyPair() {
  const keypair = nacl.box.keyPair();
  saveKeypair(keypair);
  const dappPublicKey = encodeBase58(keypair.publicKey);
  console.log('[Phantom Mobile] Generated new dappPublicKey:', dappPublicKey);
  return dappPublicKey;
}

// Build Phantom sign message deeplink
export function buildSignMessageUrl(message) {
  const session = loadMobileSession();
  const keypair = loadKeypair();
  
  if (!keypair || !session) {
    throw new Error('No session found');
  }
  
  // Generate nonce for this request
  const nonce = nacl.randomBytes(24);
  
  // Encrypt the payload
  const payload = JSON.stringify({
    message: encodeBase58(new TextEncoder().encode(message)),
    session: session.session,
    display: 'utf8'
  });
  
  const phantomPublicKey = decodeBase58(session.phantomPublicKey);
  const encryptedPayload = nacl.box(
    new TextEncoder().encode(payload),
    nonce,
    phantomPublicKey,
    keypair.secretKey
  );
  
  // Save pending action with nonce for later verification
  savePendingAction({
    type: 'sign',
    message,
    nonce: encodeBase58(nonce)
  });
  
  const params = new URLSearchParams({
    dapp_encryption_public_key: encodeBase58(keypair.publicKey),
    redirect_link: buildRedirectUrl('sign'),
    nonce: encodeBase58(nonce),
    payload: encodeBase58(encryptedPayload)
  });
  
  return `${PHANTOM_SIGN_MESSAGE_URL}?${params.toString()}`;
}

// Build Phantom signAndSendTransaction deeplink
export function buildSignAndSendTransactionUrl(serializedTransaction) {
  const session = loadMobileSession();
  const keypair = loadKeypair();
  
  if (!keypair || !session) {
    throw new Error('No mobile session found');
  }
  
  // Generate nonce for this request
  const nonce = nacl.randomBytes(24);
  
  // Encrypt the payload
  const payload = JSON.stringify({
    transaction: serializedTransaction, // base58 encoded serialized transaction
    session: session.session,
    sendOptions: {
      skipPreflight: false
    }
  });
  
  const phantomPublicKey = decodeBase58(session.phantomPublicKey);
  const encryptedPayload = nacl.box(
    new TextEncoder().encode(payload),
    nonce,
    phantomPublicKey,
    keypair.secretKey
  );
  
  // Save pending action
  savePendingAction({
    type: 'transaction',
    nonce: encodeBase58(nonce)
  });
  
  const params = new URLSearchParams({
    dapp_encryption_public_key: encodeBase58(keypair.publicKey),
    redirect_link: buildRedirectUrl('transaction'),
    nonce: encodeBase58(nonce),
    payload: encodeBase58(encryptedPayload)
  });
  
  return `${PHANTOM_SIGN_TRANSACTION_URL}?${params.toString()}`;
}

// Initiate mobile transaction
export function initiateMobileTransaction(serializedTransaction) {
  const url = buildSignAndSendTransactionUrl(serializedTransaction);
  window.location.href = url;
}

// Process transaction callback
export function processTransactionCallback(callback) {
  if (callback.error) {
    throw new Error(callback.errorMessage);
  }
  
  const keypair = loadKeypair();
  const session = loadMobileSession();
  
  if (!keypair || !session) {
    throw new Error('No session found');
  }
  
  const data = decodeBase58(callback.data);
  const nonce = decodeBase58(callback.nonce);
  const phantomPublicKey = decodeBase58(session.phantomPublicKey);
  
  // Decrypt using nacl.box.open
  const decrypted = nacl.box.open(
    data,
    nonce,
    phantomPublicKey,
    keypair.secretKey
  );
  
  if (!decrypted) {
    throw new Error('Failed to decrypt transaction response');
  }
  
  const decoded = new TextDecoder().decode(decrypted);
  const parsed = JSON.parse(decoded);
  
  // Clear pending action
  clearPendingAction();
  
  return {
    signature: parsed.signature
  };
}

// Check if mobile session exists
export function hasMobileSession() {
  const session = loadMobileSession();
  return Boolean(session?.publicKey && session?.session);
}

// Parse Phantom callback from URL
export function parsePhantomCallback() {
  const url = new URL(window.location.href);
  console.log('[Phantom Mobile Parse] Full URL:', url.toString());
  console.log('[Phantom Mobile Parse] Search params:', url.searchParams.toString());
  console.log('[Phantom Mobile Parse] Hash:', url.hash);
  
  // Try query params first
  let params = url.searchParams;
  let action = params.get('phantom_action');
  
  // If not in query, try hash
  if (!action && url.hash && url.hash.length > 1) {
    // Remove the leading # and parse
    const hashStr = url.hash.slice(1);
    // Hash might be like #/path?params or just #params
    const queryIndex = hashStr.indexOf('?');
    if (queryIndex !== -1) {
      params = new URLSearchParams(hashStr.slice(queryIndex + 1));
    } else if (!hashStr.startsWith('/')) {
      params = new URLSearchParams(hashStr);
    }
    action = params.get('phantom_action');
    console.log('[Phantom Mobile Parse] Parsed from hash, action:', action);
  }
  
  console.log('[Phantom Mobile Parse] Final action:', action);
  
  if (!action) return null;
  
  // Check for error
  const errorCode = params.get('errorCode');
  const errorMessage = params.get('errorMessage');
  
  if (errorCode) {
    return {
      action,
      error: true,
      errorCode,
      errorMessage: errorMessage ? decodeURIComponent(errorMessage) : 'Unknown error'
    };
  }
  
  if (action === 'connect') {
    const result = {
      action: 'connect',
      data: params.get('data'),
      nonce: params.get('nonce'),
      phantom_encryption_public_key: params.get('phantom_encryption_public_key')
    };
    console.log('[Phantom Mobile Parse] Connect result:', result);
    return result;
  }
  
  if (action === 'sign') {
    const result = {
      action: 'sign',
      data: params.get('data'),
      nonce: params.get('nonce')
    };
    console.log('[Phantom Mobile Parse] Sign result:', result);
    return result;
  }
  
  if (action === 'transaction') {
    const result = {
      action: 'transaction',
      data: params.get('data'),
      nonce: params.get('nonce')
    };
    console.log('[Phantom Mobile Parse] Transaction result:', result);
    return result;
  }
  
  return null;
}

// Process connect callback - decrypt Phantom's response
export function processConnectCallback(callback) {
  if (callback.error) {
    throw new Error(callback.errorMessage);
  }
  
  const keypair = loadKeypair();
  if (!keypair) {
    throw new Error('No keypair found for decryption');
  }
  
  const data = decodeBase58(callback.data);
  const nonce = decodeBase58(callback.nonce);
  const phantomPublicKey = decodeBase58(callback.phantom_encryption_public_key);
  
  // Decrypt using nacl.box.open
  const decrypted = nacl.box.open(
    data,
    nonce,
    phantomPublicKey,
    keypair.secretKey
  );
  
  if (!decrypted) {
    throw new Error('Failed to decrypt Phantom response');
  }
  
  const decoded = new TextDecoder().decode(decrypted);
  const parsed = JSON.parse(decoded);
  
  const session = {
    publicKey: parsed.public_key,
    session: parsed.session,
    phantomPublicKey: callback.phantom_encryption_public_key
  };
  
  saveMobileSession(session);
  
  return session;
}

// Process sign callback - decrypt signature
export function processSignCallback(callback) {
  if (callback.error) {
    throw new Error(callback.errorMessage);
  }
  
  const keypair = loadKeypair();
  const session = loadMobileSession();
  
  if (!keypair || !session) {
    throw new Error('No session found');
  }
  
  const data = decodeBase58(callback.data);
  const nonce = decodeBase58(callback.nonce);
  const phantomPublicKey = decodeBase58(session.phantomPublicKey);
  
  // Decrypt using nacl.box.open
  const decrypted = nacl.box.open(
    data,
    nonce,
    phantomPublicKey,
    keypair.secretKey
  );
  
  if (!decrypted) {
    throw new Error('Failed to decrypt signature response');
  }
  
  const decoded = new TextDecoder().decode(decrypted);
  const parsed = JSON.parse(decoded);
  
  // Clear pending action
  clearPendingAction();
  
  return {
    signature: parsed.signature,
    publicKey: session.publicKey
  };
}

// Clear URL parameters after processing
export function clearPhantomParams() {
  const url = new URL(window.location.href);
  
  // Clear query params
  url.searchParams.delete('phantom_action');
  url.searchParams.delete('data');
  url.searchParams.delete('nonce');
  url.searchParams.delete('phantom_encryption_public_key');
  url.searchParams.delete('errorCode');
  url.searchParams.delete('errorMessage');
  
  // Clear hash if it contains phantom params
  if (url.hash && url.hash.includes('phantom_action')) {
    url.hash = '';
  }
  
  window.history.replaceState({}, '', url.toString());
}

// Check if we're returning from Phantom
export function hasPhantomCallback() {
  const url = new URL(window.location.href);
  // Check both query params and hash params (Phantom may use either)
  const hasQueryParam = url.searchParams.has('phantom_action');
  
  // Also check hash for phantom params
  let hasHashParam = false;
  if (url.hash && url.hash.length > 1) {
    const hashParams = new URLSearchParams(url.hash.slice(1));
    hasHashParam = hashParams.has('phantom_action');
  }
  
  console.log('[Phantom Mobile] hasQueryParam:', hasQueryParam, 'hasHashParam:', hasHashParam);
  console.log('[Phantom Mobile] Full URL:', url.toString());
  
  return hasQueryParam || hasHashParam;
}

// Get mobile session
export function getMobileSession() {
  return loadMobileSession();
}

// Clear mobile session
export function clearMobileSessionData() {
  clearMobileSession();
  clearPendingAction();
}

// Get pending action
export function getPendingAction() {
  return loadPendingAction();
}

// Initiate mobile connect flow (with optional challenge for secure auth)
export function initiateMobileConnect(challenge = null) {
  const url = buildConnectUrl(challenge);
  console.log('[Phantom Mobile] Initiating connect with URL:', url);
  window.location.href = url;
}

// Initiate mobile sign flow
export function initiateMobileSign(message) {
  const url = buildSignMessageUrl(message);
  window.location.href = url;
}

// Simple approach: just redirect to Phantom browser (fallback)
export function redirectToPhantomBrowser() {
  const target = encodeURIComponent(window.location.href);
  window.location.href = `https://phantom.app/ul/browse/${target}`;
}
