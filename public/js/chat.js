import nacl from "https://cdn.skypack.dev/tweetnacl@1.0.3?min";

// Audio Calls modules
import { callManager, CallState } from './call/call-manager.js';
import { callUI } from './call/call-ui.js';

// Make callManager available globally for incoming call notifications
window.callManager = callManager;

// Base58 alphabet (same as Bitcoin/Solana)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(str) {
  if (!str || str.length === 0) return new Uint8Array(0);
  
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const index = BASE58_ALPHABET.indexOf(str[i]);
    if (index === -1) throw new Error('Invalid base58 character');
    
    let carry = index;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  
  // Handle leading zeros
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    bytes.push(0);
  }
  
  return new Uint8Array(bytes.reverse());
}

function encodeBase58(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return '';
  
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

// Hash data for signing using SHA-256
async function hashData(data) {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  return new Uint8Array(hashBuffer);
}

// ============================================
// Backup encryption/decryption with password
// Uses PBKDF2 for key derivation + AES-GCM
// ============================================

const BACKUP_ENCRYPTION_VERSION = 1;
const PBKDF2_ITERATIONS = 100000;

async function deriveKeyFromPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Helper: Uint8Array to base64 (handles large arrays)
function uint8ArrayToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper: base64 to Uint8Array
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function encryptBackupWithPassword(data, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassword(password, salt);
  
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(JSON.stringify(data));
  
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );
  
  // Combine: version (1 byte) + salt (16 bytes) + iv (12 bytes) + ciphertext
  const combined = new Uint8Array(1 + salt.length + iv.length + ciphertext.byteLength);
  combined[0] = BACKUP_ENCRYPTION_VERSION;
  combined.set(salt, 1);
  combined.set(iv, 1 + salt.length);
  combined.set(new Uint8Array(ciphertext), 1 + salt.length + iv.length);
  
  // Convert to base64 for storage (using helper to avoid stack overflow)
  return uint8ArrayToBase64(combined);
}

async function decryptBackupWithPassword(encryptedBase64, password) {
  try {
    // Decode base64 (using helper to avoid stack overflow)
    const combined = base64ToUint8Array(encryptedBase64);
    
    // Extract components
    const version = combined[0];
    if (version !== BACKUP_ENCRYPTION_VERSION) {
      throw new Error('Unsupported backup encryption version');
    }
    
    const salt = combined.slice(1, 17);
    const iv = combined.slice(17, 29);
    const ciphertext = combined.slice(29);
    
    const key = await deriveKeyFromPassword(password, salt);
    
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(plaintext));
  } catch (error) {
    if (error.name === 'OperationError') {
      throw new Error('WRONG_PASSWORD');
    }
    throw error;
  }
}

function isEncryptedBackup(content) {
  // Encrypted backups start with base64 that decodes to version byte
  // Regular JSON backups start with { or whitespace
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return false;
  }
  try {
    const decoded = atob(trimmed.slice(0, 4));
    return decoded.charCodeAt(0) === BACKUP_ENCRYPTION_VERSION;
  } catch {
    return false;
  }
}

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.91.5/lib/index.browser.esm.js";
import { Buffer } from "buffer";
import { createPopup } from "https://cdn.jsdelivr.net/npm/@picmo/popup-picker@5.8.5/+esm";
import {
  initApp,
  onStateChange,
  requestConnect,
  getWalletPubkey,
  isAuthenticated,
  getCurrentRoute,
  getProviderInstance,
  logout as requestLogout,
  isMobileDevice,
  initiateMobileTransaction,
  hasMobileSession,
  hasPendingMobileSign,
  continueMobileSign,
  clearPendingMobileSign,
} from "./main.js";
import {
  sendMessage,
  pollInbox,
  lookupProfile,
  fetchProfileMe,
  updateNicknameRequest,
  fetchProfileByPubkey,
  ackMessages,
  updateEncryptionKey,
  getSessionToken,
  getSessionDurationMs,
  setSessionDurationMs,
  fetchTokenPreview,
  fetchDexPairPreview,
  fetchLinkPreviewApi,
  saveBackupToCloud,
  loadBackupFromCloud,
  deleteBackupFromCloud,
  uploadVoiceMessage,
  downloadVoiceMessage,
  deleteVoiceMessage,
} from "./api.js";
import { VoiceRecorder, formatDuration, drawWaveform, createWaveformCanvas } from "./voice-recorder.js";
import {
  upsertContact,
  getContact,
  getContacts,
  getMessagesForContact,
  addMessage,
  deleteMessage as removeMessageFromStore,
  updateContact,
  setMessageStatus,
  migrateContactKey,
  getProfile,
  saveProfile,
  updateProfile,
  deleteContact,
  setDatabaseNamespace,
  getEncryptionKeys,
  saveEncryptionKeys,
  getSessionSecret,
  saveSessionSecret,
  deleteSessionSecret as removePersistedSessionSecret,
  exportLocalData,
  importLocalData,
  deleteMessagesForContact,
  updateMessageMeta as updateMessageMetaInDb,
} from "./db.js";

const POLL_LONG_WAIT_MS = 15000;
const POLL_RETRY_DELAY_MS = 1000;
const MAX_MESSAGE_LENGTH = 2000;
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
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
const PROFILE_LOOKUP_COOLDOWN_MS = 5 * 60 * 1000;
const hasWindow = typeof window !== "undefined";
const isLocalhost = hasWindow && ["localhost", "127.0.0.1"].includes(window.location.hostname);
const DEFAULT_SOLANA_RPC = isLocalhost
  ? "https://api.mainnet-beta.solana.com"
  : hasWindow
    ? new URL("/api/solana", window.location.origin).toString()
    : "https://api.mainnet-beta.solana.com";
const PAYMENT_SYSTEM_PREFIX = "__SOLINK_PAYMENT__";
const NICKNAME_CHANGE_PREFIX = "__SOLINK_NICKNAME_CHANGE__";
const SOLANA_EXPLORER_TX = "https://explorer.solana.com/tx/";
const REPLY_PREFIX = "__SOLINK_REPLY__";
const REPLY_DELIMITER = "::";
const REPLY_PREVIEW_LIMIT = 140;
const FORWARD_PREFIX = "__SOLINK_FORWARD__";
const FORWARD_DELIMITER = "::";
const FORWARD_PREVIEW_LIMIT = 140;
const REACTION_PREFIX = "__SOLINK_REACTION__";
const AVAILABLE_REACTIONS = ["🚀", "👍", "❤️", "😂", "😮", "😢"];
const SETTINGS_STORAGE_KEY = "solink_settings_v1";

// Push Notifications
const VAPID_PUBLIC_KEY = "BJoy9eenwraBkfPbPYcMTRV_Rw6z2uYfIPrGgkukwJI06A8zD_tPBec6-eB8dzi13BFxayeS7wZLPgvSvVb7WMY";
const PUSH_ASKED_KEY = "solink_push_asked";
const PUSH_SUBSCRIPTION_KEY = "solink_push_subscription";

// Cross-tab synchronization
const SYNC_CHANNEL_NAME = "solink-sync";
let syncChannel = null;

function initSyncChannel() {
  if (!hasWindow || !("BroadcastChannel" in window)) {
    console.log("[Sync] BroadcastChannel not supported");
    return;
  }
  
  try {
    syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    syncChannel.onmessage = handleSyncMessage;
    console.log("[Sync] Channel initialized");
  } catch (error) {
    console.warn("[Sync] Failed to create channel:", error);
  }
}

// ============================================
// Audio Calls
// ============================================

function initAudioCalls() {
  // Initialize call UI
  callUI.init();
  
  // Subscribe to call manager events
  callManager.on('stateChange', ({ state: callState }) => {
    console.log('[Chat] Call state changed:', callState);
  });
  
  callManager.on('callEnded', async ({ call, reason, duration }) => {
    console.log('[Chat] Call ended:', reason, 'duration:', duration);
    const durationText = duration > 0 ? formatCallDuration(duration) : '';
    
    if (reason === 'rejected') {
      showToast('Call was declined');
    } else if (reason === 'timeout') {
      showToast('No answer');
    } else if (reason === 'error') {
      showToast('Call failed');
    } else if (durationText) {
      showToast(`Call ended (${durationText})`);
    }
    
    // Create call history message in chat
    if (call) {
      const contactKey = call.isOutgoing ? call.calleeId : call.callerId;
      if (contactKey) {
        await createCallHistoryMessage(contactKey, {
          isOutgoing: call.isOutgoing,
          reason,
          duration,
          timestamp: Date.now(),
        });
      }
    }
  });
  
  callManager.on('error', (error) => {
    console.error('[Chat] Call error:', error);
    showToast(error.message || 'Call error');
  });
  
  // Check URL for incoming call parameter
  const urlParams = new URLSearchParams(window.location.search);
  const incomingCallFrom = urlParams.get('call');
  if (incomingCallFrom) {
    // Remove call param from URL
    urlParams.delete('call');
    const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
    window.history.replaceState({}, '', newUrl);
    
    // Handle incoming call when authenticated
    setTimeout(() => {
      if (latestAppState?.isAuthenticated) {
        handleIncomingCallNotification(incomingCallFrom);
      }
    }, 1000);
  }
  
  console.log('[Chat] Audio calls initialized');
}

async function handleIncomingCallNotification(callerPubkey) {
  try {
    // Create room ID (sorted pubkeys)
    const myPubkey = latestAppState?.walletPubkey;
    if (!myPubkey) return;
    
    const roomId = [callerPubkey, myPubkey].sort().join('_');
    
    // Get caller info
    const contact = state.contacts.find(c => c.pubkey === callerPubkey);
    const callerName = contact?.localName || shortenPubkey(callerPubkey, 6);
    
    // Handle as incoming call
    await callManager.handleIncomingCall({
      callId: crypto.randomUUID(),
      callerId: callerPubkey,
      callerName,
      roomId,
    });
  } catch (error) {
    console.error('[Chat] Handle incoming call error:', error);
  }
}

function formatCallDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Create a call history message in chat
 */
async function createCallHistoryMessage(contactKey, callInfo) {
  const { isOutgoing, reason, duration, timestamp } = callInfo;
  
  // Determine call type for display
  let callType = 'call';
  if (duration > 0) {
    callType = isOutgoing ? 'outgoing' : 'incoming';
  } else if (reason === 'rejected') {
    callType = isOutgoing ? 'declined' : 'declined';
  } else if (reason === 'timeout' || reason === 'no_answer') {
    callType = isOutgoing ? 'no_answer' : 'missed';
  } else if (reason === 'cancelled' || reason === 'ended_by_user') {
    callType = isOutgoing ? 'cancelled' : 'missed';
  } else if (reason === 'disconnected' || reason === 'error') {
    callType = 'failed';
  }
  
  const message = {
    id: `call-${timestamp}-${crypto.randomUUID()}`,
    contactKey,
    direction: isOutgoing ? 'out' : 'in',
    text: '',
    timestamp,
    status: 'delivered',
    meta: {
      systemType: 'call',
      call: {
        type: callType,
        isOutgoing,
        duration,
        reason,
      },
    },
  };
  
  await addMessage(message);
  appendMessageToState(contactKey, message);
  
  if (state.activeContactKey === contactKey) {
    renderMessages(contactKey);
  }
  
  renderContactList();
}

function broadcastSync(type, data) {
  if (!syncChannel) return;
  try {
    syncChannel.postMessage({ type, data, timestamp: Date.now() });
  } catch (error) {
    console.warn("[Sync] Broadcast failed:", error);
  }
}

function handleSyncMessage(event) {
  const { type, data } = event.data || {};
  console.log("[Sync] Received:", type);
  
  switch (type) {
    case "MESSAGE_SENT":
      handleSyncMessageSent(data);
      break;
    case "MESSAGE_RECEIVED":
      handleSyncMessageReceived(data);
      break;
    case "MESSAGE_STATUS":
      handleSyncMessageStatus(data);
      break;
    case "REACTION":
      handleSyncReaction(data);
      break;
    case "CONTACT_UPDATE":
      handleSyncContactUpdate(data);
      break;
    case "SCANNER_REPORT":
      handleSyncScannerReport(data);
      break;
  }
}

function handleSyncMessageSent(data) {
  if (!data?.contactKey || !data?.message) return;
  
  // Check if message already exists
  const messages = state.messages.get(data.contactKey) || [];
  const exists = messages.some(m => m.id === data.message.id);
  if (exists) return;
  
  // Add message to state
  appendMessageToState(data.contactKey, data.message);
  
  // Update contact preview
  updateContactPreviewFromMessage(data.contactKey, data.message);
  
  // Re-render if this chat is active
  if (state.activeContactKey === data.contactKey) {
    renderMessages(data.contactKey);
  }
}

function handleSyncMessageReceived(data) {
  if (!data?.contactKey || !data?.message) return;
  
  // Check if message already exists
  const messages = state.messages.get(data.contactKey) || [];
  const exists = messages.some(m => m.id === data.message.id);
  if (exists) return;
  
  // Add message to state
  appendMessageToState(data.contactKey, data.message);
  
  // Update contact preview
  updateContactPreviewFromMessage(data.contactKey, data.message);
  
  // Re-render if this chat is active
  if (state.activeContactKey === data.contactKey) {
    renderMessages(data.contactKey);
  }
}

function handleSyncMessageStatus(data) {
  if (!data?.messageId || !data?.status) return;
  
  // Find and update message status
  for (const [contactKey, messages] of state.messages) {
    const message = messages.find(m => m.id === data.messageId);
    if (message) {
      message.status = data.status;
      if (state.activeContactKey === contactKey) {
        renderMessages(contactKey);
      }
      break;
    }
  }
}

function handleSyncReaction(data) {
  if (!data?.messageId || !data?.emoji || !data?.action) return;
  
  // Find message and update reaction
  for (const [contactKey, messages] of state.messages) {
    const message = messages.find(m => m.id === data.messageId);
    if (message) {
      const reactions = message.meta?.reactions || {};
      
      if (data.action === "add") {
        if (!reactions[data.emoji]) reactions[data.emoji] = [];
        if (!reactions[data.emoji].includes(data.user)) {
          reactions[data.emoji].push(data.user);
        }
      } else if (data.action === "remove") {
        if (reactions[data.emoji]) {
          reactions[data.emoji] = reactions[data.emoji].filter(u => u !== data.user);
          if (reactions[data.emoji].length === 0) {
            delete reactions[data.emoji];
          }
        }
      }
      
      message.meta = { ...(message.meta || {}), reactions };
      
      if (state.activeContactKey === contactKey) {
        renderMessages(contactKey);
      }
      break;
    }
  }
}

function handleSyncContactUpdate(data) {
  if (!data?.contactKey) return;
  
  // Refresh contacts list
  refreshContacts(false);
}

function handleSyncScannerReport(data) {
  if (!data?.message) return;
  
  // Add scanner report to scanner messages
  if (state.activeContactKey === SCANNER_CONTACT_KEY) {
    const messages = state.messages.get(SCANNER_CONTACT_KEY) || [];
    const exists = messages.some(m => m.id === data.message.id);
    if (!exists) {
      appendMessageToState(SCANNER_CONTACT_KEY, data.message);
      renderScannerMessages();
    }
  }
}

// Token Scanner constant (used in CloudSync)
const SCANNER_CONTACT_KEY = "__SOLINK_SCANNER__";

// ============================================
// R2 CLOUD SYNC - Full database backup
// ============================================

const CLOUD_SYNC_ENABLED = true; // Feature flag
const CLOUD_SYNC_DEBOUNCE_MS = 3000; // Debounce sync calls (3 seconds)
let cloudSyncTimer = null; // Single timer for full backup
let cloudSyncPending = false; // Track if sync is pending
let lastCloudSyncTime = 0; // Track last sync time

/**
 * Get deterministic backup encryption key derived from wallet pubkey
 * This is safe because:
 * 1. R2 storage is protected by authentication (session token)
 * 2. Only wallet owner can get session token (requires signing)
 */
async function getBackupEncryptionKey() {
  const walletPubkey = state.currentWallet;
  if (!walletPubkey) {
    console.warn("[CloudSync] No wallet for backup key");
    return null;
  }
  
  // Derive 32-byte key from wallet pubkey (deterministic!)
  const seed = new TextEncoder().encode(`SOLink-Backup-Key-v1-${walletPubkey}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', seed);
  return new Uint8Array(hashBuffer);
}

/**
 * Encrypt full database for cloud storage
 * Uses deterministic key derived from wallet pubkey
 */
async function encryptFullBackup(data) {
  if (!data) return null;
  
  try {
    const secretKey = await getBackupEncryptionKey();
    if (!secretKey) {
      console.warn("[CloudSync] No backup encryption key");
      return null;
    }
    
    const plaintext = JSON.stringify(data);
    const plaintextBytes = new TextEncoder().encode(plaintext);
    
    // Encrypt with NaCl secretbox
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const encrypted = nacl.secretbox(plaintextBytes, nonce, secretKey);
    
    // Combine nonce + encrypted data
    const combined = new Uint8Array(nonce.length + encrypted.length);
    combined.set(nonce);
    combined.set(encrypted, nonce.length);
    
    // Use chunked conversion to avoid stack overflow with large data
    return uint8ArrayToBase64(combined);
  } catch (error) {
    console.error("[CloudSync] Encryption error:", error);
    return null;
  }
}

/**
 * Decrypt full backup from cloud storage
 * Uses deterministic key derived from wallet pubkey
 */
async function decryptFullBackup(encryptedBase64) {
  if (!encryptedBase64) return null;
  
  try {
    const secretKey = await getBackupEncryptionKey();
    if (!secretKey) {
      console.warn("[CloudSync] No backup decryption key");
      return null;
    }
    
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
    const nonce = combined.slice(0, nacl.secretbox.nonceLength);
    const encrypted = combined.slice(nacl.secretbox.nonceLength);
    
    const decrypted = nacl.secretbox.open(encrypted, nonce, secretKey);
    if (!decrypted) {
      console.warn("[CloudSync] Decryption failed - corrupted data?");
      return null;
    }
    
    const plaintext = new TextDecoder().decode(decrypted);
    return JSON.parse(plaintext);
  } catch (error) {
    console.error("[CloudSync] Decryption error:", error);
    return null;
  }
}

/**
 * Schedule a full backup to cloud (debounced)
 */
function scheduleCloudBackup() {
  if (!CLOUD_SYNC_ENABLED) return;
  if (!getSessionToken()) return;
  if (!state.currentWallet) return;
  
  cloudSyncPending = true;
  
  if (cloudSyncTimer) {
    clearTimeout(cloudSyncTimer);
  }
  
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null;
    performFullBackup();
  }, CLOUD_SYNC_DEBOUNCE_MS);
}

/**
 * Collect localStorage settings for backup
 */
function collectLocalStorageSettings() {
  const settings = {};
  try {
    // App settings
    const appSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (appSettings) settings.appSettings = appSettings;
    
    // Push notification preferences
    const pushAsked = localStorage.getItem(PUSH_ASKED_KEY);
    if (pushAsked) settings.pushAsked = pushAsked;
    
    // Session duration
    const sessionDuration = localStorage.getItem('solink.sessionDuration');
    if (sessionDuration) settings.sessionDuration = sessionDuration;
  } catch (e) {
    console.warn("[CloudSync] Error collecting localStorage:", e);
  }
  return settings;
}

/**
 * Restore localStorage settings from backup
 */
function restoreLocalStorageSettings(settings) {
  if (!settings) return;
  try {
    // Restore app settings (sound, etc.)
    if (settings.appSettings) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, settings.appSettings);
      state.settings = JSON.parse(settings.appSettings);
      syncSettingsUI();
      console.log("[CloudSync] App settings restored:", state.settings);
    }
    
    // Restore push notification asked flag
    if (settings.pushAsked) {
      localStorage.setItem(PUSH_ASKED_KEY, settings.pushAsked);
    }
    
    // Restore session duration
    if (settings.sessionDuration) {
      localStorage.setItem('solink.sessionDuration', settings.sessionDuration);
      // Update UI dropdown
      if (ui.settingsSessionDuration) {
        ui.settingsSessionDuration.value = settings.sessionDuration;
      }
      console.log("[CloudSync] Session duration restored:", settings.sessionDuration);
    }
  } catch (e) {
    console.warn("[CloudSync] Error restoring localStorage:", e);
  }
}

/**
 * Perform full backup to cloud
 */
async function performFullBackup() {
  if (!cloudSyncPending) return;
  if (!getSessionToken()) return;
  if (!state.currentWallet) return;
  
  cloudSyncPending = false;
  
  try {
    // Export all local data (reuse existing export function)
    const exportData = await exportLocalData(state.currentWallet);
    
    // Collect localStorage settings
    const localStorageSettings = collectLocalStorageSettings();
    
    // Include ALL messages (including scanner history)
    const backupData = {
      version: 3, // Updated version for settings support
      syncedAt: Date.now(),
      ownerWallet: state.currentWallet,
      contacts: exportData.contacts || [],
      messages: exportData.messages || [], // Include ALL messages including scanner
      profile: exportData.profile || null,
      localStorageSettings, // Settings from localStorage
      // Don't backup encryption keys - they are derived from wallet
    };
    
    // Encrypt
    const encrypted = await encryptFullBackup(backupData);
    if (!encrypted) {
      console.warn("[CloudSync] Failed to encrypt backup");
      return;
    }
    
    // Upload to cloud
    const result = await saveBackupToCloud(encrypted);
    lastCloudSyncTime = Date.now();
    
    const msgCount = backupData.messages.length;
    const contactCount = backupData.contacts.length;
    const scannerMsgs = backupData.messages.filter(m => m.contactKey === SCANNER_CONTACT_KEY).length;
    console.log(`[CloudSync] Backup saved: ${contactCount} contacts, ${msgCount} messages (${scannerMsgs} scanner), ${result.size} bytes`);
  } catch (error) {
    console.warn("[CloudSync] Backup failed:", error.message);
  }
}

/**
 * Restore full backup from cloud (called on first load with empty DB)
 */
async function restoreFromCloudBackup() {
  console.log("[CloudSync] restoreFromCloudBackup called", {
    enabled: CLOUD_SYNC_ENABLED,
    hasToken: !!getSessionToken(),
    wallet: state.currentWallet?.slice(0, 8)
  });
  
  if (!CLOUD_SYNC_ENABLED) {
    console.log("[CloudSync] Sync disabled");
    return false;
  }
  if (!getSessionToken()) {
    console.log("[CloudSync] No session token");
    return false;
  }
  if (!state.currentWallet) {
    console.log("[CloudSync] No wallet");
    return false;
  }
  
  try {
    console.log("[CloudSync] Checking for cloud backup...");
    
    // Check if local DB already has data
    const localContacts = await getContacts();
    if (localContacts && localContacts.length > 0) {
      console.log("[CloudSync] Local DB has data, skipping restore");
      return false;
    }
    
    // Try to load backup from cloud
    const cloudData = await loadBackupFromCloud();
    if (!cloudData?.found || !cloudData.encrypted) {
      console.log("[CloudSync] No cloud backup found");
      return false;
    }
    
    console.log(`[CloudSync] Found cloud backup (${cloudData.size} bytes), decrypting...`);
    
    // Decrypt
    const backup = await decryptFullBackup(cloudData.encrypted);
    if (!backup) {
      console.warn("[CloudSync] Failed to decrypt backup - may be encrypted with old key");
      console.warn("[CloudSync] Send a new message to create fresh backup with new key");
      return false;
    }
    
    console.log("[CloudSync] Backup decrypted successfully");
    
    // Validate backup belongs to this wallet
    if (backup.ownerWallet && backup.ownerWallet !== state.currentWallet) {
      console.warn("[CloudSync] Backup wallet mismatch!");
      return false;
    }
    
    console.log(`[CloudSync] Restoring: ${backup.contacts?.length || 0} contacts, ${backup.messages?.length || 0} messages`);
    
    // Restore contacts
    if (Array.isArray(backup.contacts)) {
      for (const contact of backup.contacts) {
        if (contact?.pubkey) {
          await upsertContact(contact);
        }
      }
    }
    
    // Restore messages
    if (Array.isArray(backup.messages)) {
      for (const message of backup.messages) {
        if (message?.id && message?.contactKey) {
          await addMessage(message);
        }
      }
    }
    
    // Restore profile (but keep encryption key from current session)
    if (backup.profile) {
      const currentProfile = await getProfile();
      await saveProfile({
        ...backup.profile,
        encryptionPublicKey: currentProfile?.encryptionPublicKey || backup.profile?.encryptionPublicKey,
      });
    }
    
    // Restore localStorage settings (v3+)
    if (backup.localStorageSettings) {
      restoreLocalStorageSettings(backup.localStorageSettings);
      console.log("[CloudSync] Settings restored");
    }
    
    console.log("[CloudSync] Restore completed!");
    return true;
  } catch (error) {
    console.warn("[CloudSync] Restore failed:", error.message);
    return false;
  }
}

// Legacy function for compatibility - now schedules full backup
function scheduleChatSync(contactKey) {
  if (contactKey === SCANNER_CONTACT_KEY) return;
  scheduleCloudBackup();
}

// Token Scanner
const SCANNER_API_URL = "https://dfn.wtf/api/http-report";
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SCAN_REPORT_PREFIX = "__SOLINK_SCAN_REPORT__";

function parseScanReportMessage(text) {
  if (!text || typeof text !== "string") return null;
  
  // Check for prefix anywhere in text (may have leading chars after decryption)
  const prefixIndex = text.indexOf(SCAN_REPORT_PREFIX);
  if (prefixIndex === -1) return null;
  
  try {
    const jsonStr = text.slice(prefixIndex + SCAN_REPORT_PREFIX.length);
    const report = JSON.parse(jsonStr);
    console.log("[ScanReport] Parsed successfully:", report.tokenInfo?.name);
    return report;
  } catch (e) {
    console.warn("[ScanReport] Failed to parse:", e);
    return null;
  }
}

const DEFAULT_SETTINGS = Object.freeze({
  soundEnabled: true,
});
const SOLANA_RPC_URL = window.SOLINK_RPC_URL || DEFAULT_SOLANA_RPC;
const solanaConnection = new Connection(SOLANA_RPC_URL, "confirmed");
window.Buffer = window.Buffer || Buffer;

function loadSettingsFromStorage() {
  if (!hasWindow) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = window.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (error) {
    console.warn("Failed to load settings", error);
    return { ...DEFAULT_SETTINGS };
  }
}

const state = {
  profile: null,
  contacts: [],
  messages: new Map(),
  activeContactKey: null,
  filter: "all",
  activeNav: "all",
  sidebarView: "list",
  currentWallet: null,
  contactQuery: "",
  messageQuery: "",
  hasFetchedProfile: false,
  encryptionKeys: null,
  sessionSecrets: new Map(),
  remoteEncryptionKeys: new Map(),
  replyContext: null,
  forwardContext: {
    source: null,
    filter: "",
    selectedTarget: null,
  },
  settings: loadSettingsFromStorage(),
  // Voice recording state
  voiceRecorder: null,
  isRecordingVoice: false,
  voiceRecordingDuration: 0,
};

const ui = {
  navButtons: [],
};

// PWA Install Prompt
let deferredInstallPrompt = null;

const contactProfileLookups = new Map();
const contactProfileCooldown = new Map();

let latestAppState = null;
let statusResetTimer = null;
let toastTimer = null;
let pollLoopShouldRun = false;
let pollLoopPromise = null;
let pollAbortController = null;
let emojiPicker = null;
let isPaymentSubmitting = false;
const messageMenuState = {
  messageId: null,
  direction: "in",
};

function sanitizeNamespace(value) {
  if (!value) return "guest";
  return String(value).replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "guest";
}

function deriveWorkspaceNamespace(pubkey) {
  if (!pubkey) return "guest";
  return `wallet-${sanitizeNamespace(pubkey).slice(0, 32)}`;
}

async function loadWorkspace(walletPubkey) {
  const namespace = deriveWorkspaceNamespace(walletPubkey);
  setDatabaseNamespace(namespace);
  state.currentWallet = walletPubkey || null;
  state.profile = null;
  state.contacts = [];
  state.messages = new Map();
  state.activeContactKey = null;
  state.contactQuery = "";
  state.messageQuery = "";
  state.hasFetchedProfile = false;
  state.sessionSecrets.clear();
  state.remoteEncryptionKeys.clear();
  state.encryptionKeys = null; // Clear encryption keys for new wallet
  contactProfileLookups.clear();
  contactProfileCooldown.clear();
  clearChatView();
  clearReplyContext();
  hideForwardModal();
  state.forwardContext = { source: null, filter: "", selectedTarget: null };
  updatePaymentRecipient(null);
  renderContactList();
  await initializeProfile();
  await refreshContacts();
}

function cacheDom() {
  ui.navButtons = Array.from(document.querySelectorAll("[data-nav]"));
  ui.navReconnect = document.querySelector("[data-action=\"reconnect-wallet\"]");
  ui.reconnectSettingsBtn = document.querySelector("[data-action=\"reconnect-settings\"]");
  ui.navInstall = document.querySelector("[data-action=\"install-app\"]");
  ui.installAppOption = document.querySelector("[data-role=\"install-app-option\"]");
  ui.installAppSettingsBtn = document.querySelector("[data-action=\"install-app-settings\"]");
  ui.connectOverlay = document.querySelector("[data-role=\"connect-overlay\"]");
  ui.overlayConnectButton = document.querySelector("[data-role=\"connect-overlay\"] [data-action=\"connect-wallet\"]");
  ui.connectPanel = document.querySelector("[data-role=\"connect-panel\"]");
  ui.continueSignPanel = document.querySelector("[data-role=\"continue-sign-panel\"]");
  ui.continueSignButton = document.querySelector("[data-action=\"continue-sign\"]");
  ui.cancelSignButton = document.querySelector("[data-action=\"cancel-sign\"]");

  ui.sidebar = document.querySelector(".list-column");
  ui.sidebarDefault = document.querySelector("[data-role=\"sidebar-default\"]");
  ui.chatList = document.querySelector("[data-role=\"chat-list\"]");
  ui.searchInput = document.querySelector("[data-role=\"search-input\"]");
  ui.searchForm = document.querySelector("[data-role=\"search-form\"]");
  ui.newChatButton = document.querySelector("[data-action=\"new-chat\"]");

  ui.profileAvatar = document.querySelector("[data-role=\"profile-avatar\"]");
  ui.profileNickname = document.querySelector("[data-role=\"profile-nickname\"]");
  ui.profileWallet = document.querySelector("[data-role=\"profile-wallet\"]");
  ui.profileSettingsPanel = document.querySelector("[data-role=\"profile-panel\"]");
  ui.profileSettingsForm = document.querySelector("[data-role=\"profile-form\"]");
  ui.profileSettingsInput = document.querySelector("[data-role=\"profile-nickname-input\"]");
  ui.profileSettingsHint = document.querySelector("[data-role=\"profile-nickname-hint\"]");
  ui.profilePanelAvatar = document.querySelector("[data-role=\"profile-panel-avatar\"]");
  ui.profilePanelName = document.querySelector("[data-role=\"profile-panel-name\"]");
  ui.profilePanelWallet = document.querySelector("[data-role=\"profile-panel-wallet\"]");
  ui.settingsPanel = document.querySelector("[data-role=\"settings-panel\"]");
  ui.settingsSoundToggle = document.querySelector("[data-role=\"settings-sound-toggle\"]");
  ui.settingsSessionDuration = document.querySelector("[data-role=\"settings-session-duration\"]");
  ui.exportDataButton = document.querySelector("[data-action=\"export-data\"]");
  ui.importDataButton = document.querySelector("[data-action=\"import-data\"]");
  ui.importFileInput = document.querySelector("[data-role=\"import-file\"]");
  ui.logoutButton = document.querySelector("[data-action=\"logout\"]");

  ui.statusIndicator = document.querySelector("[data-role=\"connection-indicator\"]");
  ui.statusLabel = document.querySelector("[data-role=\"status\"]");

  ui.chatAvatar = document.querySelector("[data-role=\"chat-avatar\"]");
  ui.chatName = document.querySelector("[data-role=\"chat-name\"]");
  ui.chatStatus = document.querySelector("[data-role=\"chat-status\"]");
  ui.messageSearchInput = document.querySelector("[data-role=\"message-search-input\"]");
  ui.chatHeaderMain = document.querySelector(".chat-column__contact");

  ui.messageTimeline = document.querySelector("[data-role=\"message-list\"]");
  ui.emptyState = document.querySelector("[data-role=\"empty-state\"]");
  ui.messageInput = document.querySelector("[data-role=\"message-input\"]");
  ui.charCounter = document.querySelector('[data-role="char-counter"]');
  ui.sendButton = document.querySelector("[data-action=\"send-message\"]");
  ui.emojiButton = document.querySelector("[data-action=\"toggle-emoji\"]");
  ui.composer = document.querySelector("[data-role=\"composer\"]");
  ui.replyPreview = document.querySelector("[data-role=\"reply-preview\"]");
  ui.replyAuthor = document.querySelector("[data-role=\"reply-author\"]");
  ui.replyText = document.querySelector("[data-role=\"reply-text\"]");
  ui.replyCancel = document.querySelector("[data-action=\"cancel-reply\"]");
  ui.messageMenu = document.querySelector("[data-role=\"message-menu\"]");
  ui.messageMenuReply = document.querySelector("[data-action=\"message-reply\"]");
  ui.messageMenuForward = document.querySelector("[data-action=\"message-forward\"]");
  ui.messageMenuDelete = document.querySelector("[data-action=\"message-delete\"]");
  ui.forwardModal = document.querySelector("[data-role=\"forward-modal\"]");
  ui.forwardSearch = document.querySelector("[data-role=\"forward-search\"]");
  ui.forwardList = document.querySelector("[data-role=\"forward-list\"]");
  ui.forwardSubtitle = document.querySelector("[data-role=\"forward-subtitle\"]");
  ui.forwardCloseButtons = Array.from(document.querySelectorAll("[data-action=\"close-forward\"]"));
  ui.forwardConfirmButton = document.querySelector("[data-action=\"confirm-forward\"]");
  ui.forwardSelection = document.querySelector("[data-role=\"forward-selection\"]");
  ui.forwardSelectionName = document.querySelector("[data-role=\"forward-selection-name\"]");

  ui.infoPanel = document.querySelector("[data-role=\"info-panel\"]");
  ui.scannerPanel = document.querySelector("[data-role=\"scanner-panel\"]");
  ui.infoAvatar = document.querySelector("[data-role=\"info-avatar\"]");
  ui.infoName = document.querySelector("[data-role=\"info-name\"]");
  ui.infoPubkey = document.querySelector("[data-role=\"info-pubkey\"]");
  ui.infoMessageCount = document.querySelector("[data-role=\"info-message-count\"]");
  ui.infoFirstSeen = document.querySelector("[data-role=\"info-first-seen\"]");
  ui.copyContactLinkButton = document.querySelector("[data-action=\"copy-contact-link\"]");
  ui.clearChatButton = document.querySelector("[data-action=\"clear-chat\"]");
  ui.removeContactButton = document.querySelector("[data-action=\"remove-contact\"]");
  ui.toggleFavoriteButton = document.querySelector("[data-action=\"toggle-favorite\"]");
  ui.saveContactButton = document.querySelector("[data-action=\"toggle-save-contact\"]");
  ui.toggleInfoButton = document.querySelector("[data-action=\"toggle-info\"]");
  ui.paymentAmount = document.querySelector("[data-role=\"payment-amount\"]");
  ui.paymentToken = document.querySelector("[data-role=\"payment-token\"]");
  ui.paymentRecipient = document.querySelector("[data-role=\"payment-recipient\"]");
  ui.paymentSendButton = document.querySelector("[data-action=\"send-payment\"]");
  ui.scannerPasteBtn = document.querySelector("[data-action=\"scanner-paste\"]");
  ui.scannerClearBtn = document.querySelector("[data-action=\"scanner-clear\"]");
  ui.scannerOpenDfnBtn = document.querySelector("[data-action=\"scanner-open-dfn\"]");

  // Audio call button
  ui.callButton = document.querySelector("[data-action=\"start-call\"]");

  ui.onboarding = document.querySelector("[data-role=\"onboarding\"]");
  ui.nicknameForm = document.querySelector("[data-role=\"nickname-form\"]");
  ui.nicknameInput = document.querySelector("[data-role=\"nickname-input\"]");
  ui.nicknameHint = document.querySelector("[data-role=\"nickname-hint\"]");
  ui.onboardingShareLink = document.querySelector("[data-role=\"onboarding-share-link\"]");
  ui.copyOnboardingLink = document.querySelector("[data-action=\"copy-onboarding-link\"]");
  ui.finishOnboarding = document.querySelector("[data-action=\"finish-onboarding\"]");
  ui.closeOnboarding = document.querySelector("[data-action=\"close-onboarding\"]");

  ui.toast = document.querySelector("[data-role=\"toast\"]");
  ui.notificationAudio = document.querySelector("[data-role=\"notification-sound\"]");
  ui.closeChatButton = document.querySelector("[data-action=\"close-chat\"]");

  // Voice recording elements
  ui.voiceRecordBtn = document.querySelector(".composer__voice-btn");
  ui.voiceRecordingPanel = document.querySelector(".voice-recording");
  ui.voiceRecordingCancel = document.querySelector(".voice-recording__cancel");
  ui.voiceRecordingSend = document.querySelector(".voice-recording__send");
  ui.voiceRecordingTime = document.querySelector(".voice-recording__time");
  ui.voiceRecordingWaveform = document.querySelector(".voice-recording__waveform");

  syncSettingsUI();
  updatePaymentControls();
}

function persistSettings() {
  if (!hasWindow) {
    return;
  }
  try {
    window.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings));
  } catch (error) {
    console.warn("Failed to persist settings", error);
  }
}

// =====================
// Push Notifications
// =====================

let pushUI = {
  modal: null,
  backdrop: null,
  toggle: null,
  enableBtn: null,
  laterBtn: null,
};

function initPushUI() {
  pushUI.modal = document.querySelector("[data-role=\"push-modal\"]");
  pushUI.backdrop = pushUI.modal?.querySelector(".push-modal__backdrop");
  pushUI.toggle = document.querySelector("[data-role=\"push-toggle\"]");
  pushUI.enableBtn = document.querySelector("[data-action=\"push-enable\"]");
  pushUI.laterBtn = document.querySelector("[data-action=\"push-later\"]");
  
  // Event listeners
  pushUI.enableBtn?.addEventListener("click", handlePushEnable);
  pushUI.laterBtn?.addEventListener("click", handlePushLater);
  pushUI.backdrop?.addEventListener("click", handlePushLater);
  pushUI.toggle?.addEventListener("change", handlePushToggle);
}

function isPushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function registerServiceWorker() {
  if (!isPushSupported()) {
    console.log("[Push] Not supported in this browser");
    return null;
  }
  
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    console.log("[Push] Service Worker registered:", registration.scope);
    return registration;
  } catch (error) {
    console.error("[Push] Service Worker registration failed:", error);
    return null;
  }
}

async function getPushSubscription() {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function subscribeToPush() {
  try {
    console.log("[Push] Starting subscription process...");
    
    const registration = await navigator.serviceWorker.ready;
    console.log("[Push] Service Worker ready:", registration);
    
    // Convert VAPID key to Uint8Array
    const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
    console.log("[Push] VAPID key converted, length:", applicationServerKey.length);
    
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
    
    console.log("[Push] Subscribed:", subscription);
    console.log("[Push] Subscription endpoint:", subscription.endpoint);
    
    // Save subscription locally
    localStorage.setItem(PUSH_SUBSCRIPTION_KEY, JSON.stringify(subscription));
    console.log("[Push] Saved to localStorage");
    
    // Send subscription to server
    await sendSubscriptionToServer(subscription);
    
    return subscription;
  } catch (error) {
    console.error("[Push] Subscription failed:", error);
    console.error("[Push] Error name:", error.name);
    console.error("[Push] Error message:", error.message);
    return null;
  }
}

async function unsubscribeFromPush() {
  try {
    const subscription = await getPushSubscription();
    if (subscription) {
      await subscription.unsubscribe();
      console.log("[Push] Unsubscribed");
      
      // Remove from server
      await removeSubscriptionFromServer();
      
      // Remove local storage
      localStorage.removeItem(PUSH_SUBSCRIPTION_KEY);
    }
    return true;
  } catch (error) {
    console.error("[Push] Unsubscribe failed:", error);
    return false;
  }
}

async function sendSubscriptionToServer(subscription) {
  console.log("[Push] Sending subscription to server...");
  console.log("[Push] Profile pubkey:", state.profile?.pubkey);
  
  if (!state.profile?.pubkey) {
    console.warn("[Push] No pubkey, cannot send subscription");
    return;
  }
  
  try {
    const payload = {
      pubkey: state.profile.pubkey,
      subscription: subscription.toJSON()
    };
    console.log("[Push] Request payload:", JSON.stringify(payload).slice(0, 200) + "...");
    
    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    console.log("[Push] Server response status:", response.status);
    
    if (!response.ok) {
      const text = await response.text();
      console.error("[Push] Server error response:", text);
      throw new Error(`Server responded ${response.status}: ${text}`);
    }
    
    const result = await response.json();
    console.log("[Push] Server response:", result);
    console.log("[Push] Subscription sent to server successfully!");
  } catch (error) {
    console.error("[Push] Failed to send subscription to server:", error);
  }
}

async function removeSubscriptionFromServer() {
  if (!state.profile?.pubkey) return;
  
  try {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pubkey: state.profile.pubkey
      })
    });
    console.log("[Push] Subscription removed from server");
  } catch (error) {
    console.error("[Push] Failed to remove subscription:", error);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function showPushModal() {
  if (!pushUI.modal) return;
  pushUI.modal.hidden = false;
  requestAnimationFrame(() => {
    pushUI.modal.classList.add("is-visible");
  });
}

function hidePushModal() {
  if (!pushUI.modal) return;
  pushUI.modal.classList.remove("is-visible");
  setTimeout(() => {
    pushUI.modal.hidden = true;
  }, 250);
}

async function handlePushEnable() {
  hidePushModal();
  localStorage.setItem(PUSH_ASKED_KEY, "true");
  
  // Request notification permission
  const permission = await Notification.requestPermission();
  
  if (permission === "granted") {
    const subscription = await subscribeToPush();
    if (subscription) {
      showToast("Notifications enabled!");
      syncPushToggle();
    } else {
      showToast("Failed to enable notifications");
    }
  } else if (permission === "denied") {
    showToast("Notifications blocked. Enable in browser settings.");
  }
  
  syncPushToggle();
}

function handlePushLater() {
  hidePushModal();
  localStorage.setItem(PUSH_ASKED_KEY, "true");
}

async function handlePushToggle(event) {
  const enabled = event.target.checked;
  
  if (enabled) {
    // Request permission if not granted
    if (Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        event.target.checked = false;
        if (permission === "denied") {
          showToast("Notifications blocked. Enable in browser settings.");
        }
        return;
      }
    } else if (Notification.permission === "denied") {
      event.target.checked = false;
      showToast("Notifications blocked. Enable in browser settings.");
      return;
    }
    
    const subscription = await subscribeToPush();
    if (subscription) {
      showToast("Notifications enabled");
    } else {
      event.target.checked = false;
      showToast("Failed to enable notifications");
    }
  } else {
    await unsubscribeFromPush();
    showToast("Notifications disabled");
  }
}

async function syncPushToggle() {
  if (!pushUI.toggle || !isPushSupported()) {
    // Hide option if not supported
    const option = document.querySelector("[data-role=\"push-notifications-option\"]");
    if (option && !isPushSupported()) {
      option.style.display = "none";
    }
    return;
  }
  
  const subscription = await getPushSubscription();
  pushUI.toggle.checked = !!subscription && Notification.permission === "granted";
}

async function checkPushPrompt() {
  if (!isPushSupported()) return;
  
  // Don't show if already asked
  if (localStorage.getItem(PUSH_ASKED_KEY)) return;
  
  // Don't show if already subscribed
  const subscription = await getPushSubscription();
  if (subscription) return;
  
  // Don't show if permission already denied
  if (Notification.permission === "denied") return;
  
  // Show modal after a short delay
  setTimeout(showPushModal, 2000);
}

function updateSettings(partial) {
  state.settings = {
    ...state.settings,
    ...partial,
  };
  persistSettings();
  syncSettingsUI();
  scheduleCloudBackup(); // Sync settings to cloud
}

function syncSettingsUI() {
  if (ui.settingsSoundToggle) {
    ui.settingsSoundToggle.checked = Boolean(state.settings?.soundEnabled);
  }
}

function setActiveNav(target) {
  state.activeNav = target;
  ui.navButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.nav === target);
  });
}

function setSidebarView(view) {
  state.sidebarView = view;
  const showList = view === "list";
  const showProfile = view === "profile";
  const showSettings = view === "settings";
  if (ui.sidebarDefault) {
    ui.sidebarDefault.hidden = !showList;
  }
  if (ui.profileSettingsPanel) {
    ui.profileSettingsPanel.hidden = !showProfile;
  }
  if (ui.settingsPanel) {
    ui.settingsPanel.hidden = !showSettings;
  }
}

function openProfileSettingsView() {
  setActiveNav("profile");
  setSidebarView("profile");
  updateProfilePanel();
  if (ui.profileSettingsHint) {
    setTextContent(ui.profileSettingsHint, "");
  }
  if (ui.profileSettingsInput) {
    ui.profileSettingsInput.value = state.profile?.nickname || "";
    requestAnimationFrame(() => ui.profileSettingsInput?.focus());
  }
}

function openSettingsView() {
  setActiveNav("settings");
  setSidebarView("settings");
  syncSettingsUI();
}

// =====================
// TOKEN SCANNER
// =====================

async function openScannerChat() {
  setActiveNav("scanner");
  setSidebarView("list");
  
  // Set scanner as active contact
  state.activeContactKey = SCANNER_CONTACT_KEY;
  
  // Load scanner messages from IndexedDB if not in memory
  if (!state.messages.has(SCANNER_CONTACT_KEY) || state.messages.get(SCANNER_CONTACT_KEY).length === 0) {
    const savedMessages = await getMessagesForContact(SCANNER_CONTACT_KEY);
    if (savedMessages && savedMessages.length > 0) {
      // Restore report objects from JSON string
      const restoredMessages = savedMessages.map(msg => {
        if (msg.meta?.isReport && msg.text && !msg.meta.report) {
          try {
            msg.meta.report = JSON.parse(msg.text);
          } catch (e) {
            console.warn("Failed to parse report JSON", e);
          }
        }
        return msg;
      });
      state.messages.set(SCANNER_CONTACT_KEY, restoredMessages);
    } else {
      state.messages.set(SCANNER_CONTACT_KEY, []);
    }
  }
  
  // Show chat panel, hide empty state and contact info
  if (ui.chatPanel) ui.chatPanel.hidden = false;
  toggleEmptyState(false);
  if (ui.contactInfo) ui.contactInfo.hidden = true;
  
  // Show scanner panel, hide info panel
  if (ui.infoPanel) ui.infoPanel.hidden = true;
  if (ui.scannerPanel) ui.scannerPanel.hidden = false;
  
  // Clear previous messages first
  if (ui.messageTimeline) {
    ui.messageTimeline.innerHTML = "";
  }
  
  // Update header
  updateChatHeader({
    displayName: "Token Scanner",
    subtitle: "Powered by DFN Patrol",
    isScanner: true,
  });
  
  // Show welcome message if first time
  const messages = state.messages.get(SCANNER_CONTACT_KEY);
  if (messages.length === 0) {
    await addScannerSystemMessage("Welcome to Token Scanner! 🔍\n\nPaste any Solana token mint address to get a security report.");
  } else {
    // Render existing messages
    renderScannerMessages();
  }
  
  // Enable composer
  toggleComposer(true);
  // Don't auto-focus on mobile to prevent keyboard popup
  if (window.innerWidth > 720) {
    ui.messageInput?.focus();
  }
  
  // Show chat on mobile
  showMobileChat();
}

function updateChatHeader(opts = {}) {
  // Hide/show mobile info button based on whether it's Scanner
  const mobileInfoBtn = document.querySelector(".mobile-info-btn");
  if (mobileInfoBtn) {
    mobileInfoBtn.style.display = opts.isScanner ? "none" : "";
  }
  
  if (opts.isScanner) {
    if (ui.chatAvatar) {
      ui.chatAvatar.textContent = "🔍";
      ui.chatAvatar.style.fontSize = "1.5rem";
      ui.chatAvatar.style.display = "flex";
      ui.chatAvatar.style.alignItems = "center";
      ui.chatAvatar.style.justifyContent = "center";
    }
    if (ui.chatName) setTextContent(ui.chatName, opts.displayName || "Token Scanner");
    if (ui.chatStatus) setTextContent(ui.chatStatus, opts.subtitle || "");
    return;
  }
  // Reset for normal contacts
  if (ui.chatAvatar) {
    ui.chatAvatar.style.fontSize = "";
    ui.chatAvatar.style.display = "";
    ui.chatAvatar.style.alignItems = "";
    ui.chatAvatar.style.justifyContent = "";
  }
}

async function addScannerSystemMessage(text) {
  const message = {
    id: crypto.randomUUID(),
    contactKey: SCANNER_CONTACT_KEY,
    direction: "in",
    text,
    timestamp: Date.now(),
    status: "delivered",
    meta: { isSystem: true, isScanner: true },
  };
  const messages = state.messages.get(SCANNER_CONTACT_KEY) || [];
  messages.push(message);
  state.messages.set(SCANNER_CONTACT_KEY, messages);
  await addMessage(message);
  renderScannerMessages();
}

async function addScannerUserMessage(text) {
  const message = {
    id: crypto.randomUUID(),
    contactKey: SCANNER_CONTACT_KEY,
    direction: "out",
    text,
    timestamp: Date.now(),
    status: "sent",
    meta: { isScanner: true },
  };
  const messages = state.messages.get(SCANNER_CONTACT_KEY) || [];
  messages.push(message);
  state.messages.set(SCANNER_CONTACT_KEY, messages);
  await addMessage(message);
  renderScannerMessages();
  return message;
}

async function addScannerReportMessage(report) {
  const message = {
    id: crypto.randomUUID(),
    contactKey: SCANNER_CONTACT_KEY,
    direction: "in",
    text: JSON.stringify(report), // Store report as JSON string for persistence
    timestamp: Date.now(),
    status: "delivered",
    meta: { 
      isReport: true,
      isScanner: true,
      report,
    },
  };
  const messages = state.messages.get(SCANNER_CONTACT_KEY) || [];
  messages.push(message);
  state.messages.set(SCANNER_CONTACT_KEY, messages);
  await addMessage(message);
  renderScannerMessages();
  
  // Broadcast to other tabs
  broadcastSync("SCANNER_REPORT", { message });
  
  // Backup scanner history to cloud
  scheduleCloudBackup();
}

async function handleScannerInput(text) {
  const trimmed = text.trim();
  
  // Add user message
  await addScannerUserMessage(trimmed);
  
  // Validate address
  if (!SOLANA_ADDRESS_REGEX.test(trimmed)) {
    await addScannerSystemMessage("❌ Invalid token address. Please paste a valid Solana mint address.");
    return;
  }
  
  // Show loading (don't persist to DB)
  const loadingId = crypto.randomUUID();
  const loadingMsg = {
    id: loadingId,
    contactKey: SCANNER_CONTACT_KEY,
    direction: "in",
    text: "⏳ Scanning token...",
    timestamp: Date.now(),
    status: "delivered",
    meta: { isSystem: true, isLoading: true },
  };
  const messages = state.messages.get(SCANNER_CONTACT_KEY) || [];
  messages.push(loadingMsg);
  state.messages.set(SCANNER_CONTACT_KEY, messages);
  renderScannerMessages();
  
  try {
    const response = await fetch(`${SCANNER_API_URL}?token=${trimmed}`);
    const report = await response.json();
    
    // Remove loading message (not persisted, so just from state)
    const msgList = state.messages.get(SCANNER_CONTACT_KEY) || [];
    const loadingIdx = msgList.findIndex(m => m.id === loadingId);
    if (loadingIdx !== -1) {
      msgList.splice(loadingIdx, 1);
    }
    
    if (report.error) {
      await addScannerSystemMessage(`❌ ${report.error}`);
      return;
    }
    
    await addScannerReportMessage(report);
  } catch (error) {
    console.error("Scanner error:", error);
    // Remove loading message
    const msgList = state.messages.get(SCANNER_CONTACT_KEY) || [];
    const loadingIdx = msgList.findIndex(m => m.id === loadingId);
    if (loadingIdx !== -1) {
      msgList.splice(loadingIdx, 1);
    }
    await addScannerSystemMessage("❌ Failed to scan token. Please try again.");
  }
}

function renderScannerMessages() {
  if (!ui.messageTimeline) return;
  
  // Only render if scanner is active
  if (state.activeContactKey !== SCANNER_CONTACT_KEY) return;
  
  ui.messageTimeline.innerHTML = "";
  
  const messages = state.messages.get(SCANNER_CONTACT_KEY) || [];
  
  for (const message of messages) {
    let bubble;
    if (message.meta?.isReport) {
      bubble = createScannerReportBubble(message.meta.report, message.direction || "in", message.timestamp, message.status);
    } else if (message.meta?.isSystem) {
      bubble = createScannerSystemBubble(message.text);
    } else {
      bubble = createScannerUserBubble(message.text);
    }
    bubble.dataset.messageId = message.id;
    ui.messageTimeline.appendChild(bubble);
  }
  
  // Scroll to bottom
  ui.messageTimeline.scrollTop = ui.messageTimeline.scrollHeight;
}

function createScannerSystemBubble(text) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble--in bubble--scanner-system";
  
  const textEl = document.createElement("div");
  textEl.className = "bubble__text";
  textEl.style.whiteSpace = "pre-wrap";
  textEl.textContent = text;
  
  bubble.appendChild(textEl);
  return bubble;
}

function createScannerUserBubble(text) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble--out";
  
  const textEl = document.createElement("div");
  textEl.className = "bubble__text";
  textEl.textContent = text;
  
  bubble.appendChild(textEl);
  return bubble;
}

function createScannerReportBubble(report, direction = "in", timestamp = null, status = "sent") {
  const bubble = document.createElement("div");
  bubble.className = `bubble bubble--${direction} bubble--scanner-report`;
  
  const card = document.createElement("div");
  card.className = "scanner-report";
  
  // Header
  const header = document.createElement("div");
  header.className = "scanner-report__header";
  
  const logoWrapper = document.createElement("div");
  logoWrapper.className = "scanner-report__logo";
  if (report.tokenInfo?.logoUrl) {
    const logo = document.createElement("img");
    logo.src = report.tokenInfo.logoUrl;
    logo.alt = report.tokenInfo?.symbol || "";
    logo.onerror = () => { logo.style.display = "none"; logoWrapper.textContent = "🪙"; };
    logoWrapper.appendChild(logo);
  } else {
    logoWrapper.textContent = "🪙";
  }
  
  const titleBlock = document.createElement("div");
  titleBlock.className = "scanner-report__title-block";
  
  const name = document.createElement("div");
  name.className = "scanner-report__name";
  name.textContent = report.tokenInfo?.name || "Unknown Token";
  
  const symbol = document.createElement("div");
  symbol.className = "scanner-report__symbol";
  const launchpad = report.security?.launchpad ? ` · ${report.security.launchpad}` : "";
  symbol.textContent = `$${report.tokenInfo?.symbol || "???"}${launchpad}`;
  
  titleBlock.appendChild(name);
  titleBlock.appendChild(symbol);
  
  // Trust Score
  const scoreWrapper = document.createElement("div");
  scoreWrapper.className = "scanner-report__score";
  
  const score = report.trustScore ?? 0;
  let scoreClass = "safe";
  let scoreLabel = "Safe";
  if (score < 30) { scoreClass = "danger"; scoreLabel = "Danger"; }
  else if (score < 50) { scoreClass = "risky"; scoreLabel = "Risky"; }
  else if (score < 70) { scoreClass = "caution"; scoreLabel = "Caution"; }
  
  scoreWrapper.classList.add(`scanner-report__score--${scoreClass}`);
  scoreWrapper.innerHTML = `
    <span class="scanner-report__score-value">${score}%</span>
    <span class="scanner-report__score-label">${scoreLabel}</span>
  `;
  
  header.appendChild(logoWrapper);
  header.appendChild(titleBlock);
  header.appendChild(scoreWrapper);
  card.appendChild(header);
  
  // Market Data
  const market = document.createElement("div");
  market.className = "scanner-report__market";
  
  const price = report.market?.priceUsd ? `$${parseFloat(report.market.priceUsd).toFixed(8)}` : "N/A";
  const change = report.market?.priceChange?.h24;
  const changeStr = change != null ? `(${change >= 0 ? "+" : ""}${change.toFixed(2)}%)` : "";
  const changeClass = change >= 0 ? "positive" : "negative";
  
  const mc = report.market?.marketCap ? formatCompactNumber(report.market.marketCap) : "N/A";
  const liq = report.market?.liquidity ? formatCompactNumber(report.market.liquidity) : "N/A";
  const vol = report.market?.volume24h ? formatCompactNumber(report.market.volume24h) : "N/A";
  
  market.innerHTML = `
    <div class="scanner-report__price">
      <span>Price:</span> <strong>${price}</strong> <span class="scanner-report__change scanner-report__change--${changeClass}">${changeStr}</span>
    </div>
    <div class="scanner-report__stats">
      <span>MC: <strong>${mc}</strong></span>
      <span>Liq: <strong>${liq}</strong></span>
      <span>Vol: <strong>${vol}</strong></span>
    </div>
  `;
  card.appendChild(market);
  
  // Security Flags - Extended
  const flags = document.createElement("div");
  flags.className = "scanner-report__flags";
  
  const sec = report.security || {};
  const flagItems = [
    // Green flags (good)
    { ok: sec.mintRenounced, label: "Mint renounced", warn: "Mint active", show: true },
    { ok: !sec.freezeAuthorityEnabled, label: "No freeze", warn: "Freeze enabled", show: true },
    { ok: sec.lpStatus === "Locked/Burned" || sec.lpStatus === "Burned", label: "LP Locked/Burned", warn: `LP: ${sec.lpStatus || "Unlocked"}`, show: true },
    { ok: !sec.isMutable, label: "Immutable", warn: "Mutable metadata", show: true },
    { ok: sec.noTransferTax, label: "No tax", warn: `Tax: ${sec.transferTax || 0}%`, show: true },
    { ok: sec.isDexVerified, label: "DEX Paid", warn: "DEX Not Paid", show: true },
    { ok: sec.isCto, label: "CTO", warn: null, show: sec.isCto },
    { ok: sec.hasActiveAd, label: "Active Ad", warn: null, show: sec.hasActiveAd },
    // Warnings only (red flags)
    { ok: false, label: null, warn: "Hacker wallet detected!", show: !!sec.hackerFound },
    { ok: (sec.holderConcentration || 0) <= 25, label: `Top10: ${(sec.holderConcentration || 0).toFixed(1)}%`, warn: `Top10: ${(sec.holderConcentration || 0).toFixed(1)}% ⚠️`, show: true },
  ];
  
  for (const f of flagItems) {
    if (!f.show) continue;
    if (f.ok && !f.label) continue;
    if (!f.ok && !f.warn) continue;
    
    const flag = document.createElement("span");
    flag.className = `scanner-report__flag scanner-report__flag--${f.ok ? "ok" : "warn"}`;
    flag.textContent = `${f.ok ? "✅" : "❌"} ${f.ok ? f.label : f.warn}`;
    flags.appendChild(flag);
  }
  card.appendChild(flags);
  
  // Top Holders section
  const concentration = report.security?.holderConcentration?.toFixed(2) || "0";
  if (concentration > 0 || report.distribution?.topHolders?.length) {
    const holders = document.createElement("div");
    holders.className = "scanner-report__section";
    holders.innerHTML = `<div class="scanner-report__section-title">📊 Top 10 Holders: ${concentration}%</div>`;
    
    // Only show holder list if not shared and has data
    if (!report.isShared && report.distribution?.topHolders?.length) {
      const holderList = document.createElement("div");
      holderList.className = "scanner-report__holders";
      
      const allHolders = report.distribution.topHolders.slice(0, 10);
      allHolders.forEach((h, idx) => {
        const row = document.createElement("div");
        row.className = "scanner-report__holder";
        if (idx >= 5) row.classList.add("scanner-report__holder--hidden");
        row.innerHTML = `<span class="scanner-report__holder-idx">${idx + 1}.</span><span class="scanner-report__holder-addr">${shortenAddress(h.address)}</span><span class="scanner-report__holder-pct">${h.percent}%</span>`;
        holderList.appendChild(row);
      });
      
      holders.appendChild(holderList);
      
      // Expand button if more than 5 holders
      if (allHolders.length > 5) {
        const expandBtn = document.createElement("button");
        expandBtn.type = "button";
        expandBtn.className = "scanner-report__expand-btn";
        const extraCount = allHolders.length - 5;
        expandBtn.textContent = `Show ${extraCount} more`;
        expandBtn.dataset.expanded = "false";
        expandBtn.addEventListener("click", () => {
          const isExpanded = expandBtn.dataset.expanded === "true";
          const extraRows = holderList.querySelectorAll(".scanner-report__holder:nth-child(n+6)");
          extraRows.forEach(r => {
            if (isExpanded) {
              r.classList.add("scanner-report__holder--hidden");
            } else {
              r.classList.remove("scanner-report__holder--hidden");
            }
          });
          expandBtn.textContent = isExpanded ? `Show ${extraCount} more` : "Show less";
          expandBtn.dataset.expanded = isExpanded ? "false" : "true";
        });
        holders.appendChild(expandBtn);
      }
    }
    
    card.appendChild(holders);
  }
  
  // Clusters
  const clusterCount = report.clusterCount ?? report.clusters?.length ?? 0;
  if (clusterCount > 0) {
    const clusters = document.createElement("div");
    clusters.className = "scanner-report__section";
    clusters.innerHTML = `<div class="scanner-report__section-title">🔗 Detected Clusters: ${clusterCount}</div>`;
    
    // Only show cluster details if not shared
    if (!report.isShared && report.clusters?.length) {
      const clusterList = document.createElement("div");
      clusterList.className = "scanner-report__clusters";
      
      for (const c of report.clusters.slice(0, 5)) {
        const row = document.createElement("div");
        row.className = "scanner-report__cluster";
        const reason = c.isDeveloperCluster ? "developer" : "same funder";
        row.innerHTML = `<span>${c.addresses?.length || 0} addr</span><span>${(c.supplyPct || 0).toFixed(2)}%</span><span class="scanner-report__cluster-reason">${reason}</span>`;
        clusterList.appendChild(row);
      }
      
      clusters.appendChild(clusterList);
    }
    card.appendChild(clusters);
  }
  
  // Socials
  if (report.socials?.length) {
    const socials = document.createElement("div");
    socials.className = "scanner-report__socials";
    
    for (const s of report.socials.slice(0, 5)) {
      const link = document.createElement("a");
      link.href = s.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "scanner-report__social-link";
      
      let icon = "🔗";
      if (s.type === "twitter") icon = "𝕏";
      else if (s.type === "telegram") icon = "📱";
      else if (s.type === "website") icon = "🌐";
      else if (s.type === "dexscreener") icon = "📊";
      
      link.textContent = `${icon} ${s.label || s.type}`;
      socials.appendChild(link);
    }
    
    card.appendChild(socials);
  }
  
  // Footer
  const footer = document.createElement("div");
  footer.className = "scanner-report__footer";
  
  // Only show Rescan for non-shared reports
  if (!report.isShared) {
    const buttonsRow = document.createElement("div");
    buttonsRow.className = "scanner-report__buttons";
    
    const rescanBtn = document.createElement("button");
    rescanBtn.type = "button";
    rescanBtn.className = "scanner-report__btn";
    rescanBtn.textContent = "Rescan";
    rescanBtn.addEventListener("click", () => {
      const tokenAddr = report.tokenInfo?.address;
      if (tokenAddr) {
        handleScannerInput(tokenAddr);
      }
    });
    
    buttonsRow.appendChild(rescanBtn);
    footer.appendChild(buttonsRow);
  }
  
  const fullReportLink = document.createElement("a");
  fullReportLink.href = `https://dfn.wtf/patrol/${report.tokenInfo?.address || ""}`;
  fullReportLink.target = "_blank";
  fullReportLink.rel = "noopener noreferrer";
  fullReportLink.className = "scanner-report__full-link";
  fullReportLink.textContent = "Full Report ↗";
  
  // Time and status inside card
  const meta = document.createElement("div");
  meta.className = "scanner-report__meta";
  if (timestamp) {
    const timeSpan = document.createElement("span");
    timeSpan.textContent = formatTime(timestamp);
    meta.appendChild(timeSpan);
  }
  if (direction === "out") {
    const statusEl = document.createElement("span");
    statusEl.className = "scanner-report__status";
    statusEl.textContent = status || "sent";
    meta.appendChild(statusEl);
  }
  
  footer.appendChild(fullReportLink);
  footer.appendChild(meta);
  card.appendChild(footer);
  
  bubble.appendChild(card);
  
  return bubble;
}

function formatCompactNumber(num) {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(2) + "K";
  return num.toFixed(2);
}

function shortenAddress(addr) {
  if (!addr || addr.length < 10) return addr || "";
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

function showShareReportModal(report) {
  // Get contacts list
  const contacts = Array.from(state.contacts.values()).filter(c => c.pubkey !== SCANNER_CONTACT_KEY);
  
  if (contacts.length === 0) {
    showToast("No contacts to share with");
    return;
  }
  
  // Create modal
  const modal = document.createElement("div");
  modal.className = "share-modal";
  modal.innerHTML = `
    <div class="share-modal__backdrop"></div>
    <div class="share-modal__content">
      <div class="share-modal__header">
        <h3>Share Report</h3>
        <button type="button" class="share-modal__close">✕</button>
      </div>
      <div class="share-modal__list"></div>
    </div>
  `;
  
  const listEl = modal.querySelector(".share-modal__list");
  
  for (const contact of contacts) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "share-modal__item";
    
    const displayName = contact.localName || contact.displayName || (contact.nickname ? `@${contact.nickname}` : null) || shortenPubkey(contact.pubkey, 6);
    const initial = (displayName.startsWith("@") ? displayName.charAt(1) : displayName.charAt(0)).toUpperCase();
    
    item.innerHTML = `
      <span class="share-modal__avatar">${initial}</span>
      <span class="share-modal__name">${displayName}</span>
    `;
    
    item.addEventListener("click", () => {
      shareReportToContact(report, contact.pubkey);
      modal.remove();
    });
    
    listEl.appendChild(item);
  }
  
  // Close handlers
  modal.querySelector(".share-modal__backdrop").addEventListener("click", () => modal.remove());
  modal.querySelector(".share-modal__close").addEventListener("click", () => modal.remove());
  
  document.body.appendChild(modal);
}

async function shareReportToContact(report, contactPubkey) {
  // Create minimal scan report - only essential data for card display
  const reportPayload = {
    tokenInfo: {
      name: report.tokenInfo?.name,
      symbol: report.tokenInfo?.symbol,
      address: report.tokenInfo?.address,
      logoUrl: report.tokenInfo?.logoUrl,
    },
    trustScore: report.trustScore,
    market: {
      priceUsd: report.market?.priceUsd,
      marketCap: report.market?.marketCap,
      liquidity: report.market?.liquidity,
      volume24h: report.market?.volume24h,
      priceChange: report.market?.priceChange,
    },
    security: {
      launchpad: report.security?.launchpad,
      mintRenounced: report.security?.mintRenounced,
      freezeAuthorityEnabled: report.security?.freezeAuthorityEnabled,
      lpStatus: report.security?.lpStatus,
      isMutable: report.security?.isMutable,
      noTransferTax: report.security?.noTransferTax,
      transferTax: report.security?.transferTax,
      isDexVerified: report.security?.isDexVerified,
      isCto: report.security?.isCto,
      hasActiveAd: report.security?.hasActiveAd,
      holderConcentration: report.security?.holderConcentration,
    },
      // Don't include individual holders for shared reports
    isShared: true,
    // Cluster count only
    clusterCount: (report.clusters || []).length,
    // Only first 3 socials
    socials: (report.socials || []).slice(0, 3).map(s => ({
      type: s.type,
      label: s.label,
      url: s.url,
    })),
  };
  
  const shareText = SCAN_REPORT_PREFIX + JSON.stringify(reportPayload);
  
  // Switch to contact chat with proper navigation update
  setActiveNav("all");
  await setActiveContact(contactPubkey);
  
  // Use handleSendMessage which handles encryption etc
  await handleSendMessage(shareText);
  
  showToast("Report shared!");
}

function bindEvents() {
  ui.navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.nav;
      if (!target) return;
      if (target === "profile") {
        openProfileSettingsView();
        return;
      }
      if (target === "settings") {
        openSettingsView();
        return;
      }
      if (target === "scanner") {
        openScannerChat();
        return;
      }
      if (state.sidebarView !== "list") {
        setSidebarView("list");
      }
      if (state.filter !== target) {
        state.filter = target;
        renderContactList();
      }
      setActiveNav(target);
    });
  });

  const handleProfileCardClick = () => {
    openProfileSettingsView();
  };
  ui.profileAvatar?.addEventListener("click", handleProfileCardClick);
  ui.profileNickname?.addEventListener("click", handleProfileCardClick);

  const handleConnectClick = () => {
    requestConnect().catch((error) => {
      console.warn("Connect error", error);
      showToast("Wallet connection failed");
    });
  };

  const handleReconnectClick = () => {
    requestConnect({ forceReload: true }).catch((error) => {
      console.warn("Reconnect error", error);
      showToast("Wallet connection failed");
    });
  };

  // iOS Safari: continue mobile sign flow
  const handleContinueSignClick = () => {
    console.log('[Chat] Continue sign clicked!');
    try {
      const result = continueMobileSign();
      console.log('[Chat] continueMobileSign returned:', result);
      if (!result) {
        showToast("Sign flow expired. Please try again.");
        toggleConnectOverlay(true, false);
      }
    } catch (error) {
      console.error('[Chat] Error in handleContinueSignClick:', error);
      showToast("Error: " + error.message);
      toggleConnectOverlay(true, false);
    }
  };

  // Cancel mobile sign flow
  const handleCancelSignClick = () => {
    console.log('[Chat] Cancel sign clicked');
    clearPendingMobileSign();
    toggleConnectOverlay(true, false);
  };

  const handleInstallClick = async () => {
    const browser = ui.navInstall?.dataset.browser || ui.installAppOption?.dataset.browser;
    
    // Firefox - show instructions
    if (browser === "firefox") {
      showInstallInstructions("firefox");
      return;
    }
    
    // Safari - show instructions  
    if (browser === "safari") {
      showInstallInstructions("safari");
      return;
    }
    
    // Chromium browsers - use native prompt
    if (!deferredInstallPrompt) {
      showToast("App is already installed");
      return;
    }
    
    // Show the install prompt
    deferredInstallPrompt.prompt();
    
    // Wait for user response
    const { outcome } = await deferredInstallPrompt.userChoice;
    
    if (outcome === "accepted") {
      showToast("SOLink installed successfully! 🎉");
      ui.navInstall?.setAttribute("hidden", "");
      ui.installAppOption?.setAttribute("hidden", "");
    }
    
    // Clear the prompt - can only be used once
    deferredInstallPrompt = null;
  };
  
  const showInstallInstructions = (browser) => {
    const modal = document.createElement("div");
    modal.className = "install-modal";
    
    let instructions = "";
    if (browser === "firefox") {
      instructions = `
        <h3>Firefox doesn't support auto-install</h3>
        <p>But you can create a shortcut manually:</p>
        <ol>
          <li>Click <strong>☰</strong> (menu) in the top right corner</li>
          <li>Select <strong>"More tools"</strong></li>
          <li>Click <strong>"Create shortcut..."</strong></li>
          <li>Check <strong>"Open as window"</strong></li>
        </ol>
        <p class="install-modal__alt">Or use <a href="https://chrome.google.com" target="_blank">Chrome</a> / <a href="https://www.microsoft.com/edge" target="_blank">Edge</a> for auto-install</p>
      `;
    } else if (browser === "safari") {
      instructions = `
        <h3>Install on Safari</h3>
        <p>Add SOLink to your home screen:</p>
        <ol>
          <li>Tap the <strong>Share</strong> button (📤)</li>
          <li>Select <strong>"Add to Home Screen"</strong></li>
          <li>Tap <strong>"Add"</strong></li>
        </ol>
      `;
    }
    
    modal.innerHTML = `
      <div class="install-modal__backdrop"></div>
      <div class="install-modal__content">
        ${instructions}
        <button class="install-modal__close">Got it</button>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close handlers
    const closeModal = () => modal.remove();
    modal.querySelector(".install-modal__backdrop").addEventListener("click", closeModal);
    modal.querySelector(".install-modal__close").addEventListener("click", closeModal);
  };

  ui.navReconnect?.addEventListener("click", handleReconnectClick);
  ui.reconnectSettingsBtn?.addEventListener("click", handleReconnectClick);
  ui.overlayConnectButton?.addEventListener("click", handleConnectClick);
  ui.continueSignButton?.addEventListener("click", handleContinueSignClick);
  ui.cancelSignButton?.addEventListener("click", handleCancelSignClick);
  
  // PWA Install buttons (nav rail + settings)
  ui.navInstall?.addEventListener("click", handleInstallClick);
  ui.installAppSettingsBtn?.addEventListener("click", handleInstallClick);

  ui.searchForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleSearchSubmit();
  });

  ui.searchInput?.addEventListener("input", (event) => {
    state.contactQuery = event.target.value.trim().toLowerCase();
    renderContactList();
  });

  ui.messageSearchInput?.addEventListener("input", (event) => {
    state.messageQuery = event.target.value.trim().toLowerCase();
    renderMessages(state.activeContactKey);
  });

  ui.newChatButton?.addEventListener("click", async () => {
    const query = ui.searchInput?.value?.trim();
    if (!query) {
      showToast("Enter @nickname or a valid public key");
      ui.searchInput?.focus();
      return;
    }
    await handleSearchSubmit();
  });

  ui.copyOnboardingLink?.addEventListener("click", () => {
    copyToClipboard(ui.onboardingShareLink?.value, "Link copied");
  });

  ui.copyContactLinkButton?.addEventListener("click", () => {
    if (!state.activeContactKey) return;
    copyToClipboard(state.activeContactKey, "Wallet address copied");
  });

  ui.clearChatButton?.addEventListener("click", async () => {
    if (!state.activeContactKey) return;
    const confirmed = await showConfirmDialog(
      "Clear chat",
      "Are you sure you want to delete all messages in this chat? This action cannot be undone."
    );
    if (!confirmed) return;
    await clearChatMessages(state.activeContactKey);
    showToast("Chat cleared");
  });

  ui.removeContactButton?.addEventListener("click", async () => {
    if (!state.activeContactKey) return;
    const confirmed = await showConfirmDialog(
      "Remove contact",
      "Remove this contact and all messages? This action cannot be undone."
    );
    if (!confirmed) return;
    await deleteContact(state.activeContactKey);
    state.messages.delete(state.activeContactKey);
    state.activeContactKey = null;
    await refreshContacts();
    clearChatView();
    showToast("Contact removed");
  });

  // Audio call button
  ui.callButton?.addEventListener("click", async () => {
    if (!state.activeContactKey || !latestAppState?.isAuthenticated) return;
    
    try {
      const contact = state.contacts.find(c => c.pubkey === state.activeContactKey);
      const contactName = contact?.localName || shortenPubkey(state.activeContactKey, 6);
      
      showToast("Starting call...");
      await callManager.initiateCall(state.activeContactKey, contactName);
    } catch (error) {
      console.error("[Call] Failed to start call:", error);
      showToast(error.message || "Failed to start call");
    }
  });

  // Scanner panel actions
  ui.scannerPasteBtn?.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && SOLANA_ADDRESS_REGEX.test(text.trim())) {
        await handleScannerInput(text.trim());
      } else {
        showToast("No valid Solana address in clipboard");
      }
    } catch (err) {
      showToast("Unable to read clipboard");
    }
  });

  ui.scannerClearBtn?.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "Clear scanner history",
      "Are you sure you want to delete all scan history? This action cannot be undone."
    );
    if (!confirmed) return;
    await clearChatMessages(SCANNER_CONTACT_KEY);
    state.messages.set(SCANNER_CONTACT_KEY, []);
    if (ui.messageTimeline) ui.messageTimeline.innerHTML = "";
    await addScannerSystemMessage("Welcome to Token Scanner! 🔍\n\nPaste any Solana token mint address to get a security report.");
    showToast("Scanner history cleared");
  });

  ui.scannerOpenDfnBtn?.addEventListener("click", () => {
    window.open("https://dfn.wtf/patrol", "_blank", "noopener,noreferrer");
  });

  ui.toggleFavoriteButton?.addEventListener("click", async () => {
    if (!state.activeContactKey) return;
    const contact = state.contacts.find((item) => item.pubkey === state.activeContactKey);
    if (!contact) return;
    const pinned = !contact.pinned;
    await updateContact(contact.pubkey, { pinned });
    updateContactInState(contact.pubkey, { pinned });
    await refreshContacts(false);
    updateConversationMeta(contact.pubkey);
    setTextContent(ui.toggleFavoriteButton, pinned ? "Unmark favorite" : "Mark favorite");
    showToast(pinned ? "Added to favorites" : "Removed from favorites");
  });

  ui.saveContactButton?.addEventListener("click", async () => {
    if (!state.activeContactKey) return;
    const contact = state.contacts.find((item) => item.pubkey === state.activeContactKey);
    if (!contact) return;
    const nextState = !contact.isSaved;
    await updateContact(state.activeContactKey, { isSaved: nextState, updatedAt: Date.now() });
    updateContactInState(state.activeContactKey, { isSaved: nextState });
    renderContactList();
    updateConversationMeta(state.activeContactKey);
    showToast(nextState ? "Contact saved" : "Removed from contacts");
  });

  ui.toggleInfoButton?.addEventListener("click", () => {
    ui.infoPanel?.classList.toggle("is-visible");
  });

  ui.closeChatButton?.addEventListener("click", handleCloseChat);

  // Voice recording events
  ui.voiceRecordBtn?.addEventListener("click", startVoiceRecording);
  ui.voiceRecordingCancel?.addEventListener("click", cancelVoiceRecording);
  ui.voiceRecordingSend?.addEventListener("click", stopVoiceRecording);
  
  // Mobile back button
  const mobileBackBtn = document.querySelector("[data-action=\"mobile-back\"]");
  mobileBackBtn?.addEventListener("click", handleMobileBack);

  ui.paymentAmount?.addEventListener("input", updatePaymentControls);
  ui.paymentToken?.addEventListener("change", updatePaymentControls);
  ui.paymentSendButton?.addEventListener("click", handleSendPayment);

  ui.messageInput?.addEventListener("input", handleMessageInput);
  ui.messageInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (ui.sendButton?.disabled) return;
      ui.sendButton.click();
    }
  });

  ui.emojiButton?.addEventListener("click", (event) => {
    event.preventDefault();
    if (ui.emojiButton.disabled) return;
    if (!emojiPicker) {
      initializeEmojiPicker();
    }
    toggleEmojiPicker();
  });

  ui.sendButton?.addEventListener("click", async () => {
    const text = ui.messageInput.value.trim();
    if (!text) return;
    ui.messageInput.value = "";
    handleMessageInput();
    await handleSendMessage(text);
  });

  ui.messageTimeline?.addEventListener("contextmenu", handleTimelineContextMenu);
  ui.messageTimeline?.addEventListener("scroll", hideMessageContextMenu);

  // Mobile swipe gestures for reply/delete
  let swipeState = {
    active: false,
    bubble: null,
    messageId: null,
    isOutgoing: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    indicator: null,
  };
  
  const SWIPE_THRESHOLD = 80; // pixels to trigger action
  const SWIPE_MAX = 120; // max swipe distance
  
  function createSwipeIndicator(type) {
    const indicator = document.createElement("div");
    indicator.className = `swipe-indicator swipe-indicator--${type}`;
    indicator.innerHTML = type === "reply" 
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h10a5 5 0 0 1 5 5v6"/><path d="M3 10l6 6"/><path d="M3 10l6-6"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    return indicator;
  }
  
  function updateSwipeVisual(deltaX) {
    if (!swipeState.bubble) return;
    
    const { isOutgoing } = swipeState;
    // For outgoing: swipe left (negative) = reply, swipe right (positive) = delete
    // For incoming: swipe right (positive) = reply, swipe left (negative) = delete
    
    const isReplyDirection = isOutgoing ? deltaX < 0 : deltaX > 0;
    const isDeleteDirection = isOutgoing ? deltaX > 0 : deltaX < 0;
    const absDelta = Math.abs(deltaX);
    
    // Clamp the movement
    const clampedDelta = Math.min(absDelta, SWIPE_MAX) * Math.sign(deltaX);
    swipeState.bubble.style.transform = `translateX(${clampedDelta}px)`;
    
    // Show/update indicator
    if (absDelta > 20) {
      const type = isReplyDirection ? "reply" : "delete";
      if (!swipeState.indicator || swipeState.indicator.dataset.type !== type) {
        swipeState.indicator?.remove();
        swipeState.indicator = createSwipeIndicator(type);
        swipeState.indicator.dataset.type = type;
        swipeState.bubble.parentElement?.appendChild(swipeState.indicator);
      }
      
      // Position indicator
      const progress = Math.min(absDelta / SWIPE_THRESHOLD, 1);
      swipeState.indicator.style.opacity = progress;
      swipeState.indicator.classList.toggle("is-ready", absDelta >= SWIPE_THRESHOLD);
      
      if (isOutgoing) {
        swipeState.indicator.style.right = isReplyDirection ? "auto" : "0";
        swipeState.indicator.style.left = isReplyDirection ? "0" : "auto";
      } else {
        swipeState.indicator.style.left = isReplyDirection ? "auto" : "0";
        swipeState.indicator.style.right = isReplyDirection ? "0" : "auto";
      }
    }
  }
  
  function resetSwipe(triggerAction = false) {
    if (!swipeState.bubble) return;
    
    const deltaX = swipeState.currentX - swipeState.startX;
    const absDelta = Math.abs(deltaX);
    const { isOutgoing, messageId } = swipeState;
    const isReplyDirection = isOutgoing ? deltaX < 0 : deltaX > 0;
    
    // Check if action should be triggered
    if (triggerAction && absDelta >= SWIPE_THRESHOLD && messageId) {
      if (navigator.vibrate) navigator.vibrate(30);
      
      if (isReplyDirection) {
        // Reply
        startReplyToMessage(messageId);
      } else {
        // Delete
        handleDeleteMessage(messageId);
      }
    }
    
    // Animate back
    swipeState.bubble.style.transition = "transform 0.2s ease";
    swipeState.bubble.style.transform = "";
    setTimeout(() => {
      if (swipeState.bubble) {
        swipeState.bubble.style.transition = "";
      }
    }, 200);
    
    // Remove indicator
    swipeState.indicator?.remove();
    
    // Reset state
    swipeState = {
      active: false,
      bubble: null,
      messageId: null,
      isOutgoing: false,
      startX: 0,
      startY: 0,
      currentX: 0,
      indicator: null,
    };
  }
  
  // Long press for context menu + swipe detection
  let longPressTimer = null;
  let longPressTriggered = false;
  
  ui.messageTimeline?.addEventListener("touchstart", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const bubble = target.closest(".bubble");
    if (!bubble || !bubble.dataset.messageId) return;
    
    const touch = event.touches[0];
    swipeState.startX = touch.clientX;
    swipeState.startY = touch.clientY;
    swipeState.bubble = bubble;
    swipeState.messageId = bubble.dataset.messageId;
    swipeState.isOutgoing = bubble.classList.contains("bubble--out");
    
    longPressTriggered = false;
    
    // Prevent text selection
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    
    // Long press timer for context menu
    longPressTimer = setTimeout(() => {
      if (swipeState.bubble && !swipeState.active) {
        longPressTriggered = true;
        const direction = swipeState.isOutgoing ? "out" : "in";
        showMessageContextMenu(touch.clientX, touch.clientY, swipeState.messageId, direction);
        if (navigator.vibrate) navigator.vibrate(50);
        window.getSelection()?.removeAllRanges();
        resetSwipe(false);
      }
    }, 500);
  }, { passive: true });
  
  ui.messageTimeline?.addEventListener("touchmove", (event) => {
    if (!swipeState.bubble || longPressTriggered) return;
    
    const touch = event.touches[0];
    const deltaX = touch.clientX - swipeState.startX;
    const deltaY = touch.clientY - swipeState.startY;
    
    // If vertical scroll is dominant, cancel swipe
    if (!swipeState.active && Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      resetSwipe(false);
      return;
    }
    
    // Start swipe if horizontal movement is significant
    if (!swipeState.active && Math.abs(deltaX) > 10) {
      swipeState.active = true;
      // Cancel long press
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
    
    if (swipeState.active) {
      swipeState.currentX = touch.clientX;
      updateSwipeVisual(deltaX);
    }
  }, { passive: true });
  
  ui.messageTimeline?.addEventListener("touchend", (event) => {
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    
    if (longPressTriggered) {
      event.preventDefault();
      longPressTriggered = false;
      return;
    }
    
    if (swipeState.active) {
      resetSwipe(true);
    } else {
      resetSwipe(false);
    }
  });

  ui.replyCancel?.addEventListener("click", (event) => {
    event.preventDefault();
    clearReplyContext();
  });

  ui.messageMenuReply?.addEventListener("click", () => {
    const targetId = messageMenuState.messageId;
    hideMessageContextMenu();
    if (targetId) {
      startReplyToMessage(targetId);
    }
  });

  ui.messageMenuForward?.addEventListener("click", () => {
    const targetId = messageMenuState.messageId;
    const currentDirection = messageMenuState.direction;
    hideMessageContextMenu();
    if (targetId) {
      showForwardModal(targetId, currentDirection);
    }
  });

  ui.messageMenuDelete?.addEventListener("click", () => {
    const targetId = messageMenuState.messageId;
    hideMessageContextMenu();
    if (targetId) {
      handleDeleteMessage(targetId);
    }
  });

  // Reaction button click - show picker
  ui.messageTimeline?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    
    // Click on reaction add button
    const reactionBtn = target.closest(".bubble__reaction-btn");
    if (reactionBtn) {
      event.stopPropagation();
      const messageId = reactionBtn.dataset.messageId;
      toggleReactionPicker(reactionBtn, messageId);
      return;
    }
    
    // Click on reaction in picker
    const pickerBtn = target.closest(".reaction-picker__btn");
    if (pickerBtn) {
      event.stopPropagation();
      const messageId = pickerBtn.dataset.messageId;
      const emoji = pickerBtn.dataset.emoji;
      hideReactionPicker();
      await sendReaction(messageId, emoji);
      return;
    }
    
    // Click on existing reaction badge (toggle)
    const reactionBadge = target.closest(".reaction-badge");
    if (reactionBadge) {
      event.stopPropagation();
      const messageId = reactionBadge.dataset.messageId;
      const emoji = reactionBadge.dataset.emoji;
      await sendReaction(messageId, emoji);
      return;
    }
    
    // Click elsewhere - hide picker
    hideReactionPicker();
  });

  document.addEventListener("click", (event) => {
    if (!ui.messageMenu || ui.messageMenu.hidden) return;
    const target = event.target;
    if (target instanceof Element && target.closest("[data-role=\"message-menu\"]")) {
      return;
    }
    hideMessageContextMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideMessageContextMenu();
      hideForwardModal();
      hideReactionPicker();
      if (state.replyContext) {
        clearReplyContext();
      }
    }
  });

  window.addEventListener("resize", () => {
    hideMessageContextMenu();
    hideForwardModal();
  });
  document.addEventListener("scroll", () => {
    hideMessageContextMenu();
    hideForwardModal();
  }, true);

  ui.forwardCloseButtons?.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      hideForwardModal();
    });
  });

  ui.forwardModal?.addEventListener("click", (event) => {
    if (event.target === ui.forwardModal) {
      hideForwardModal();
    }
  });

  ui.forwardSearch?.addEventListener("input", (event) => {
    state.forwardContext.filter = event.target.value || "";
    renderForwardList();
  });

  ui.forwardList?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-forward-target]");
    if (!button) return;
    const { forwardTarget } = button.dataset;
    if (forwardTarget) {
      handleForwardRecipientSelect(forwardTarget);
    }
  });

  ui.forwardConfirmButton?.addEventListener("click", async () => {
    const record = state.forwardContext.source;
    const target = state.forwardContext.selectedTarget;
    if (!record || !target) return;
    hideForwardModal();
    await forwardMessageToContact(record, target);
    state.forwardContext.selectedTarget = null;
    updateForwardSelectionUI();
  });

  ui.nicknameForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleNicknameSubmit(ui.nicknameInput, ui.nicknameHint, { closeOnSuccess: true });
  });

  ui.profileSettingsForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleNicknameSubmit(ui.profileSettingsInput, ui.profileSettingsHint);
  });

  ui.settingsSoundToggle?.addEventListener("change", (event) => {
    updateSettings({ soundEnabled: event.target.checked });
  });

  // Initialize session duration select with current value
  if (ui.settingsSessionDuration) {
    ui.settingsSessionDuration.value = String(getSessionDurationMs());
  }

  ui.settingsSessionDuration?.addEventListener("change", (event) => {
    const durationMs = parseInt(event.target.value, 10);
    setSessionDurationMs(durationMs);
    showToast("Session duration updated. Reconnect wallet to apply.");
  });

  ui.logoutButton?.addEventListener("click", handleLogoutClick);

  ui.exportDataButton?.addEventListener("click", handleExportData);
  ui.importDataButton?.addEventListener("click", () => {
    ui.importFileInput?.click();
  });
  ui.importFileInput?.addEventListener("change", handleImportFileChange);

  ui.finishOnboarding?.addEventListener("click", hideOnboarding);
  ui.closeOnboarding?.addEventListener("click", () => {
    // Only allow closing if nickname is set
    if (state.profile?.nickname) {
      hideOnboarding();
    } else {
      showToast("Please set a nickname first");
    }
  });
  
  // Block overlay click when nickname is required
  ui.onboarding?.querySelector(".onboarding__overlay")?.addEventListener("click", () => {
    if (state.profile?.nickname) {
      hideOnboarding();
    }
  });
}

function showToast(message) {
  if (!ui.toast) return;
  setTextContent(ui.toast, message);
  ui.toast.hidden = false;
  ui.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.classList.remove("is-visible");
    setTimeout(() => {
      ui.toast.hidden = true;
    }, 200);
  }, 2400);
}

function showConfirmDialog(title, message) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "confirm-modal";
    modal.innerHTML = `
      <div class="confirm-modal__backdrop"></div>
      <div class="confirm-modal__content">
        <h3 class="confirm-modal__title">${title}</h3>
        <p class="confirm-modal__message">${message}</p>
        <div class="confirm-modal__actions">
          <button type="button" class="confirm-modal__btn confirm-modal__btn--cancel">Cancel</button>
          <button type="button" class="confirm-modal__btn confirm-modal__btn--confirm">Confirm</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    const cleanup = (result) => {
      modal.remove();
      resolve(result);
    };
    
    modal.querySelector(".confirm-modal__backdrop").addEventListener("click", () => cleanup(false));
    modal.querySelector(".confirm-modal__btn--cancel").addEventListener("click", () => cleanup(false));
    modal.querySelector(".confirm-modal__btn--confirm").addEventListener("click", () => cleanup(true));
  });
}

function showPasswordModal({ title, message, confirmText = "Confirm", showConfirm = false }) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "password-modal";
    modal.innerHTML = `
      <div class="password-modal__backdrop"></div>
      <div class="password-modal__content">
        <h3 class="password-modal__title">${title}</h3>
        <p class="password-modal__message">${message}</p>
        <div class="password-modal__field">
          <input type="password" class="password-modal__input" placeholder="Enter password" autocomplete="new-password" />
        </div>
        ${showConfirm ? `
        <div class="password-modal__field">
          <input type="password" class="password-modal__input password-modal__input--confirm" placeholder="Confirm password" autocomplete="new-password" />
        </div>
        ` : ''}
        <p class="password-modal__error" hidden></p>
        <div class="password-modal__actions">
          <button type="button" class="password-modal__btn password-modal__btn--cancel">Cancel</button>
          <button type="button" class="password-modal__btn password-modal__btn--confirm">${confirmText}</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    const input = modal.querySelector(".password-modal__input");
    const confirmInput = modal.querySelector(".password-modal__input--confirm");
    const errorEl = modal.querySelector(".password-modal__error");
    const confirmBtn = modal.querySelector(".password-modal__btn--confirm");
    
    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    };
    
    const cleanup = (result) => {
      modal.remove();
      resolve(result);
    };
    
    const submit = () => {
      const password = input.value;
      if (!password || password.length < 4) {
        showError("Password must be at least 4 characters");
        return;
      }
      if (showConfirm && confirmInput && password !== confirmInput.value) {
        showError("Passwords do not match");
        return;
      }
      cleanup(password);
    };
    
    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (showConfirm && confirmInput) {
          confirmInput.focus();
        } else {
          submit();
        }
      }
      if (e.key === "Escape") cleanup(null);
    });
    
    confirmInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") cleanup(null);
    });
    
    modal.querySelector(".password-modal__backdrop").addEventListener("click", () => cleanup(null));
    modal.querySelector(".password-modal__btn--cancel").addEventListener("click", () => cleanup(null));
    confirmBtn.addEventListener("click", submit);
  });
}

async function clearChatMessages(pubkey) {
  if (!pubkey) return;
  
  // Delete messages from IndexedDB
  await deleteMessagesForContact(pubkey);
  
  // Clear from state
  state.messages.set(pubkey, []);
  
  // Update UI
  renderMessages(pubkey);
  
  // Update contact preview
  const contact = state.contacts.find(c => c.pubkey === pubkey);
  if (contact) {
    await updateContact(pubkey, { lastMessage: null });
    updateContactInState(pubkey, { lastMessage: null });
    renderContactList();
  }
  
  // Update message count in info panel
  updateConversationMeta(pubkey);
}

function copyToClipboard(value, successMessage) {
  if (!value) {
    showToast("Nothing to copy");
    return;
  }
  navigator.clipboard
    .writeText(value)
    .then(() => showToast(successMessage || "Copied"))
    .catch(() => showToast("Clipboard unavailable"));
}

function playNotificationSound() {
  if (!state.settings?.soundEnabled) {
    return;
  }
  const audio = ui.notificationAudio;
  if (!audio) {
    return;
  }
  try {
    audio.currentTime = 0;
  } catch (error) {
    // Ignore if resetting currentTime fails (e.g., not yet loaded)
  }
  audio.play().catch(() => {});
}

function ensureStatusElements() {
  if (!ui.statusLabel) {
    ui.statusLabel = document.querySelector("[data-role=\"status\"]");
  }
  if (!ui.statusIndicator) {
    ui.statusIndicator = document.querySelector("[data-role=\"connection-indicator\"]");
  }
}

function handleSessionExpired() {
  ensureStatusElements();
  setTextContent(ui.statusLabel, "Session expired");
  ui.statusIndicator?.classList.remove("is-online");
  ui.statusIndicator?.classList.add("is-offline");
  showToast("Session expired. Please reconnect wallet.");
  // Stop polling
  pollLoopShouldRun = false;
  if (pollAbortController) {
    pollAbortController.abort();
  }
}

function updateStatusLabel(appState, inlineMessage) {
  ensureStatusElements();
  if (!ui.statusLabel) return;

  if (statusResetTimer) {
    clearTimeout(statusResetTimer);
    statusResetTimer = null;
  }

  if (inlineMessage) {
    setTextContent(ui.statusLabel, inlineMessage);
    statusResetTimer = setTimeout(() => updateStatusLabel(appState), 2200);
    return;
  }

  const sessionValid = Boolean(getSessionToken());

  if (!sessionValid) {
    setTextContent(ui.statusLabel, "Session expired");
    ui.statusIndicator?.classList.remove("is-online");
    ui.statusIndicator?.classList.add("is-offline");
  } else if (!appState?.provider && !appState?.walletPubkey) {
    setTextContent(
      ui.statusLabel,
      appState?.isMobile ? "Tap Connect to open Phantom" : "Install Phantom wallet to continue",
    );
    ui.statusIndicator?.classList.remove("is-online");
    ui.statusIndicator?.classList.add("is-offline");
  } else if (!appState.walletPubkey) {
    setTextContent(ui.statusLabel, "Wallet disconnected");
    ui.statusIndicator?.classList.remove("is-online");
    ui.statusIndicator?.classList.add("is-offline");
  } else if (!appState.isAuthenticated) {
    setTextContent(ui.statusLabel, "Authenticating...");
    ui.statusIndicator?.classList.remove("is-online");
    ui.statusIndicator?.classList.add("is-offline");
  } else {
    setTextContent(ui.statusLabel, "Connected");
    ui.statusIndicator?.classList.add("is-online");
    ui.statusIndicator?.classList.remove("is-offline");
  }
}

function updateShareLink(appState) {
  const link = appState?.walletPubkey ? createShareLink(appState.walletPubkey) : "";
  if (ui.onboardingShareLink) {
    ui.onboardingShareLink.value = link || "Connect wallet to generate link";
  }
  if (ui.copyOnboardingLink) {
    ui.copyOnboardingLink.disabled = !link;
  }
}

function normalizePubkey(value) {
  if (!value) return "";
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
      const lastSegment = url.pathname.split("/").filter(Boolean).pop();
      if (lastSegment && BASE58_REGEX.test(lastSegment)) {
        return lastSegment;
      }
    } catch {
      return "";
    }
  }

  const hashless = raw.replace(/^#\/?/, "");
  if (hashless.startsWith("dm/")) {
    return normalizePubkey(hashless.slice(3));
  }

  const base58Match = raw.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (base58Match && BASE58_REGEX.test(base58Match[0])) {
    return base58Match[0];
  }

  return BASE58_REGEX.test(raw) ? raw : "";
}

function createShareLink(pubkey) {
  if (!pubkey) return "";
  return `${window.location.origin}/#/dm/${pubkey}`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return formatDate(timestamp);
}

function setTextContent(node, value) {
  if (!node) return;
  node.textContent = value;
}

function shortenPubkey(value, visible = 4) {
  if (!value) return "";
  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
}

function getContactDisplayName(pubkey, fallbackShort = true) {
  if (!pubkey) return "";
  const contact = state.contacts.find((item) => item.pubkey === pubkey);
  if (contact?.localName) {
    return contact.localName;
  }
  if (contact?.displayName) {
    return contact.displayName;
  }
  return fallbackShort ? shortenPubkey(pubkey, 6) : pubkey;
}

function getContactAvatarLabel(contact) {
  if (!contact) return "";
  if (contact.localName) return contact.localName;
  if (contact.displayName) return contact.displayName;
  if (contact.nickname) return `@${contact.nickname}`;
  return contact.pubkey || "";
}

function getSelfDisplayName() {
  if (state.profile?.displayName) {
    return state.profile.displayName;
  }
  if (state.profile?.nickname) {
    return `@${state.profile.nickname}`;
  }
  const selfPubkey = latestAppState?.walletPubkey || state.currentWallet;
  return selfPubkey ? shortenPubkey(selfPubkey, 6) : "You";
}

function formatSolAmount(lamports) {
  if (!Number.isFinite(lamports)) return "0";
  const sol = lamports / LAMPORTS_PER_SOL;
  const options = {
    maximumFractionDigits: sol >= 1 ? 2 : 4,
    minimumFractionDigits: sol >= 1 ? 0 : 2,
  };
  return sol.toLocaleString(undefined, options);
}

function buildPaymentSystemText(payload) {
  return `${PAYMENT_SYSTEM_PREFIX}:${JSON.stringify(payload)}`;
}

function buildNicknameChangeText(payload) {
  return `${NICKNAME_CHANGE_PREFIX}:${JSON.stringify(payload)}`;
}

function parseNicknameChangeMessage(text) {
  if (typeof text !== "string") return null;
  const prefix = `${NICKNAME_CHANGE_PREFIX}:`;
  if (!text.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(text.slice(prefix.length));
    if (parsed && parsed.oldName && parsed.newName) {
      return parsed;
    }
  } catch (error) {
    console.warn("Failed to parse nickname change message", error);
  }
  return null;
}

function ensureNicknameChangeMeta(message) {
  if (!message) return null;
  if (message.meta?.systemType === "nickname_change" && message.meta?.nicknameChange) {
    return message.meta.nicknameChange;
  }
  const parsed = parseNicknameChangeMessage(message.text || "");
  if (parsed) {
    message.meta = {
      ...(message.meta || {}),
      systemType: "nickname_change",
      nicknameChange: parsed,
    };
    return parsed;
  }
  return null;
}

function parsePaymentSystemMessage(text) {
  if (typeof text !== "string") return null;
  const prefix = `${PAYMENT_SYSTEM_PREFIX}:`;
  if (!text.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(text.slice(prefix.length));
    if (parsed && Number.isFinite(parsed.lamports) && parsed.from && parsed.to) {
      return parsed;
    }
  } catch (error) {
    console.warn("Failed to parse payment system message", error);
  }
  return null;
}

function ensurePaymentMeta(message) {
  if (!message) return null;
  if (message.meta?.systemType === "payment" && message.meta?.payment) {
    return message.meta.payment;
  }
  const parsed = parsePaymentSystemMessage(message.text || "");
  if (parsed) {
    message.meta = {
      ...(message.meta || {}),
      systemType: "payment",
      payment: parsed,
    };
    return parsed;
  }
  return null;
}

function normalizeNicknameInput(value) {
  if (!value) return "";
  return String(value).trim().replace(/^@+/, "").toLowerCase();
}

function isNicknameQuery(value) {
  const normalized = normalizeNicknameInput(value);
  return Boolean(normalized) && NICKNAME_REGEX.test(normalized);
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes) {
  if (!bytes || !bytes.length) return "";
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (!value) return new Uint8Array();
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

function encryptWithSecret(secretB64, text) {
  if (!secretB64) return null;
  try {
    const shared = base64ToBytes(secretB64);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box.after(textEncoder.encode(text), nonce, shared);
    return {
      ciphertext: bytesToBase64(ciphertext),
      nonce: bytesToBase64(nonce),
      version: 1,
    };
  } catch (error) {
    console.warn("Encryption failed", error);
    return null;
  }
}

function decryptWithSecret(secretB64, ciphertextB64, nonceB64) {
  if (!secretB64 || !ciphertextB64 || !nonceB64) return null;
  try {
    const shared = base64ToBytes(secretB64);
    const ciphertext = base64ToBytes(ciphertextB64);
    const nonce = base64ToBytes(nonceB64);
    const plaintext = nacl.box.open.after(ciphertext, nonce, shared);
    if (!plaintext) return null;
    return textDecoder.decode(plaintext);
  } catch (error) {
    console.warn("Decryption failed", error);
    return null;
  }
}

// ============================================
// VOICE MESSAGE ENCRYPTION
// ============================================

/**
 * Encrypt audio blob for voice message
 * @param {Blob} audioBlob - Audio blob to encrypt
 * @param {string} sessionSecret - Base64 session secret
 * @returns {Promise<{encryptedAudio: string, nonce: string}>}
 */
async function encryptVoiceBlob(audioBlob, sessionSecret) {
  if (!audioBlob || !sessionSecret) return null;
  
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBytes = new Uint8Array(arrayBuffer);
    const shared = base64ToBytes(sessionSecret);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box.after(audioBytes, nonce, shared);
    
    return {
      encryptedAudio: bytesToBase64(encrypted),
      nonce: bytesToBase64(nonce),
    };
  } catch (error) {
    console.error('[Voice] Encryption error:', error);
    return null;
  }
}

/**
 * Decrypt audio data
 * @param {string} encryptedB64 - Base64 encrypted audio
 * @param {string} nonceB64 - Base64 nonce
 * @param {string} sessionSecret - Base64 session secret
 * @param {string} mimeType - Audio MIME type
 * @returns {Promise<Blob|null>}
 */
async function decryptVoiceData(encryptedB64, nonceB64, sessionSecret, mimeType = 'audio/webm') {
  console.log('[Voice] decryptVoiceData called:', {
    hasEncrypted: !!encryptedB64,
    encryptedLen: encryptedB64?.length,
    hasNonce: !!nonceB64,
    nonceLen: nonceB64?.length,
    hasSecret: !!sessionSecret,
  });
  
  if (!encryptedB64 || !nonceB64 || !sessionSecret) {
    console.warn('[Voice] Missing params for decryption');
    return null;
  }
  
  try {
    const shared = base64ToBytes(sessionSecret);
    const encrypted = base64ToBytes(encryptedB64);
    const nonce = base64ToBytes(nonceB64);
    
    console.log('[Voice] Decryption params:', {
      sharedLen: shared.length,
      encryptedLen: encrypted.length,
      nonceLen: nonce.length,
    });
    
    const decrypted = nacl.box.open.after(encrypted, nonce, shared);
    
    if (!decrypted) {
      console.warn('[Voice] nacl.box.open.after returned null - wrong key or corrupted data');
      return null;
    }
    
    console.log('[Voice] Decryption successful, size:', decrypted.length);
    return new Blob([decrypted], { type: mimeType });
  } catch (error) {
    console.error('[Voice] Decryption error:', error);
    return null;
  }
}

/**
 * Send voice message
 * @param {Blob} audioBlob - Recorded audio blob
 * @param {number} duration - Duration in seconds
 * @param {string} mimeType - Audio MIME type
 */
async function handleSendVoice(audioBlob, duration, mimeType, waveform = null) {
  if (!state.activeContactKey || state.activeContactKey === SCANNER_CONTACT_KEY) {
    showToast('Select a chat first');
    return;
  }

  const contactPubkey = state.activeContactKey;
  const messageId = crypto.randomUUID();
  const timestamp = Date.now();
  
  // Ensure waveform has data
  const waveformData = waveform && waveform.length > 0 ? waveform : new Array(50).fill(0.3);

  // Get encryption keys first
  const keys = await ensureEncryptionKeys();
  if (!keys) {
    showToast('Cannot get encryption keys');
    return;
  }
  
  // Force fresh session secret with fresh remote key for encryption
  await resetSessionSecret(contactPubkey);
  const sessionSecret = await ensureSessionSecret(contactPubkey, { force: true, forceFreshKey: true });
  if (!sessionSecret) {
    showToast('Cannot encrypt voice message');
    return;
  }
  
  console.log('[Voice] Sending voice, myPubKey:', keys.publicKey?.slice(0, 20), 'to:', contactPubkey?.slice(0, 8), 'waveform bars:', waveformData?.length);

  // Create optimistic local message
  const localMessage = {
    id: messageId,
    contactKey: contactPubkey,
    direction: 'out',
    text: '',
    timestamp,
    status: 'sending',
    meta: {
      voice: {
        duration,
        mimeType,
        waveform: waveformData,
        loading: true,
      }
    }
  };

  // Add to state and render
  await addMessage(localMessage);
  appendMessageToState(contactPubkey, localMessage);
  renderMessages(contactPubkey);

  try {
    // Encrypt audio
    const encrypted = await encryptVoiceBlob(audioBlob, sessionSecret);
    if (!encrypted) {
      throw new Error('Failed to encrypt voice');
    }

    // Upload to R2
    const uploadResult = await uploadVoiceMessage({
      recipientPubkey: contactPubkey,
      messageId,
      encryptedAudio: encrypted.encryptedAudio,
      duration,
      mimeType,
    });

    if (!uploadResult?.voiceKey) {
      throw new Error('Upload failed');
    }

    // Encrypt text indicator for session key sync (keys already obtained above)
    const textEncrypted = encryptWithSecret(sessionSecret, '🎤 Voice message');

    // Send message with voice metadata
    await sendMessage({
      to: contactPubkey,
      text: '🎤 Voice message',
      ciphertext: textEncrypted?.ciphertext || '',
      nonce: textEncrypted?.nonce || '',
      version: textEncrypted?.version || 1,
      timestamp,
      voiceKey: uploadResult.voiceKey,
      voiceDuration: duration,
      voiceNonce: encrypted.nonce,
      voiceMimeType: mimeType,
      voiceWaveform: JSON.stringify(waveformData), // Send waveform to recipient
      senderEncryptionKey: keys.publicKey,
    });

    // Update message status
    await setMessageStatus(messageId, 'sent');
    
    // Update meta with voiceKey (preserve waveform!)
    await updateMessageMeta(messageId, {
      voice: {
        key: uploadResult.voiceKey,
        duration,
        mimeType,
        waveform: waveformData, // Preserve waveform data
        nonce: encrypted.nonce,
        sessionSecret: sessionSecret, // Save for playback after reload
        loading: false,
      }
    });

    // Update state (preserve waveform and session secret)
    const messages = state.messages.get(contactPubkey) || [];
    const msgIndex = messages.findIndex(m => m.id === messageId);
    if (msgIndex !== -1) {
      messages[msgIndex].status = 'sent';
      messages[msgIndex].meta.voice.key = uploadResult.voiceKey;
      messages[msgIndex].meta.voice.nonce = encrypted.nonce;
      messages[msgIndex].meta.voice.waveform = waveformData;
      messages[msgIndex].meta.voice.sessionSecret = sessionSecret;
      messages[msgIndex].meta.voice.loading = false;
    }
    
    renderMessages(contactPubkey);
    updateContactPreviewFromMessage(contactPubkey, { ...localMessage, text: '🎤 Voice' });
    scheduleChatSync(contactPubkey);

    console.log('[Voice] Sent successfully:', uploadResult.voiceKey);
  } catch (error) {
    console.error('[Voice] Send error:', error);
    await setMessageStatus(messageId, 'failed');
    
    const messages = state.messages.get(contactPubkey) || [];
    const msgIndex = messages.findIndex(m => m.id === messageId);
    if (msgIndex !== -1) {
      messages[msgIndex].status = 'failed';
    }
    
    renderMessages(contactPubkey);
    showToast(error.message || 'Failed to send voice message');
  }
}

// ============================================
// VOICE RECORDING UI
// ============================================

function initVoiceRecorder() {
  if (!navigator.mediaDevices?.getUserMedia) {
    console.warn('[Voice] MediaDevices API not supported');
    if (ui.voiceRecordBtn) ui.voiceRecordBtn.style.display = 'none';
    return;
  }
  
  state.voiceRecorder = new VoiceRecorder();
  state.recordingWaveformBars = []; // Store waveform during recording
  
  state.voiceRecorder.onStart = () => {
    state.isRecordingVoice = true;
    state.recordingWaveformBars = [];
    showVoiceRecordingUI();
  };
  
  state.voiceRecorder.onStop = ({ blob, duration, mimeType, waveform }) => {
    state.isRecordingVoice = false;
    hideVoiceRecordingUI();
    
    if (blob && duration > 0) {
      handleSendVoice(blob, duration, mimeType, waveform);
    }
  };
  
  state.voiceRecorder.onError = (error) => {
    state.isRecordingVoice = false;
    hideVoiceRecordingUI();
    showToast(error.message || 'Recording failed');
  };
  
  state.voiceRecorder.onDurationUpdate = (seconds) => {
    state.voiceRecordingDuration = seconds;
    if (ui.voiceRecordingTime) {
      ui.voiceRecordingTime.textContent = formatDuration(seconds);
    }
  };
  
  state.voiceRecorder.onWaveformUpdate = (level, allData) => {
    state.recordingWaveformBars = allData;
    // Draw real-time waveform during recording
    if (ui.voiceRecordingWaveform) {
      const bars = allData.slice(-50); // Show last 50 samples
      while (bars.length < 50) bars.unshift(0.1); // Pad with minimum
      drawWaveform(ui.voiceRecordingWaveform, bars, 1, '#ff6b6b', 'rgba(255,255,255,0.2)');
    }
  };
}

function showVoiceRecordingUI() {
  if (ui.voiceRecordingPanel) {
    ui.voiceRecordingPanel.hidden = false;
  }
  document.querySelector('.composer')?.classList.add('composer--recording');
}

function hideVoiceRecordingUI() {
  if (ui.voiceRecordingPanel) {
    ui.voiceRecordingPanel.hidden = true;
  }
  if (ui.voiceRecordingTime) {
    ui.voiceRecordingTime.textContent = '0:00';
  }
  document.querySelector('.composer')?.classList.remove('composer--recording');
}

async function startVoiceRecording() {
  if (state.isRecordingVoice) return;
  
  if (!state.activeContactKey || state.activeContactKey === SCANNER_CONTACT_KEY) {
    showToast('Select a chat first');
    return;
  }

  if (!state.voiceRecorder) {
    showToast('Voice recording not available');
    return;
  }
  
  console.log('[Voice] Starting recording...');
  const started = await state.voiceRecorder.start();
  if (!started) {
    console.warn('[Voice] Failed to start recording');
    // Ensure UI is hidden if start failed
    state.isRecordingVoice = false;
    hideVoiceRecordingUI();
  }
}

function stopVoiceRecording() {
  state.voiceRecorder?.stop();
}

function cancelVoiceRecording() {
  state.voiceRecorder?.cancel();
  state.isRecordingVoice = false;
  hideVoiceRecordingUI();
}

function rememberRemoteEncryptionKey(pubkey, key) {
  if (!pubkey || !key) return;
  state.remoteEncryptionKeys.set(pubkey, key);
}

async function fetchRemoteEncryptionKey(pubkey) {
  if (!pubkey) return "";
  try {
    const response = await fetchProfileByPubkey(pubkey);
    const remote = response?.profile;
    if (remote?.encryptionPublicKey) {
      rememberRemoteEncryptionKey(pubkey, remote.encryptionPublicKey);
      return remote.encryptionPublicKey;
    }
  } catch (error) {
    console.warn("Failed to fetch encryption key for contact", pubkey, error);
  }
  return "";
}

async function ensureRemoteEncryptionKey(pubkey, forceFetch = false) {
  if (!pubkey) return "";
  if (!forceFetch && state.remoteEncryptionKeys.has(pubkey)) {
    return state.remoteEncryptionKeys.get(pubkey) || "";
  }
  const fetched = await fetchRemoteEncryptionKey(pubkey);
  return fetched || "";
}

async function ensureSessionSecret(pubkey, options = {}) {
  if (!pubkey) return null;
  const force = Boolean(options.force);
  const forceFreshKey = Boolean(options.forceFreshKey); // Force fetch fresh key from server
  if (!force && state.sessionSecrets.has(pubkey)) {
    return state.sessionSecrets.get(pubkey);
  }
  if (!force) {
    const cached = await getSessionSecret(pubkey);
    if (cached?.secret) {
      state.sessionSecrets.set(pubkey, cached.secret);
      return cached.secret;
    }
  }
  const hintKey = options?.remoteKeyHint || options?.remoteKey;
  if (hintKey) {
    rememberRemoteEncryptionKey(pubkey, hintKey);
  }
  const remoteKey = hintKey || (await ensureRemoteEncryptionKey(pubkey, forceFreshKey));
  if (!remoteKey) {
    console.warn('[Session] No remote key for', pubkey?.slice(0, 8));
    return null;
  }
  const keys = await ensureEncryptionKeys();
  console.log('[Session] Creating secret for', pubkey?.slice(0, 8), {
    myPubKey: keys.publicKey?.slice(0, 20),
    remotePubKey: remoteKey?.slice(0, 20),
  });
  const secretKeyBytes = base64ToBytes(keys.secretKey);
  const remoteKeyBytes = base64ToBytes(remoteKey);
  try {
    const shared = nacl.box.before(remoteKeyBytes, secretKeyBytes);
    const encoded = bytesToBase64(shared);
    state.sessionSecrets.set(pubkey, encoded);
    await saveSessionSecret(pubkey, encoded);
    console.log('[Session] Secret created:', encoded?.slice(0, 20));
    return encoded;
  } catch (error) {
    console.warn("Failed to derive session secret", error);
    return null;
  }
}

async function resetSessionSecret(pubkey) {
  if (!pubkey) return;
  state.sessionSecrets.delete(pubkey);
  await removePersistedSessionSecret(pubkey);
}

function generateAvatarGradient(seed) {
  const hash = hashCode(seed || "solink");
  const hue = Math.abs(hash % 360);
  return `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 36) % 360} 70% 55%))`;
}

function extractAvatarInitial(value) {
  if (!value) return "";
  const normalized = String(value).trim().replace(/^@+/, "");
  if (!normalized) return "";
  for (const char of normalized) {
    if (!char || char === "-" || char === "_" || char === "." || char === " ") {
      continue;
    }
    if (char.toLowerCase() !== char.toUpperCase()) {
      return char.toUpperCase();
    }
    if (!Number.isNaN(Number(char))) {
      return char;
    }
    return char.toUpperCase();
  }
  return normalized[0].toUpperCase();
}

function setAvatar(element, seed, size = 48, label = "") {
  if (!element) return;
  element.style.width = `${size}px`;
  element.style.height = `${size}px`;
  element.style.borderRadius = `${size < 60 ? 16 : 20}px`;
  element.style.background = generateAvatarGradient(seed);
  const initial = extractAvatarInitial(label) || extractAvatarInitial(seed) || "";
  element.textContent = initial;
  element.style.fontSize = `${Math.max(16, Math.round(size * 0.42))}px`;
}

function autoResizeTextarea(element) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 184)}px`;
}

async function ensureContact(pubkeyInput, overrides = {}) {
  const normalized = normalizePubkey(pubkeyInput);
  if (!normalized) return null;

  let existing = await getContact(normalized);
  if (existing) {
    if (overrides && Object.keys(overrides).length) {
      await updateContact(normalized, { ...overrides, updatedAt: Date.now() });
      existing = await getContact(normalized);
    }
    return normalizeContact(existing);
  }

  const payload = normalizeContact({
    pubkey: normalized,
    localName: overrides.localName || "",
    pinned: Boolean(overrides.pinned),
    color: overrides.color || null,
    isSaved: Boolean(overrides.isSaved),
    unreadCount: Number.isFinite(overrides.unreadCount) ? overrides.unreadCount : 0,
    createdAt: overrides.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
  await upsertContact(payload);
  return payload;
}

function normalizeContact(contact) {
  const now = Date.now();
  return {
    pubkey: normalizePubkey(contact.pubkey),
    localName: contact.localName || "",
    pinned: Boolean(contact.pinned),
    color: contact.color || null,
    isSaved: Boolean(contact.isSaved),
    unreadCount: Number.isFinite(contact.unreadCount) ? contact.unreadCount : 0,
    createdAt: contact.createdAt || now,
    updatedAt: contact.updatedAt || now,
    lastMessage: contact.lastMessage || null,
    encryptionPublicKey: contact.encryptionPublicKey || null,
  };
}

function sortByRecentActivity(list) {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    const timeA = a.lastMessage?.timestamp || a.updatedAt || 0;
    const timeB = b.lastMessage?.timestamp || b.updatedAt || 0;
    return timeB - timeA;
  });
}

async function hydrateContactProfile(pubkey, { force = false } = {}) {
  const normalized = normalizePubkey(pubkey);
  if (!normalized) return null;

  const contactInState = state.contacts.find((item) => item.pubkey === normalized);
  if (contactInState?.localName && !force) {
    return contactInState.localName;
  }

  const existingRecord = await getContact(normalized);
  if (existingRecord?.localName && !force) {
    if (!contactInState?.localName) {
      updateContactInState(normalized, { localName: existingRecord.localName });
      renderContactList();
    }
    return existingRecord.localName;
  }

  if (!force) {
    const lastAttempt = contactProfileCooldown.get(normalized) || 0;
    if (Date.now() - lastAttempt < PROFILE_LOOKUP_COOLDOWN_MS) {
      return null;
    }
  }

  if (contactProfileLookups.has(normalized)) {
    return contactProfileLookups.get(normalized);
  }

  const promise = (async () => {
    try {
      contactProfileCooldown.set(normalized, Date.now());
      const response = await fetchProfileByPubkey(normalized);
      const profile = response?.profile;
      const displayName = profile?.displayName || (profile?.nickname ? `@${profile.nickname}` : "");
      const encryptionPublicKey = profile?.encryptionPublicKey || null;
      if (!displayName) {
        return null;
      }

      const existsInState = state.contacts.some((item) => item.pubkey === normalized);
      if (encryptionPublicKey) {
        state.remoteEncryptionKeys.set(normalized, encryptionPublicKey);
      }

      await updateContact(normalized, { localName: displayName, encryptionPublicKey, updatedAt: Date.now() });

      if (existsInState) {
        updateContactInState(normalized, { localName: displayName, encryptionPublicKey });
        renderContactList();
        if (state.activeContactKey === normalized) {
          updateContactHeader();
          updateConversationMeta(normalized);
        }
      } else {
        await refreshContacts(false);
      }

      return displayName;
    } catch (error) {
      console.info("Profile lookup failed", error?.message || error);
      return null;
    } finally {
      contactProfileLookups.delete(normalized);
    }
  })();

  contactProfileLookups.set(normalized, promise);
  return promise;
}

function updateContactInState(pubkey, changes) {
  const index = state.contacts.findIndex((item) => item.pubkey === pubkey);
  if (index === -1) return;
  const merged = normalizeContact({ ...state.contacts[index], ...changes, updatedAt: Date.now() });
  state.contacts[index] = merged;
  state.contacts = sortByRecentActivity(state.contacts);
  renderContactList();
}
async function refreshContacts(shouldUpdateMeta = true) {
  let contacts = await getContacts();
  const migrations = contacts
    .map((contact) => {
      const normalized = normalizePubkey(contact.pubkey);
      if (normalized && normalized !== contact.pubkey) {
        return migrateContactKey(contact.pubkey, normalized);
      }
      return null;
    })
    .filter(Boolean);

  if (migrations.length) {
    await Promise.all(migrations);
    contacts = await getContacts();
  }

  const enhanced = await Promise.all(
    contacts.map(async (contact) => {
      const safeContact = normalizeContact(contact);
      const cachedMessages = state.messages.get(safeContact.pubkey);
      let lastMessage = cachedMessages?.[cachedMessages.length - 1] || null;

      if (!lastMessage) {
        const latestMessages = await getMessagesForContact(safeContact.pubkey, 1);
        lastMessage = latestMessages.at(-1) || null;
      }

      return {
        ...safeContact,
        lastMessage,
        updatedAt: lastMessage?.timestamp || safeContact.updatedAt,
      };
    }),
  );

  state.contacts = sortByRecentActivity(enhanced);
  renderContactList();
  updateContactHeader();
  if (state.activeContactKey && shouldUpdateMeta) {
    updateConversationMeta(state.activeContactKey);
  }
}

function filterContactsList() {
  let contacts = [...state.contacts];

  if (state.filter === "contacts") {
    contacts = contacts.filter((contact) => contact.isSaved);
    contacts.sort((a, b) => {
      const labelA = (a.localName || a.pubkey).toLowerCase();
      const labelB = (b.localName || b.pubkey).toLowerCase();
      return labelA.localeCompare(labelB);
    });
  } else {
    contacts = contacts.filter((contact) => Boolean(contact.lastMessage));
    if (state.filter === "favorites") {
      contacts = contacts.filter((contact) => contact.pinned);
    }
    contacts = sortByRecentActivity(contacts);
  }

  if (state.contactQuery) {
    const query = state.contactQuery;
    contacts = contacts.filter((contact) => {
      const label = (contact.localName || contact.pubkey).toLowerCase();
      return label.includes(query);
    });
  }

  return contacts;
}

function renderContactList() {
  if (!ui.chatList) return;
  ui.chatList.innerHTML = "";

  const contacts = filterContactsList();
  if (!contacts.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "chat-item chat-item--empty";
    let emptyText = "No chats yet";
    if (state.filter === "contacts") {
      emptyText = "No saved contacts yet";
    } else if (state.filter === "favorites") {
      emptyText = "No favorites yet";
    }
    placeholder.textContent = emptyText;
    ui.chatList.appendChild(placeholder);
    return;
  }

  const fragment = document.createDocumentFragment();
  contacts.forEach((contact) => {
    fragment.appendChild(createContactElement(contact));
  });

  ui.chatList.appendChild(fragment);

  if (ui.forwardModal && !ui.forwardModal.hidden) {
    renderForwardList();
  }
}

function truncateText(text, limit) {
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function getMessagePreviewText(message) {
  if (!message) return "";
  const payment = ensurePaymentMeta(message);
  if (payment) {
    const amountLabel = formatSolAmount(payment.lamports);
    const counterparty = message.direction === "out" ? payment.to : payment.from;
    const name = getContactDisplayName(counterparty);
    return message.direction === "out"
      ? `You sent ${amountLabel} SOL to ${name}`
      : `${name} sent you ${amountLabel} SOL`;
  }
  const nicknameChange = ensureNicknameChangeMeta(message);
  if (nicknameChange) {
    return `Changed nickname: ${nicknameChange.oldName} → ${nicknameChange.newName}`;
  }
  // Check for call message
  if (message.meta?.systemType === 'call' && message.meta?.call) {
    const call = message.meta.call;
    const isMissed = ['missed', 'declined', 'no_answer', 'failed', 'cancelled'].includes(call.type);
    const icon = isMissed ? '📞' : '📞';
    switch (call.type) {
      case 'outgoing': return `${icon} Outgoing call`;
      case 'incoming': return `${icon} Incoming call`;
      case 'missed': return `📵 Missed call`;
      case 'declined': return `📵 Declined call`;
      case 'no_answer': return `📵 No answer`;
      case 'cancelled': return `📵 Cancelled call`;
      case 'failed': return `📵 Call failed`;
      default: return `${icon} Call`;
    }
  }
  // Check for voice message
  if (message.meta?.voice) {
    return "Voice message";
  }
  // Check for scan report
  if (message.meta?.isReport && message.meta?.report) {
    return `Scan Report: ${message.meta.report.tokenInfo?.name || "Token"}`;
  }
  const text = message.text || "";
  if (text.includes(SCAN_REPORT_PREFIX)) {
    const report = parseScanReportMessage(text);
    if (report) {
      return `Scan Report: ${report.tokenInfo?.name || "Token"}`;
    }
  }
  const forwardMeta = ensureForwardMeta(message);
  const replyMeta = ensureReplyMeta(message);
  const baseText = message.text || "";
  if (forwardMeta) {
    return `Forwarded from ${forwardMeta.author || "Unknown"}`;
  }
  if (replyMeta) {
    return `↩ ${truncateText(baseText, 48)}`;
  }
  return truncateText(baseText, 48);
}

function createContactElement(contact) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "chat-item";
  item.dataset.pubkey = contact.pubkey;

  if (contact.pubkey === state.activeContactKey) {
    item.classList.add("is-active");
  }

  const avatar = document.createElement("div");
  avatar.className = "contact-avatar";
  const avatarLabel = getContactAvatarLabel(contact) || contact.pubkey;
  setAvatar(avatar, contact.pubkey, 46, avatarLabel);

  const meta = document.createElement("div");
  meta.className = "chat-item__meta";

  const nameEl = document.createElement("div");
  nameEl.className = "chat-item__name";
  nameEl.textContent = contact.localName || shortenPubkey(contact.pubkey, 6);

  const previewEl = document.createElement("div");
  previewEl.className = "chat-item__preview";
  if (contact.lastMessage) {
    const preview = getMessagePreviewText(contact.lastMessage);
    const isSystem = Boolean(contact.lastMessage.meta?.systemType);
    previewEl.textContent =
      contact.lastMessage.direction === "out" && !isSystem ? `You: ${preview}` : preview;
  } else {
    previewEl.textContent = "No messages yet";
  }

  meta.appendChild(nameEl);
  meta.appendChild(previewEl);

  const aside = document.createElement("div");
  aside.className = "chat-item__aside";

  if (contact.pinned) {
    aside.appendChild(createPinBadge());
  }

  const timeEl = document.createElement("div");
  timeEl.className = "chat-item__time";
  timeEl.textContent = contact.lastMessage ? timeAgo(contact.lastMessage.timestamp) : "";
  aside.appendChild(timeEl);

  if (contact.unreadCount > 0) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = String(contact.unreadCount);
    aside.appendChild(badge);
  }

  item.appendChild(avatar);
  item.appendChild(meta);
  item.appendChild(aside);

  item.addEventListener("click", async () => {
    if (contact.pubkey === state.activeContactKey) {
      // Same contact - just show chat on mobile
      showMobileChat();
      return;
    }
    await setActiveContact(contact.pubkey);
    history.replaceState(null, "", `#/dm/${contact.pubkey}`);
  });

  return item;
}

function createPinBadge() {
  const badge = document.createElement("span");
  badge.className = "chat-item__pin";
  badge.title = "Pinned chat";
  badge.setAttribute("aria-label", "Pinned chat");
  badge.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M13 2a1 1 0 0 1 1 1v4.59l3.3 3.3A1 1 0 0 1 16.59 12H13v6.5l-1 3-1-3V12H7.41a1 1 0 0 1-.71-1.71L10 7.59V3a1 1 0 0 1 1-1z"
      />
    </svg>
  `;
  return badge;
}

function updateContactListSelection() {
  if (!ui.chatList) return;
  ui.chatList.querySelectorAll(".chat-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.pubkey === state.activeContactKey);
  });
}

function clearChatView() {
  state.activeContactKey = null;
  updateContactListSelection();
  if (ui.chatHeaderMain) {
    ui.chatHeaderMain.classList.remove("is-active");
  }
  setTextContent(ui.chatName, "Select chat");
  setTextContent(ui.chatStatus, "No conversation yet");
  if (ui.chatAvatar) setAvatar(ui.chatAvatar, "solink", 52, "SOLink");

  if (ui.messageTimeline) {
    ui.messageTimeline.innerHTML = "";
  }
  toggleEmptyState(true);
  toggleComposer(false);
  updateConversationMeta(null);
  state.messageQuery = "";
  if (ui.messageSearchInput) {
    ui.messageSearchInput.value = "";
  }
  updatePaymentRecipient(null);
  clearReplyContext();
  hideForwardModal();
  hideMessageContextMenu();
}

function updateContactHeader() {
  if (!ui.chatName || !ui.chatStatus || !ui.chatAvatar || !ui.chatHeaderMain) return;

  if (!state.activeContactKey) {
    ui.chatHeaderMain.classList.remove("is-active");
    setTextContent(ui.chatName, "Select chat");
    setTextContent(ui.chatStatus, "No conversation yet");
    setAvatar(ui.chatAvatar, "solink", 52, "SOLink");
    // Hide call button when no chat selected
    if (ui.callButton) ui.callButton.hidden = true;
    return;
  }

  const contact = state.contacts.find((item) => item.pubkey === state.activeContactKey);
  if (contact) {
    setTextContent(ui.chatName, contact.localName || shortenPubkey(contact.pubkey, 6));
    setTextContent(ui.chatStatus, shortenPubkey(contact.pubkey, 6));
    setAvatar(ui.chatAvatar, contact.pubkey, 52, getContactAvatarLabel(contact));
  } else {
    setTextContent(ui.chatName, shortenPubkey(state.activeContactKey, 6));
    setTextContent(ui.chatStatus, state.activeContactKey);
    setAvatar(ui.chatAvatar, state.activeContactKey, 52, state.activeContactKey);
  }
  ui.chatHeaderMain.classList.add("is-active");
  
  // Show call button for regular contacts (not scanner)
  const isScanner = state.activeContactKey === SCANNER_CONTACT_KEY;
  if (ui.callButton) {
    ui.callButton.hidden = isScanner || !latestAppState?.isAuthenticated;
  }
}

function toggleEmptyState(isVisible) {
  if (!ui.emptyState) return;
  ui.emptyState.style.display = isVisible ? "flex" : "none";
}

async function loadMessages(pubkey) {
  if (!pubkey) return;
  const messages = await getMessagesForContact(pubkey);
  messages.sort((a, b) => a.timestamp - b.timestamp);
  state.messages.set(pubkey, messages);
}

function appendMessageToState(pubkey, message) {
  const list = state.messages.get(pubkey) || [];
  const existingIndex = list.findIndex((item) => item.id === message.id);
  if (existingIndex === -1) {
    list.push(message);
  } else {
    list[existingIndex] = { ...list[existingIndex], ...message };
  }
  list.sort((a, b) => a.timestamp - b.timestamp);
  state.messages.set(pubkey, list);
  
  // Schedule cloud sync (debounced)
  scheduleChatSync(pubkey);
}


function renderMessages(pubkey) {
  if (!ui.messageTimeline) return;
  ui.messageTimeline.innerHTML = "";
  hideMessageContextMenu();

  if (!pubkey) {
    toggleEmptyState(true);
    return;
  }

  const list = state.messages.get(pubkey) || [];
  const query = state.messageQuery;
  const filtered = query
    ? list.filter((message) => (message.text || "").toLowerCase().includes(query.toLowerCase()))
    : list;

  if (!filtered.length) {
    toggleEmptyState(true);
    return;
  }

  toggleEmptyState(false);
  const fragment = document.createDocumentFragment();
  let currentDayLabel = null;

  filtered.forEach((message) => {
    const dayLabel = formatDate(message.timestamp);
    if (dayLabel !== currentDayLabel) {
      currentDayLabel = dayLabel;
      const divider = document.createElement("div");
      divider.className = "timeline__day";
      divider.textContent = currentDayLabel;
      fragment.appendChild(divider);
    }

    fragment.appendChild(createMessageBubble(message, query));
  });

  ui.messageTimeline.appendChild(fragment);
  ui.messageTimeline.scrollTop = ui.messageTimeline.scrollHeight;
}

function createMessageBubble(message, highlightQueryText) {
  if (ensurePaymentMeta(message)) {
    return createPaymentBubble(message);
  }
  
  if (ensureNicknameChangeMeta(message)) {
    return createNicknameChangeBubble(message);
  }
  
  // Check for call message
  if (message.meta?.systemType === 'call' && message.meta?.call) {
    return createCallBubble(message);
  }
  
  // Check for scan report message
  const scanReport = parseScanReportMessage(message.text);
  if (scanReport) {
    console.log("[ScanReport] Rendering card for:", scanReport.tokenInfo?.name);
    const reportBubble = createScannerReportBubble(scanReport, message.direction || "in", message.timestamp, message.status);
    reportBubble.dataset.messageId = message.id;
    return reportBubble;
  }

  // Check for voice message
  if (message.meta?.voice) {
    console.log('[Voice] Rendering voice bubble:', message.id, message.meta.voice);
    return createVoiceBubble(message);
  }

  const bubble = document.createElement("div");
  bubble.className = `bubble bubble--${message.direction === "out" ? "out" : "in"}`;
  bubble.dataset.messageId = message.id;

  const forwardMeta = ensureForwardMeta(message);
  if (forwardMeta) {
    bubble.appendChild(createForwardPreviewBlock(forwardMeta));
  }

  const replyMeta = ensureReplyMeta(message);
  if (replyMeta) {
    bubble.appendChild(createReplyPreviewBlock(replyMeta));
  }

  const textEl = document.createElement("div");
  textEl.className = "bubble__text";

  const text = message.text || "";
  // Check if message is a pure pump.fun link (nothing else)
  const isPurePumpLink = message.meta?.tokenPreview && isPureTokenLink(text);
  const tokenUrl = message.meta?.tokenUrl || extractPumpFunUrl(text);

  if (isPurePumpLink) {
    // Pure link: transparent bubble, only token card visible
    bubble.classList.add("bubble--token-only");
    const tokenCard = createTokenPreviewBlock(message.meta.tokenPreview, tokenUrl);
    bubble.appendChild(tokenCard);
  } else {
    // Normal message with text
    if (highlightQueryText) {
      textEl.innerHTML = highlightQuery(text, highlightQueryText);
    } else {
      textEl.innerHTML = linkifyText(text);
    }
    bubble.appendChild(textEl);
    
    // Add token card after text if present
    if (message.meta?.tokenPreview) {
      const tokenCard = createTokenPreviewBlock(message.meta.tokenPreview, tokenUrl);
      bubble.appendChild(tokenCard);
    }
    
    // Add link preview card if present (and no token preview)
    if (message.meta?.linkPreview && !message.meta?.tokenPreview) {
      const linkCard = createLinkPreviewBlock(message.meta.linkPreview);
      bubble.appendChild(linkCard);
    }
  }

  const meta = document.createElement("div");
  meta.className = "bubble__meta";
  meta.textContent = formatTime(message.timestamp);

  if (message.direction === "out") {
    const status = document.createElement("span");
    status.className = "bubble__status";
    status.textContent = message.status || "sent";
    meta.appendChild(status);
  }

  bubble.appendChild(meta);
  
  // Add reactions display
  const reactionsDisplay = createReactionsDisplay(message);
  if (reactionsDisplay) {
    bubble.classList.add("bubble--has-reactions");
    bubble.appendChild(reactionsDisplay);
  }
  
  // Add reaction button (hidden by default, shown on hover)
  const reactionBtn = createReactionButton(message.id);
  bubble.appendChild(reactionBtn);
  
  return bubble;
}

/**
 * Create voice message bubble with custom player
 */
function createVoiceBubble(message) {
  const voice = message.meta.voice;
  const bubble = document.createElement('div');
  bubble.className = `bubble bubble--${message.direction === 'out' ? 'out' : 'in'} bubble--voice`;
  bubble.dataset.messageId = message.id;

  // Voice player container
  const player = document.createElement('div');
  player.className = 'voice-player';

  // Play/pause button
  const playBtn = document.createElement('button');
  playBtn.className = 'voice-player__btn';
  playBtn.type = 'button';
  playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  playBtn.dataset.state = 'paused';

  // Waveform canvas (replaces progress bar)
  const waveformCanvas = document.createElement('canvas');
  waveformCanvas.className = 'voice-player__waveform';
  waveformCanvas.width = 150;
  waveformCanvas.height = 28;
  
  // Get waveform data or generate default
  const waveformBars = voice.waveform && voice.waveform.length > 0 
    ? voice.waveform 
    : new Array(50).fill(0.3);
  
  // Initial draw
  const isOutgoing = message.direction === 'out';
  const playedColor = isOutgoing ? '#fff' : '#d4782a';
  const unplayedColor = isOutgoing ? 'rgba(255,255,255,0.4)' : 'rgba(212,120,42,0.3)';
  drawWaveform(waveformCanvas, waveformBars, 0, playedColor, unplayedColor);

  // Duration label
  const durationLabel = document.createElement('span');
  durationLabel.className = 'voice-player__duration';
  durationLabel.textContent = formatDuration(voice.duration || 0);

  // Loading indicator
  if (voice.loading) {
    playBtn.disabled = true;
    playBtn.innerHTML = '<svg class="voice-player__spinner" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="31.4" stroke-dashoffset="10"/></svg>';
  }

  // Audio element (lazy loaded on play)
  let audioElement = null;
  let audioUrl = null;
  let audioBlob = null; // Store blob for Chrome recreation
  let isLoadingAudio = false;

  // === Seek state ===
  let isSeeking = false;
  let seekPreviewPercent = 0;
  let pendingSeekPercent = null; // Seek position to apply when audio is ready

  // Get duration with fallback to metadata
  function getAudioDuration() {
    if (audioElement && isFinite(audioElement.duration) && audioElement.duration > 0) {
      return audioElement.duration;
    }
    return voice.duration || 30;
  }

  // Attach audio event listeners (reusable for recreation)
  function attachAudioListeners(audio) {
    audio.addEventListener('timeupdate', () => {
      // Don't update during seeking to prevent visual jitter
      if (isSeeking) return;
      const progress = audio.currentTime / audio.duration;
      if (isFinite(progress)) {
        drawWaveform(waveformCanvas, waveformBars, progress, playedColor, unplayedColor);
        durationLabel.textContent = formatDuration(Math.floor(audio.currentTime));
      }
    });
    
    audio.addEventListener('ended', () => {
      playBtn.dataset.state = 'paused';
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      drawWaveform(waveformCanvas, waveformBars, 0, playedColor, unplayedColor);
      durationLabel.textContent = formatDuration(voice.duration || 0);
      // Chrome has issues with seeking blob URLs after playback ends
      audio.dataset.needsRecreate = 'true';
    });
    
    audio.addEventListener('error', (e) => {
      // Only show toast for actual playback errors, not seek errors
      const error = audio.error;
      if (error && error.code !== MediaError.MEDIA_ERR_ABORTED) {
        // Check if it's a seek error (PIPELINE_ERROR usually in message)
        const isSeekError = error.message && (
          error.message.includes('seek') || 
          error.message.includes('PIPELINE') ||
          error.message.includes('demuxer')
        );
        if (!isSeekError && !isSeeking) {
          console.error('[Voice] Audio error:', error.code, error.message);
          showToast('Failed to play voice message');
        } else {
          console.warn('[Voice] Seek-related error, will recreate:', error.message);
          audio.dataset.needsRecreate = 'true';
        }
      }
    });
  }

  // Load audio element (shared between play and seek)
  async function loadAudioElement() {
    if (audioElement && audioElement.readyState >= 2) return true;
    if (isLoadingAudio) return false;
    
    isLoadingAudio = true;
    playBtn.disabled = true;
    playBtn.innerHTML = '<svg class="voice-player__spinner" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="31.4" stroke-dashoffset="10"/></svg>';
    
    try {
      // Download and decrypt
      const result = await downloadVoiceMessage(voice.key);
      if (!result?.encryptedAudio) {
        throw new Error('Voice not found');
      }
      
      console.log('[Voice] Decrypting voice for contact:', message.contactKey?.slice(0, 8), 'nonce:', voice.nonce?.slice(0, 20), 'senderKey:', voice.senderKey?.slice(0, 20), 'hasSavedSecret:', !!voice.sessionSecret);
      
      let sessionSecret;
      
      // Priority 1: Use saved session secret (for outgoing messages after reload)
      if (voice.sessionSecret) {
        sessionSecret = voice.sessionSecret;
        console.log('[Voice] Using saved session secret');
      }
      // Priority 2: For incoming, compute from senderKey
      else if (voice.senderKey && message.direction === 'in') {
        const myKeys = await ensureEncryptionKeys();
        const senderKeyBytes = base64ToBytes(voice.senderKey);
        const sharedBytes = nacl.box.before(senderKeyBytes, base64ToBytes(myKeys.secretKey));
        sessionSecret = bytesToBase64(sharedBytes);
        console.log('[Voice] Direct session secret computed, myPubKey:', myKeys.publicKey?.slice(0, 20));
      }
      // Priority 3: Standard session secret
      else {
        sessionSecret = await ensureSessionSecret(message.contactKey, { force: true });
        console.log('[Voice] Using standard session secret');
      }
      
      console.log('[Voice] Session secret obtained:', !!sessionSecret, sessionSecret?.slice(0, 20));
      
      if (!sessionSecret) {
        throw new Error('No session secret available');
      }
      
      console.log('[Voice] Decrypting with mimeType:', voice.mimeType);
      let blob = await decryptVoiceData(
        result.encryptedAudio,
        voice.nonce,
        sessionSecret,
        voice.mimeType || 'audio/webm'
      );
      
      if (!blob) {
        throw new Error('Failed to decrypt');
      }
      
      // Save session secret for future playback (after reload)
      if (!voice.sessionSecret && sessionSecret) {
        voice.sessionSecret = sessionSecret;
        updateMessageMeta(message.id, { voice: { ...voice, sessionSecret } }).catch(() => {});
      }
      
      // Use blob URL for audio playback
      audioBlob = blob;
      audioUrl = URL.createObjectURL(blob);
      console.log('[Voice] Created blob URL:', audioUrl?.slice(0, 50), 'blob size:', blob.size, 'type:', blob.type);
      
      audioElement = new Audio(audioUrl);
      
      // Wait for audio to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.warn('[Voice] Audio load timeout');
          resolve();
        }, 5000);
        
        audioElement.oncanplaythrough = () => {
          clearTimeout(timeout);
          resolve();
        };
        audioElement.onloadeddata = () => {
          clearTimeout(timeout);
          resolve();
        };
        audioElement.onerror = (e) => {
          clearTimeout(timeout);
          console.error('[Voice] Audio element error:', audioElement.error);
          reject(new Error('Audio load failed: ' + (audioElement.error?.message || 'unknown')));
        };
      });
      
      attachAudioListeners(audioElement);
      
      // Apply pending seek position if set
      if (pendingSeekPercent !== null && isFinite(audioElement.duration)) {
        try {
          audioElement.currentTime = pendingSeekPercent * audioElement.duration;
          console.log('[Voice] Applied pending seek:', pendingSeekPercent);
        } catch {}
        pendingSeekPercent = null;
      }
      
      playBtn.disabled = false;
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      isLoadingAudio = false;
      return true;
      
    } catch (err) {
      console.error('[Voice] Load error:', err);
      showToast('Failed to load voice message');
      playBtn.disabled = false;
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      isLoadingAudio = false;
      return false;
    }
  }

  // Recreate audio for Chrome (blob URL issues after ended)
  function recreateAudioIfNeeded(preserveTime = false) {
    if (audioElement?.dataset?.needsRecreate === 'true' && audioBlob) {
      const currentTime = preserveTime ? audioElement.currentTime : 0;
      console.log('[Voice] Recreating audio element for Chrome compatibility');
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(audioBlob);
      const newAudio = new Audio(audioUrl);
      attachAudioListeners(newAudio);
      audioElement = newAudio;
      // Wait for ready and restore position
      return new Promise((resolve) => {
        const onReady = () => {
          newAudio.removeEventListener('canplay', onReady);
          if (preserveTime && currentTime > 0) {
            try { newAudio.currentTime = currentTime; } catch {}
          }
          resolve(true);
        };
        newAudio.addEventListener('canplay', onReady);
        // Timeout fallback
        setTimeout(() => {
          newAudio.removeEventListener('canplay', onReady);
          resolve(true);
        }, 1000);
      });
    }
    return Promise.resolve(false);
  }
  
  // Force recreate audio (for seek errors)
  async function forceRecreateAudio(targetTime = 0) {
    if (!audioBlob) return false;
    console.log('[Voice] Force recreating audio at time:', targetTime);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(audioBlob);
    const newAudio = new Audio(audioUrl);
    attachAudioListeners(newAudio);
    audioElement = newAudio;
    
    return new Promise((resolve) => {
      const onReady = () => {
        newAudio.removeEventListener('canplay', onReady);
        if (targetTime > 0 && isFinite(newAudio.duration)) {
          try { 
            newAudio.currentTime = Math.min(targetTime, newAudio.duration - 0.1); 
          } catch {}
        }
        resolve(true);
      };
      newAudio.addEventListener('canplay', onReady);
      setTimeout(() => {
        newAudio.removeEventListener('canplay', onReady);
        resolve(false);
      }, 2000);
    });
  }

  playBtn.addEventListener('click', async () => {
    if (voice.loading) return;
    
    // Load audio if not loaded
    if (!audioElement || audioElement.readyState < 2) {
      const loaded = await loadAudioElement();
      if (!loaded) return;
    }
    
    // Toggle play/pause
    if (playBtn.dataset.state === 'paused') {
      // Recreate if needed (only when starting play)
      if (audioElement?.dataset?.needsRecreate === 'true') {
        // Use pending seek position if set, otherwise 0
        const seekPercent = pendingSeekPercent !== null ? pendingSeekPercent : 0;
        const targetTime = seekPercent * getAudioDuration();
        await forceRecreateAudio(targetTime);
        // Update visual
        drawWaveform(waveformCanvas, waveformBars, seekPercent, playedColor, unplayedColor);
        pendingSeekPercent = null;
      } 
      // Apply pending seek if we have one
      else if (pendingSeekPercent !== null && audioElement && isFinite(audioElement.duration)) {
        try {
          audioElement.currentTime = pendingSeekPercent * audioElement.duration;
          // Update visual
          drawWaveform(waveformCanvas, waveformBars, pendingSeekPercent, playedColor, unplayedColor);
        } catch {}
        pendingSeekPercent = null;
      }
      
      // Pause any other playing audio
      document.querySelectorAll('.voice-player__btn[data-state="playing"]').forEach(btn => {
        if (btn !== playBtn) btn.click();
      });
      
      console.log('[Voice] Playing, readyState:', audioElement.readyState, 'currentTime:', audioElement.currentTime);
      
      try {
        await audioElement.play();
        playBtn.dataset.state = 'playing';
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('[Voice] Play error:', err.name, err.message);
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          audioElement = null;
          audioUrl = null;
          showToast('Playback failed, tap again to retry');
        }
      }
    } else {
      audioElement.pause();
      playBtn.dataset.state = 'paused';
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }
  });

  // === Seek with Pointer Events ===
  
  // Get seek position from event
  function getSeekPercent(e) {
    const rect = waveformCanvas.getBoundingClientRect();
    // Support pointer, mouse, and touch events
    let clientX;
    if (e.clientX !== undefined) {
      clientX = e.clientX;
    } else if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
    } else {
      // Fallback to last known position
      return seekPreviewPercent;
    }
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  // Apply seek to audio element
  async function applySeek(percent) {
    // Always save pending seek position
    pendingSeekPercent = percent;
    
    // If audio not loaded yet - just save position, will apply on play
    if (!audioElement || audioElement.readyState < 2) {
      console.log('[Voice] Audio not ready, saving seek position:', percent);
      return;
    }
    
    const wasPlaying = playBtn.dataset.state === 'playing';
    const targetTime = percent * (isFinite(audioElement.duration) ? audioElement.duration : getAudioDuration());
    
    // If needs recreate
    if (audioElement?.dataset?.needsRecreate === 'true') {
      await forceRecreateAudio(targetTime);
      pendingSeekPercent = null;
      // Update visual after recreate
      drawWaveform(waveformCanvas, waveformBars, percent, playedColor, unplayedColor);
      durationLabel.textContent = formatDuration(Math.floor(targetTime));
      // Resume if was playing
      if (wasPlaying && audioElement) {
        try {
          await audioElement.play();
        } catch {}
      }
      return;
    }
    
    if (audioElement && isFinite(audioElement.duration)) {
      try {
        // Direct seek - works best for most cases
        audioElement.currentTime = targetTime;
        pendingSeekPercent = null;
        
        // Update visual
        drawWaveform(waveformCanvas, waveformBars, percent, playedColor, unplayedColor);
        durationLabel.textContent = formatDuration(Math.floor(targetTime));
        
      } catch (err) {
        console.warn('[Voice] Seek error, recreating audio:', err.message);
        // Seek failed - recreate audio and try again
        const recreated = await forceRecreateAudio(targetTime);
        if (recreated) {
          pendingSeekPercent = null;
          drawWaveform(waveformCanvas, waveformBars, percent, playedColor, unplayedColor);
          if (wasPlaying && audioElement) {
            try {
              await audioElement.play();
            } catch {}
          }
        }
      }
    }
  }

  function handleSeekStart(e) {
    e.preventDefault();
    isSeeking = true;
    
    // Capture pointer for reliable tracking outside element
    if (e.pointerId !== undefined) {
      try {
        waveformCanvas.setPointerCapture(e.pointerId);
      } catch {}
    }
    
    seekPreviewPercent = getSeekPercent(e);
    
    // Instant visual feedback
    drawWaveform(waveformCanvas, waveformBars, seekPreviewPercent, playedColor, unplayedColor);
    durationLabel.textContent = formatDuration(Math.floor(seekPreviewPercent * getAudioDuration()));
  }

  function handleSeekMove(e) {
    if (!isSeeking) return;
    e.preventDefault();
    
    seekPreviewPercent = getSeekPercent(e);
    
    // Update visual during drag
    drawWaveform(waveformCanvas, waveformBars, seekPreviewPercent, playedColor, unplayedColor);
    durationLabel.textContent = formatDuration(Math.floor(seekPreviewPercent * getAudioDuration()));
  }

  async function handleSeekEnd(e) {
    if (!isSeeking) return;
    
    // Release pointer capture immediately
    if (e.pointerId !== undefined) {
      try {
        waveformCanvas.releasePointerCapture(e.pointerId);
      } catch {}
    }
    
    // Apply the seek (keep isSeeking true until done)
    try {
      await applySeek(seekPreviewPercent);
    } finally {
      isSeeking = false;
    }
  }

  // Store active pointer ID for tracking
  let activePointerId = null;

  // Use Pointer Events (modern unified approach)
  if (window.PointerEvent) {
    waveformCanvas.addEventListener('pointerdown', (e) => {
      activePointerId = e.pointerId;
      handleSeekStart(e);
    });
    
    waveformCanvas.addEventListener('pointermove', handleSeekMove);
    
    waveformCanvas.addEventListener('pointerup', (e) => {
      if (e.pointerId === activePointerId) {
        activePointerId = null;
        handleSeekEnd(e);
      }
    });
    
    waveformCanvas.addEventListener('pointercancel', (e) => {
      activePointerId = null;
      handleSeekEnd(e);
    });
    
    waveformCanvas.addEventListener('lostpointercapture', (e) => {
      if (isSeeking) {
        activePointerId = null;
        handleSeekEnd(e);
      }
    });
    
    // Global handler for when pointer is released outside the element
    document.addEventListener('pointerup', (e) => {
      if (isSeeking && e.pointerId === activePointerId) {
        activePointerId = null;
        // Calculate position relative to waveform even if outside
        seekPreviewPercent = getSeekPercent(e);
        handleSeekEnd(e);
      }
    }, { passive: true });
    
  } else {
    // Fallback for older browsers (Safari < 13)
    waveformCanvas.addEventListener('mousedown', handleSeekStart);
    waveformCanvas.addEventListener('mousemove', handleSeekMove);
    waveformCanvas.addEventListener('mouseup', handleSeekEnd);
    
    // Global mouseup for when released outside
    document.addEventListener('mouseup', (e) => {
      if (isSeeking) {
        handleSeekEnd(e);
      }
    }, { passive: true });
    
    waveformCanvas.addEventListener('touchstart', handleSeekStart, { passive: false });
    waveformCanvas.addEventListener('touchmove', handleSeekMove, { passive: false });
    waveformCanvas.addEventListener('touchend', handleSeekEnd);
    waveformCanvas.addEventListener('touchcancel', handleSeekEnd);
  }

  player.appendChild(playBtn);
  player.appendChild(waveformCanvas);
  player.appendChild(durationLabel);
  bubble.appendChild(player);

  // Meta row: label left, time+status right
  const meta = document.createElement('div');
  meta.className = 'bubble__meta bubble__meta--voice';
  
  const label = document.createElement('span');
  label.className = 'voice-player__label';
  label.textContent = 'Voice message';
  meta.appendChild(label);
  
  const timeWrap = document.createElement('span');
  timeWrap.className = 'bubble__time-wrap';
  timeWrap.textContent = formatTime(message.timestamp);
  
  if (message.direction === 'out') {
    const status = document.createElement('span');
    status.className = 'bubble__status';
    status.textContent = message.status || 'sent';
    timeWrap.appendChild(status);
  }
  meta.appendChild(timeWrap);
  
  bubble.appendChild(meta);
  
  return bubble;
}

function createPaymentBubble(message) {
  const payment = ensurePaymentMeta(message);
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble--system";
  bubble.dataset.messageId = message.id;

  const forwardMeta = ensureForwardMeta(message);
  if (forwardMeta) {
    bubble.appendChild(createForwardPreviewBlock(forwardMeta));
  }

  const replyMeta = ensureReplyMeta(message);
  if (replyMeta) {
    bubble.appendChild(createReplyPreviewBlock(replyMeta));
  }

  const amountLabel = formatSolAmount(payment.lamports);
  const counterpartyName =
    message.direction === "out"
      ? payment.toName || shortenPubkey(payment.to, 6)
      : payment.fromName || shortenPubkey(payment.from, 6);
  const textEl = document.createElement("div");
  textEl.className = "bubble__text";
  textEl.textContent =
    message.direction === "out"
      ? `You sent ${amountLabel} SOL to ${counterpartyName}`
      : `${counterpartyName} sent you ${amountLabel} SOL`;

  const meta = document.createElement("div");
  meta.className = "bubble__meta bubble__meta--system";
  meta.textContent = formatTime(message.timestamp);

  if (payment.signature) {
    const link = document.createElement("a");
    link.href = `${SOLANA_EXPLORER_TX}${payment.signature}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "bubble__link";
    link.textContent = "View transaction";
    meta.appendChild(link);
  }

  bubble.appendChild(textEl);
  bubble.appendChild(meta);
  return bubble;
}

function createNicknameChangeBubble(message) {
  const nicknameChange = ensureNicknameChangeMeta(message);
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble--system bubble--nickname-change";
  bubble.dataset.messageId = message.id;

  const textEl = document.createElement("div");
  textEl.className = "bubble__text";
  textEl.innerHTML = `<span class="nickname-old">${nicknameChange.oldName}</span> changed nickname to <span class="nickname-new">${nicknameChange.newName}</span>`;

  const meta = document.createElement("div");
  meta.className = "bubble__meta bubble__meta--system";
  meta.textContent = formatTime(message.timestamp);

  bubble.appendChild(textEl);
  bubble.appendChild(meta);
  return bubble;
}

function createCallBubble(message) {
  const callMeta = message.meta?.call;
  if (!callMeta) return null;
  
  const bubble = document.createElement("div");
  const isMissed = ['missed', 'declined', 'no_answer', 'failed', 'cancelled'].includes(callMeta.type);
  bubble.className = `bubble bubble--system bubble--call ${isMissed ? 'bubble--call-missed' : 'bubble--call-success'}`;
  bubble.dataset.messageId = message.id;

  // Call icon
  const iconSvg = callMeta.isOutgoing
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="call-icon call-icon--outgoing">
         <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
         <polyline points="17 2 22 2 22 7"/>
       </svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="call-icon call-icon--incoming">
         <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
         <polyline points="7 2 2 2 2 7"/>
       </svg>`;

  // Call text
  let callText = '';
  switch (callMeta.type) {
    case 'outgoing':
      callText = 'Outgoing call';
      break;
    case 'incoming':
      callText = 'Incoming call';
      break;
    case 'missed':
      callText = 'Missed call';
      break;
    case 'declined':
      callText = callMeta.isOutgoing ? 'Call declined' : 'Declined call';
      break;
    case 'no_answer':
      callText = 'No answer';
      break;
    case 'cancelled':
      callText = 'Cancelled call';
      break;
    case 'failed':
      callText = 'Call failed';
      break;
    default:
      callText = 'Call';
  }
  
  // Duration text
  const durationText = callMeta.duration > 0 ? formatCallDuration(callMeta.duration) : '';

  const content = document.createElement("div");
  content.className = "bubble__call-content";
  content.innerHTML = `
    <div class="bubble__call-icon">${iconSvg}</div>
    <div class="bubble__call-info">
      <span class="bubble__call-text">${callText}</span>
      ${durationText ? `<span class="bubble__call-duration">${durationText}</span>` : ''}
    </div>
  `;

  const meta = document.createElement("div");
  meta.className = "bubble__meta bubble__meta--system";
  meta.textContent = formatTime(message.timestamp);

  bubble.appendChild(content);
  bubble.appendChild(meta);
  return bubble;
}

function createReplyPreviewBlock(replyMeta) {
  const wrapper = document.createElement("div");
  wrapper.className = "bubble__reply";
  
  // Make clickable if we have original message ID
  if (replyMeta.id) {
    wrapper.dataset.replyId = replyMeta.id;
    wrapper.style.cursor = "pointer";
    wrapper.addEventListener("click", (e) => {
      e.stopPropagation();
      scrollToMessage(replyMeta.id);
    });
  }
  
  const author = document.createElement("div");
  author.className = "bubble__reply-author";
  author.textContent = replyMeta.author || "Reply";
  const text = document.createElement("div");
  text.className = "bubble__reply-text";
  text.textContent = replyMeta.preview || "[No text]";
  wrapper.appendChild(author);
  wrapper.appendChild(text);
  return wrapper;
}

function scrollToMessage(messageId) {
  if (!messageId) return;
  
  const bubble = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!bubble) {
    showToast("Message not found");
    return;
  }
  
  // Scroll to message
  bubble.scrollIntoView({ behavior: "smooth", block: "center" });
  
  // Highlight animation
  bubble.classList.add("bubble--highlight");
  setTimeout(() => {
    bubble.classList.remove("bubble--highlight");
  }, 1500);
}

function createLinkPreviewBlock(preview) {
  if (!preview || !preview.url) return document.createDocumentFragment();
  
  const card = document.createElement("a");
  card.className = "link-preview";
  card.href = preview.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  
  // Image section (if available)
  if (preview.image) {
    const imgWrapper = document.createElement("div");
    imgWrapper.className = "link-preview__image";
    const img = document.createElement("img");
    img.src = preview.image;
    img.alt = preview.title || '';
    img.loading = "lazy";
    img.onerror = function() {
      imgWrapper.remove();
    };
    imgWrapper.appendChild(img);
    card.appendChild(imgWrapper);
  }
  
  // Content section
  const content = document.createElement("div");
  content.className = "link-preview__content";
  
  // Site name with favicon
  const siteRow = document.createElement("div");
  siteRow.className = "link-preview__site";
  
  if (preview.favicon) {
    const favicon = document.createElement("img");
    favicon.src = preview.favicon;
    favicon.className = "link-preview__favicon";
    favicon.width = 16;
    favicon.height = 16;
    favicon.onerror = function() { this.style.display = 'none'; };
    siteRow.appendChild(favicon);
  }
  
  const siteName = document.createElement("span");
  siteName.textContent = preview.siteName || new URL(preview.url).hostname;
  siteRow.appendChild(siteName);
  content.appendChild(siteRow);
  
  // Title
  if (preview.title) {
    const title = document.createElement("div");
    title.className = "link-preview__title";
    title.textContent = preview.title;
    content.appendChild(title);
  }
  
  // Description
  if (preview.description) {
    const desc = document.createElement("div");
    desc.className = "link-preview__desc";
    desc.textContent = preview.description.length > 120 
      ? preview.description.slice(0, 120) + '...' 
      : preview.description;
    content.appendChild(desc);
  }
  
  card.appendChild(content);
  return card;
}

function createTokenPreviewBlock(preview, tokenUrl = null) {
  const card = document.createElement("div");
  card.className = "pump-card";

  // Top section: Image + Main info
  const topSection = document.createElement("div");
  topSection.className = "pump-card__top";

  // Token image
  const imgWrapper = document.createElement("div");
  imgWrapper.className = "pump-card__avatar";
  
  if (preview.imageUrl) {
    const img = document.createElement("img");
    img.src = `/api/image-proxy?url=${encodeURIComponent(preview.imageUrl)}`;
    img.alt = preview.symbol || '?';
    img.onerror = function() {
      this.style.display = 'none';
      const fallback = document.createElement("div");
      fallback.className = "pump-card__avatar-fallback";
      fallback.textContent = (preview.symbol || '?')[0].toUpperCase();
      imgWrapper.appendChild(fallback);
    };
    imgWrapper.appendChild(img);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "pump-card__avatar-fallback";
    fallback.textContent = (preview.symbol || '?')[0].toUpperCase();
    imgWrapper.appendChild(fallback);
  }
  topSection.appendChild(imgWrapper);

  // Info section
  const info = document.createElement("div");
  info.className = "pump-card__info";

  // Name row with 24h change
  const nameRow = document.createElement("div");
  nameRow.className = "pump-card__name-row";
  const name = document.createElement("span");
  name.className = "pump-card__name";
  name.textContent = preview.name || 'Unknown';
  nameRow.appendChild(name);
  
  if (preview.priceChange24h !== null && preview.priceChange24h !== undefined) {
    const change = parseFloat(preview.priceChange24h);
    const changeBadge = document.createElement("span");
    changeBadge.className = `pump-card__change-main ${change >= 0 ? 'is-up' : 'is-down'}`;
    changeBadge.textContent = formatPercentChange(preview.priceChange24h);
    nameRow.appendChild(changeBadge);
  }
  info.appendChild(nameRow);

  // Ticker
  const ticker = document.createElement("div");
  ticker.className = "pump-card__ticker";
  ticker.textContent = `$${preview.symbol || '???'}`;
  info.appendChild(ticker);

  // MCap as main value with mini changes
  const mcapRow = document.createElement("div");
  mcapRow.className = "pump-card__mcap-row";
  const mcapValue = document.createElement("span");
  mcapValue.className = "pump-card__mcap";
  mcapValue.textContent = formatNumber(preview.marketCap);
  mcapRow.appendChild(mcapValue);

  // Mini changes
  if (preview.priceChange5m !== null || preview.priceChange1h !== null) {
    const changes = document.createElement("div");
    changes.className = "pump-card__changes";
    if (preview.priceChange5m !== null) {
      const c = parseFloat(preview.priceChange5m);
      const el = document.createElement("span");
      el.className = c >= 0 ? 'is-up' : 'is-down';
      el.textContent = `5m ${formatPercentChange(preview.priceChange5m)}`;
      changes.appendChild(el);
    }
    if (preview.priceChange1h !== null) {
      const c = parseFloat(preview.priceChange1h);
      const el = document.createElement("span");
      el.className = c >= 0 ? 'is-up' : 'is-down';
      el.textContent = `1h ${formatPercentChange(preview.priceChange1h)}`;
      changes.appendChild(el);
    }
    mcapRow.appendChild(changes);
  }
  info.appendChild(mcapRow);

  topSection.appendChild(info);
  card.appendChild(topSection);

  // Stats grid
  const stats = document.createElement("div");
  stats.className = "pump-card__stats";
  stats.appendChild(createPumpStat("Price", formatPrice(preview.priceUsd)));
  stats.appendChild(createPumpStat("Liq", formatNumber(preview.liquidity)));
  stats.appendChild(createPumpStat("Vol", formatNumber(preview.volume24h)));
  
  // Buys/Sells (transaction count, not dollars)
  if (preview.buys24h !== null || preview.sells24h !== null) {
    const txnEl = document.createElement("div");
    txnEl.className = "pump-card__stat";
    const buys = preview.buys24h || 0;
    const sells = preview.sells24h || 0;
    txnEl.innerHTML = `<span class="pump-card__stat-label">Txns</span><span class="pump-card__stat-value"><em class="buy">${buys.toLocaleString()}</em> / <em class="sell">${sells.toLocaleString()}</em></span>`;
    stats.appendChild(txnEl);
  }
  card.appendChild(stats);

  // Bonding progress
  if (preview.bondingProgress !== null && preview.bondingProgress !== undefined && !preview.isComplete) {
    const progress = document.createElement("div");
    progress.className = "pump-card__bonding";
    progress.innerHTML = `
      <div class="pump-card__bonding-bar"><div class="pump-card__bonding-fill" style="width:${Math.min(100, preview.bondingProgress)}%"></div></div>
      <span class="pump-card__bonding-label">Bonding ${preview.bondingProgress.toFixed(0)}%</span>
    `;
    card.appendChild(progress);
  }

  // Footer: badges + socials + link
  const footer = document.createElement("div");
  footer.className = "pump-card__footer";

  // Left: badges
  const badgesLeft = document.createElement("div");
  badgesLeft.className = "pump-card__badges";
  
  if (preview.dexId) {
    const dex = document.createElement("span");
    dex.className = "pump-card__badge pump-card__badge--dex";
    dex.textContent = formatDexName(preview.dexId);
    badgesLeft.appendChild(dex);
  }
  if (preview.createdAt) {
    const age = document.createElement("span");
    age.className = "pump-card__badge pump-card__badge--age";
    age.textContent = formatAge(preview.createdAt);
    badgesLeft.appendChild(age);
  }
  footer.appendChild(badgesLeft);

  // Middle: socials
  if (preview.socials && preview.socials.length > 0) {
    const socials = document.createElement("div");
    socials.className = "pump-card__socials";
    const seenTypes = new Set();
    for (const s of preview.socials) {
      if (seenTypes.has(s.type)) continue;
      seenTypes.add(s.type);
      if (seenTypes.size > 3) break;
      const link = document.createElement("a");
      link.href = s.url.startsWith('http') ? s.url : `https://${s.url}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "pump-card__social";
      link.innerHTML = getSocialIcon(s.type);
      link.title = s.type;
      socials.appendChild(link);
    }
    footer.appendChild(socials);
  }

  // Right: open link - determine the best URL based on source
  const openLink = document.createElement("a");
  openLink.className = "pump-card__open";
  // Use tokenUrl if provided, otherwise construct based on available data
  if (tokenUrl) {
    openLink.href = tokenUrl;
  } else if (preview.pairAddress) {
    // DexScreener pair
    openLink.href = `https://dexscreener.com/solana/${preview.pairAddress}`;
  } else {
    // Default to pump.fun
    openLink.href = `https://pump.fun/coin/${preview.address}`;
  }
  openLink.target = "_blank";
  openLink.rel = "noopener noreferrer";
  openLink.innerHTML = `View <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
  footer.appendChild(openLink);

  card.appendChild(footer);
  return card;
}

function createPumpStat(label, value) {
  const el = document.createElement("div");
  el.className = "pump-card__stat";
  el.innerHTML = `<span class="pump-card__stat-label">${label}</span><span class="pump-card__stat-value">${value}</span>`;
  return el;
}

function createStatEl(label, value) {
  const el = document.createElement("div");
  el.className = "token-preview__stat";
  el.innerHTML = `<span class="token-preview__stat-label">${label}</span><span class="token-preview__stat-value">${value}</span>`;
  return el;
}

function formatDexName(dexId) {
  const names = {
    'raydium': 'Raydium',
    'pumpfun': 'Pump.fun',
    'orca': 'Orca',
    'jupiter': 'Jupiter',
    'meteora': 'Meteora',
  };
  return names[dexId?.toLowerCase()] || dexId || 'DEX';
}

function formatAge(timestamp) {
  if (!timestamp) return '';
  const now = Date.now();
  const created = typeof timestamp === 'number' && timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const diff = now - created;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'new';
}

function getSocialIcon(type) {
  const icons = {
    twitter: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>', // X logo
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    telegram: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
    website: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    discord: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286z"/></svg>',
  };
  return icons[type?.toLowerCase()] || icons.website;
}

function createForwardPreviewBlock(forwardMeta) {
  const wrapper = document.createElement("div");
  wrapper.className = "bubble__forward";
  const bar = document.createElement("div");
  bar.className = "bubble__forward-bar";
  wrapper.appendChild(bar);
  const label = document.createElement("div");
  label.className = "bubble__forward-label";
  label.textContent = "Forwarded";
  const author = document.createElement("div");
  author.className = "bubble__forward-author";
  author.textContent = forwardMeta.author || "Unknown";
  wrapper.appendChild(label);
  wrapper.appendChild(author);
  return wrapper;
}

function buildForwardMeta(record) {
  if (!record?.message) return null;
  const existingMeta = record.message.meta?.forwardedFrom || ensureForwardMeta(record.message);
  if (existingMeta) {
    return existingMeta;
  }
  
  // Handle scanner messages
  if (record.contactKey === SCANNER_CONTACT_KEY) {
    return {
      author: "Token Scanner",
      authorPubkey: "",
      originalMessageId: record.message.id || null,
      timestamp: record.message.timestamp || Date.now(),
    };
  }
  
  const isOutgoing = record.message.direction === "out";
  const authorName = isOutgoing ? getSelfDisplayName() : getContactDisplayName(record.contactKey);
  const authorPubkey = isOutgoing
    ? latestAppState?.walletPubkey || state.currentWallet || ""
    : record.contactKey;
  return {
    author: authorName || "Unknown",
    authorPubkey,
    originalMessageId: record.message.id || null,
    timestamp: record.message.timestamp || Date.now(),
  };
}

function findMessageRecordById(messageId) {
  if (!messageId) return null;
  for (const [contactKey, list] of state.messages.entries()) {
    const index = list.findIndex((item) => item.id === messageId);
    if (index !== -1) {
      return { contactKey, index, message: list[index] };
    }
  }
  return null;
}

function showForwardModal(messageId) {
  const record = findMessageById(messageId);
  if (!record) {
    showToast("Message not found");
    return;
  }
  state.forwardContext.source = record;
  state.forwardContext.filter = "";
  state.forwardContext.selectedTarget = null;
  if (ui.forwardSearch) {
    ui.forwardSearch.value = "";
  }
  updateForwardSubtitle(record);
  renderForwardList();
  if (ui.forwardModal) {
    ui.forwardModal.hidden = false;
    requestAnimationFrame(() => ui.forwardModal?.classList.add("is-visible"));
  }
}

function hideForwardModal() {
  if (!ui.forwardModal || ui.forwardModal.hidden) return;
  ui.forwardModal.classList.remove("is-visible");
  ui.forwardModal.hidden = true;
  state.forwardContext.source = null;
  state.forwardContext.filter = "";
  state.forwardContext.selectedTarget = null;
  updateForwardSelectionUI();
}

function updateForwardSubtitle(record) {
  if (!ui.forwardSubtitle) return;
  const message = record?.message;
  const text = message?.text || "";
  
  // Check if it's a voice message
  if (message?.meta?.voice) {
    ui.forwardSubtitle.textContent = "Voice message";
    return;
  }
  
  // Check if it's a scan report (via meta or prefix)
  if (message?.meta?.isReport && message?.meta?.report) {
    const name = message.meta.report.tokenInfo?.name || "Token";
    ui.forwardSubtitle.textContent = `Scan Report: ${name}`;
    return;
  }
  if (text.includes(SCAN_REPORT_PREFIX)) {
    const report = parseScanReportMessage(text);
    ui.forwardSubtitle.textContent = `Scan Report: ${report?.tokenInfo?.name || "Token"}`;
    return;
  }
  const preview = truncateText(text || "[No text]", FORWARD_PREVIEW_LIMIT);
  ui.forwardSubtitle.textContent = preview;
}

function renderForwardList() {
  if (!ui.forwardList) return;
  const query = (state.forwardContext.filter || "").trim().toLowerCase();
  ui.forwardList.innerHTML = "";
  const contacts = state.contacts.filter((contact) => contact.isSaved);
  if (!contacts.length) {
    const empty = document.createElement("div");
    empty.className = "forward-modal__empty";
    empty.textContent = "No saved contacts yet";
    ui.forwardList.appendChild(empty);
    return;
  }
  const filtered = contacts
    .filter((contact) => {
      if (!query) return true;
      const label = (contact.localName || contact.pubkey || "").toLowerCase();
      return label.includes(query);
    })
    .sort((a, b) => {
      const labelA = (a.localName || a.pubkey).toLowerCase();
      const labelB = (b.localName || b.pubkey).toLowerCase();
      return labelA.localeCompare(labelB);
    });
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "forward-modal__empty";
    empty.textContent = "No matches found";
    ui.forwardList.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  filtered.forEach((contact) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "forward-item";
    button.dataset.forwardTarget = contact.pubkey;

    const avatar = document.createElement("div");
    avatar.className = "contact-avatar contact-avatar--sm";
    setAvatar(avatar, contact.pubkey, 38, getContactAvatarLabel(contact));

    const meta = document.createElement("div");
    meta.className = "forward-item__meta";
    const name = document.createElement("div");
    name.className = "forward-item__name";
    name.textContent = contact.localName || shortenPubkey(contact.pubkey, 6);
    const preview = document.createElement("div");
    preview.className = "forward-item__preview";
    preview.textContent = contact.lastMessage
      ? getMessagePreviewText(contact.lastMessage)
      : "No messages yet";
    meta.appendChild(name);
    meta.appendChild(preview);

    button.appendChild(avatar);
    button.appendChild(meta);
    fragment.appendChild(button);
  });
  ui.forwardList.appendChild(fragment);

  updateForwardSelectionUI();
}

function handleForwardRecipientSelect(pubkey) {
  const record = state.forwardContext.source;
  if (!record) {
    showToast("Nothing to forward");
    hideForwardModal();
    return;
  }
  state.forwardContext.selectedTarget = pubkey;
  updateForwardSelectionUI();
}

async function forwardMessageToContact(record, targetPubkey) {
  const normalizedTarget = normalizePubkey(targetPubkey);
  if (!normalizedTarget) {
    showToast("Invalid recipient");
    return;
  }
  const message = record.message;
  
  // Handle scanner report messages - send as scan report, not forward
  if (message.meta?.isReport && message.meta?.report) {
    const report = message.meta.report;
    // Create minimal payload to avoid message truncation
    const reportPayload = {
      tokenInfo: {
        name: report.tokenInfo?.name,
        symbol: report.tokenInfo?.symbol,
        address: report.tokenInfo?.address,
        logoUrl: report.tokenInfo?.logoUrl,
      },
      trustScore: report.trustScore,
      market: {
        priceUsd: report.market?.priceUsd,
        marketCap: report.market?.marketCap,
        liquidity: report.market?.liquidity,
        volume24h: report.market?.volume24h,
        priceChange: report.market?.priceChange,
      },
      security: {
        launchpad: report.security?.launchpad,
        mintRenounced: report.security?.mintRenounced,
        freezeAuthorityEnabled: report.security?.freezeAuthorityEnabled,
        lpStatus: report.security?.lpStatus,
        isMutable: report.security?.isMutable,
        noTransferTax: report.security?.noTransferTax,
        transferTax: report.security?.transferTax,
        isDexVerified: report.security?.isDexVerified,
        isCto: report.security?.isCto,
        hasActiveAd: report.security?.hasActiveAd,
        holderConcentration: report.security?.holderConcentration,
      },
      isShared: true,
      clusterCount: (report.clusters || []).length,
      socials: (report.socials || []).slice(0, 3).map(s => ({
        type: s.type,
        label: s.label,
        url: s.url,
      })),
    };
    const shareText = SCAN_REPORT_PREFIX + JSON.stringify(reportPayload);
    
    setActiveNav("all");
    await setActiveContact(normalizedTarget);
    await handleSendMessage(shareText);
    showToast("Report shared");
    return;
  }
  
  // Check if message text is already a scan report
  const existingReport = parseScanReportMessage(message.text);
  if (existingReport) {
    setActiveNav("all");
    await setActiveContact(normalizedTarget);
    await handleSendMessage(message.text);
    showToast("Report shared");
    return;
  }
  
  const baseText = (message.text || "").slice(0, MAX_MESSAGE_LENGTH);
  const forwardMeta = buildForwardMeta(record);
  const envelope = createForwardEnvelope(forwardMeta, baseText);
  const success = await sendPreparedMessage({
    targetPubkey: normalizedTarget,
    displayText: baseText,
    outboundText: envelope.text,
    forwardMeta: envelope.forward,
  });
  if (success) {
    showToast("Message forwarded");
    await setActiveContact(normalizedTarget);
  }
}

async function handleDeleteMessage(messageId) {
  const record = findMessageRecordById(messageId);
  if (!record) {
    showToast("Message not found");
    return;
  }

  if (hasWindow) {
    const confirmed = window.confirm("Delete this message? It will only be removed for you.");
    if (!confirmed) {
      return;
    }
  }

  try {
    await removeMessageFromStore(messageId);
  } catch (error) {
    console.warn("Failed to delete message", error);
    showToast("Failed to delete message");
    return;
  }

  const currentList = state.messages.get(record.contactKey) || [];
  const nextList = currentList.filter((item) => item.id !== messageId);
  state.messages.set(record.contactKey, nextList);

  if (state.activeContactKey === record.contactKey) {
    renderMessages(record.contactKey);
    updateConversationMeta(record.contactKey);
  }

  await refreshContacts(false);
  showToast("Message deleted");
}
function updateForwardSelectionUI() {
  if (!ui.forwardSelection || !ui.forwardConfirmButton || !ui.forwardSelectionName) return;
  const target = state.forwardContext.selectedTarget;
  if (!target) {
    ui.forwardSelection.hidden = true;
    ui.forwardSelectionName.textContent = "";
    ui.forwardConfirmButton.disabled = true;
    return;
  }
  const contact = state.contacts.find((item) => item.pubkey === target);
  ui.forwardSelection.hidden = false;
  ui.forwardSelectionName.textContent = contact?.localName || shortenPubkey(target, 6);
  ui.forwardConfirmButton.disabled = false;
}

function handleTimelineContextMenu(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    hideMessageContextMenu();
    return;
  }
  const bubble = target.closest(".bubble");
  if (!bubble || !bubble.dataset.messageId) {
    hideMessageContextMenu();
    return;
  }
  event.preventDefault();
  const direction = bubble.classList.contains("bubble--out") ? "out" : "in";
  showMessageContextMenu(event.clientX, event.clientY, bubble.dataset.messageId, direction);
}

function showMessageContextMenu(clientX, clientY, messageId, direction = "in") {
  if (!ui.messageMenu) return;
  messageMenuState.messageId = messageId;
  messageMenuState.direction = direction;
  ui.messageMenu.dataset.direction = direction;
  ui.messageMenu.hidden = false;
  requestAnimationFrame(() => {
    if (!ui.messageMenu) return;
    const rect = ui.messageMenu.getBoundingClientRect();
    const margin = 12;
    let x = clientX;
    let y = clientY;
    if (x + rect.width > window.innerWidth - margin) {
      x = window.innerWidth - rect.width - margin;
    }
    if (y + rect.height > window.innerHeight - margin) {
      y = window.innerHeight - rect.height - margin;
    }
    ui.messageMenu.style.left = `${Math.max(margin, x)}px`;
    ui.messageMenu.style.top = `${Math.max(margin, y)}px`;
    ui.messageMenu.classList.add("is-visible");
  });
}

function hideMessageContextMenu() {
  if (!ui.messageMenu || ui.messageMenu.hidden) return;
  ui.messageMenu.classList.remove("is-visible");
  ui.messageMenu.hidden = true;
  messageMenuState.messageId = null;
}

function findMessageById(messageId) {
  if (!messageId) return null;
  for (const [contactKey, list] of state.messages.entries()) {
    const match = list.find((item) => item.id === messageId);
    if (match) {
      return { contactKey, message: match };
    }
  }
  return null;
}

function startReplyToMessage(messageId) {
  const record = findMessageById(messageId);
  if (!record) return;
  const contactName =
    record.message.direction === "out" ? getSelfDisplayName() : getContactDisplayName(record.contactKey);
  state.replyContext = {
    messageId: record.message.id,
    contactKey: record.contactKey,
    author: contactName || "Reply",
    preview: buildReplyPreviewText(record.message) || "[No text]",
    direction: record.message.direction,
  };
  updateReplyPreview();
  ui.messageInput?.focus();
}

function getActiveReplyContext() {
  if (
    state.replyContext &&
    state.replyContext.contactKey &&
    state.replyContext.contactKey === state.activeContactKey
  ) {
    return state.replyContext;
  }
  return null;
}

function updateReplyPreview() {
  if (!ui.replyPreview) return;
  const context = getActiveReplyContext();
  if (!context) {
    ui.replyPreview.hidden = true;
    return;
  }
  ui.replyPreview.hidden = false;
  setTextContent(ui.replyAuthor, context.author || "Reply");
  setTextContent(ui.replyText, context.preview || "");
}

function clearReplyContext() {
  if (!state.replyContext) return;
  state.replyContext = null;
  updateReplyPreview();
}

function buildReplyPreviewText(message) {
  if (!message) return "";
  // Check for voice message
  if (message.meta?.voice) {
    return "Voice message";
  }
  const payment = ensurePaymentMeta(message);
  if (payment) {
    const amountLabel = formatSolAmount(payment.lamports);
    const counterpart = message.direction === "out" ? payment.to : payment.from;
    const name = getContactDisplayName(counterpart) || shortenPubkey(counterpart, 6);
    return message.direction === "out"
      ? `You sent ${amountLabel} SOL to ${name}`
      : `${name} sent you ${amountLabel} SOL`;
  }
  const baseText = message.text || "";
  const safeText = baseText || "[No text]";
  return truncateText(safeText, REPLY_PREVIEW_LIMIT);
}

function createReplyEnvelope(context, text) {
  const payload = {
    id: context.messageId,
    author: context.author || "",
    preview: context.preview || "",
    direction: context.direction || "in",
  };
  const encoded = bytesToBase64(textEncoder.encode(JSON.stringify(payload)));
  return {
    text: `${REPLY_PREFIX}${encoded}${REPLY_DELIMITER}${text}`,
    reply: payload,
  };
}

function parseReplyEnvelope(rawText) {
  if (typeof rawText !== "string" || !rawText.startsWith(REPLY_PREFIX)) {
    return null;
  }
  const remainder = rawText.slice(REPLY_PREFIX.length);
  const delimiterIndex = remainder.indexOf(REPLY_DELIMITER);
  if (delimiterIndex === -1) {
    return null;
  }
  const encoded = remainder.slice(0, delimiterIndex);
  const rest = remainder.slice(delimiterIndex + REPLY_DELIMITER.length);
  try {
    const decoded = JSON.parse(textDecoder.decode(base64ToBytes(encoded)));
    return {
      text: rest.trimStart(),
      reply: {
        id: decoded.id || null,
        author: decoded.author || "",
        preview: decoded.preview || "",
        direction: decoded.direction || "in",
      },
    };
  } catch (error) {
    console.warn("Failed to parse reply payload", error);
    return null;
  }
}

function ensureReplyMeta(message) {
  if (!message) return null;
  if (message.meta?.replyTo) {
    return message.meta.replyTo;
  }
  if (typeof message.text !== "string") {
    return null;
  }
  const parsed = parseReplyEnvelope(message.text);
  if (!parsed) {
    return null;
  }
  message.text = parsed.text;
  message.meta = {
    ...(message.meta || {}),
    replyTo: parsed.reply,
  };
  return parsed.reply;
}

function createForwardEnvelope(meta, text) {
  const payload = {
    originalMessageId: meta?.originalMessageId || meta?.id || null,
    author: meta?.author || "Unknown",
    authorPubkey: meta?.authorPubkey || "",
    timestamp: meta?.timestamp || meta?.originalTimestamp || Date.now(),
  };
  const encoded = bytesToBase64(textEncoder.encode(JSON.stringify(payload)));
  return {
    text: `${FORWARD_PREFIX}${encoded}${FORWARD_DELIMITER}${text}`,
    forward: {
      author: payload.author,
      authorPubkey: payload.authorPubkey,
      originalMessageId: payload.originalMessageId,
      timestamp: payload.timestamp,
    },
  };
}

function parseForwardEnvelope(rawText) {
  if (typeof rawText !== "string" || !rawText.startsWith(FORWARD_PREFIX)) {
    return null;
  }
  const remainder = rawText.slice(FORWARD_PREFIX.length);
  const delimiterIndex = remainder.indexOf(FORWARD_DELIMITER);
  if (delimiterIndex === -1) {
    return null;
  }
  const encoded = remainder.slice(0, delimiterIndex);
  const rest = remainder.slice(delimiterIndex + FORWARD_DELIMITER.length);
  try {
    const decoded = JSON.parse(textDecoder.decode(base64ToBytes(encoded)));
    return {
      text: rest.trimStart(),
      forward: {
        author: decoded.author || "Unknown",
        authorPubkey: decoded.authorPubkey || "",
        originalMessageId: decoded.originalMessageId || decoded.id || null,
        timestamp: decoded.timestamp || decoded.originalTimestamp || Date.now(),
      },
    };
  } catch (error) {
    console.warn("Failed to parse forward payload", error);
    return null;
  }
}

function ensureForwardMeta(message) {
  if (!message) return null;
  if (message.meta?.forwardedFrom) {
    return message.meta.forwardedFrom;
  }
  if (typeof message.text !== "string") {
    return null;
  }
  const parsed = parseForwardEnvelope(message.text);
  if (!parsed) {
    return null;
  }
  message.text = parsed.text;
  message.meta = {
    ...(message.meta || {}),
    forwardedFrom: parsed.forward,
  };
  return parsed.forward;
}

// Reaction functions
function buildReactionMessage(targetMessageId, emoji, action = "add") {
  const payload = { targetMessageId, emoji, action, timestamp: Date.now() };
  return `${REACTION_PREFIX}${JSON.stringify(payload)}`;
}

function createReactionsDisplay(message) {
  const reactions = message.meta?.reactions;
  if (!reactions || Object.keys(reactions).length === 0) {
    return null;
  }
  
  const container = document.createElement("div");
  container.className = "bubble__reactions";
  
  for (const [emoji, users] of Object.entries(reactions)) {
    if (users.length === 0) continue;
    
    const badge = document.createElement("button");
    badge.className = "reaction-badge";
    badge.type = "button";
    badge.dataset.emoji = emoji;
    badge.dataset.messageId = message.id;
    
    const myPubkey = latestAppState?.walletPubkey || getWalletPubkey();
    if (users.includes(myPubkey)) {
      badge.classList.add("reaction-badge--mine");
    }
    
    // Only show count if more than 1 reaction
    const countHtml = users.length > 1 ? `<span class="reaction-badge__count">${users.length}</span>` : "";
    badge.innerHTML = `<span class="reaction-badge__emoji">${emoji}</span>${countHtml}`;
    container.appendChild(badge);
  }
  
  return container;
}

function createReactionButton(messageId) {
  const btn = document.createElement("button");
  btn.className = "bubble__reaction-btn";
  btn.type = "button";
  btn.dataset.messageId = messageId;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`;
  btn.title = "Add reaction";
  return btn;
}

function createReactionPicker(messageId) {
  const picker = document.createElement("div");
  picker.className = "reaction-picker";
  picker.dataset.messageId = messageId;
  
  for (const emoji of AVAILABLE_REACTIONS) {
    const btn = document.createElement("button");
    btn.className = "reaction-picker__btn";
    btn.type = "button";
    btn.dataset.emoji = emoji;
    btn.dataset.messageId = messageId;
    btn.textContent = emoji;
    picker.appendChild(btn);
  }
  
  return picker;
}

let activeReactionPicker = null;

function toggleReactionPicker(buttonEl, messageId) {
  // Hide any existing picker
  hideReactionPicker();
  
  // Create and show new picker
  const picker = createReactionPicker(messageId);
  const bubble = buttonEl.closest(".bubble");
  if (bubble) {
    bubble.appendChild(picker);
    activeReactionPicker = picker;
    
    // Position picker above the button
    requestAnimationFrame(() => {
      picker.classList.add("is-visible");
    });
  }
}

function hideReactionPicker() {
  if (activeReactionPicker) {
    activeReactionPicker.remove();
    activeReactionPicker = null;
  }
}

async function sendReaction(messageId, emoji) {
  if (!state.activeContactKey) return;
  if (!latestAppState?.isAuthenticated) return;
  
  const messages = state.messages.get(state.activeContactKey) || [];
  const message = messages.find(m => m.id === messageId);
  if (!message) return;
  
  const myPubkey = latestAppState?.walletPubkey || getWalletPubkey();
  const reactions = message.meta?.reactions || {};
  const isRemoving = reactions[emoji]?.includes(myPubkey);
  const action = isRemoving ? "remove" : "add";
  
  // Update local state immediately
  await addReactionToMessage(messageId, emoji, state.activeContactKey);
  
  // Re-render messages
  renderMessages(state.activeContactKey);
  
  // Send reaction to recipient
  const reactionText = buildReactionMessage(messageId, emoji, action);
  const contactPubkey = state.activeContactKey;
  
  try {
    const sessionSecret = await ensureSessionSecret(contactPubkey);
    if (!sessionSecret) {
      console.warn("Cannot send reaction: no session secret");
      return;
    }
    
    const encrypted = encryptWithSecret(sessionSecret, reactionText);
    if (!encrypted) {
      console.warn("Cannot send reaction: encryption failed");
      return;
    }
    
    // Include sender's encryption key
    const myEncryptionKey = state.encryptionKeys?.publicKey || state.profile?.encryptionPublicKey;
    
    await sendMessage({
      to: contactPubkey,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      version: encrypted.version,
      timestamp: Date.now(),
      ...(myEncryptionKey ? { senderEncryptionKey: myEncryptionKey } : {}),
    });
  } catch (error) {
    console.error("Failed to send reaction:", error);
  }
}

function parseReactionMessage(text) {
  if (typeof text !== "string" || !text.startsWith(REACTION_PREFIX)) {
    return null;
  }
  try {
    const json = text.slice(REACTION_PREFIX.length);
    const parsed = JSON.parse(json);
    if (parsed.targetMessageId && parsed.emoji) {
      return parsed;
    }
  } catch (error) {
    console.warn("Failed to parse reaction message", error);
  }
  return null;
}

function isReactionMessage(text) {
  return typeof text === "string" && text.startsWith(REACTION_PREFIX);
}

async function addReactionToMessage(messageId, emoji, contactKey) {
  const messages = state.messages.get(contactKey) || [];
  const message = messages.find(m => m.id === messageId);
  if (!message) return false;
  
  const reactions = message.meta?.reactions || {};
  const myPubkey = latestAppState?.walletPubkey || getWalletPubkey();
  
  // Toggle reaction
  if (reactions[emoji]?.includes(myPubkey)) {
    // Remove reaction
    reactions[emoji] = reactions[emoji].filter(p => p !== myPubkey);
    if (reactions[emoji].length === 0) {
      delete reactions[emoji];
    }
  } else {
    // Add reaction
    if (!reactions[emoji]) {
      reactions[emoji] = [];
    }
    reactions[emoji].push(myPubkey);
  }
  
  message.meta = { ...(message.meta || {}), reactions };
  
  // Save to IndexedDB
  await updateMessageMeta(messageId, { reactions });
  
  // Broadcast to other tabs
  const myPubkeyForBroadcast = latestAppState?.walletPubkey || getWalletPubkey();
  broadcastSync("REACTION", {
    messageId,
    emoji,
    user: myPubkeyForBroadcast,
    action: reactions[emoji]?.includes(myPubkeyForBroadcast) ? "add" : "remove",
  });
  
  return true;
}

async function updateMessageMeta(messageId, metaUpdate) {
  // Update in state
  for (const [contactKey, messages] of state.messages) {
    const message = messages.find(m => m.id === messageId);
    if (message) {
      message.meta = { ...(message.meta || {}), ...metaUpdate };
      // Save to IndexedDB
      await updateMessageMetaInDb(messageId, message.meta);
      break;
    }
  }
}

async function handleIncomingReaction(reactionData, fromPubkey) {
  const { targetMessageId, emoji, action } = reactionData;
  
  // Find the message
  for (const [contactKey, messages] of state.messages) {
    const message = messages.find(m => m.id === targetMessageId);
    if (message) {
      const reactions = message.meta?.reactions || {};
      
      if (action === "add") {
        if (!reactions[emoji]) {
          reactions[emoji] = [];
        }
        if (!reactions[emoji].includes(fromPubkey)) {
          reactions[emoji].push(fromPubkey);
        }
      } else if (action === "remove") {
        if (reactions[emoji]) {
          reactions[emoji] = reactions[emoji].filter(p => p !== fromPubkey);
          if (reactions[emoji].length === 0) {
            delete reactions[emoji];
          }
        }
      }
      
      message.meta = { ...(message.meta || {}), reactions };
      
      // Save to IndexedDB
      await updateMessageMetaInDb(targetMessageId, message.meta);
      
      // Re-render if this chat is active
      if (state.activeContactKey === contactKey) {
        renderMessages(contactKey);
      }
      
      return true;
    }
  }
  return false;
}

// URL regex pattern for detecting links
const URL_REGEX = /(\b(?:https?:\/\/|www\.)[^\s<>\"\']+)/gi;

// Pump.fun URL pattern
const PUMP_FUN_REGEX = /https?:\/\/(?:www\.)?pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/i;
const PUMP_FUN_URL_REGEX = /https?:\/\/(?:www\.)?pump\.fun\/(?:coin\/)?[1-9A-HJ-NP-Za-km-z]{32,44}/i;

// DexScreener URL pattern (solana only for now)
const DEXSCREENER_REGEX = /https?:\/\/(?:www\.)?dexscreener\.com\/solana\/([a-zA-Z0-9]{30,50})/i;
const DEXSCREENER_URL_REGEX = /https?:\/\/(?:www\.)?dexscreener\.com\/solana\/[a-zA-Z0-9]{30,50}/i;

// Terminal (Padre) URL pattern
const TERMINAL_REGEX = /https?:\/\/(?:www\.)?trade\.padre\.gg\/trade\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/i;
const TERMINAL_URL_REGEX = /https?:\/\/(?:www\.)?trade\.padre\.gg\/trade\/solana\/[1-9A-HJ-NP-Za-km-z]{32,44}/i;

// Axiom URL pattern (includes optional query params like ?chain=sol)
const AXIOM_REGEX = /https?:\/\/(?:www\.)?axiom\.trade\/meme\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\?[^\s]*)?/i;
const AXIOM_URL_REGEX = /https?:\/\/(?:www\.)?axiom\.trade\/meme\/[1-9A-HJ-NP-Za-km-z]{32,44}(?:\?[^\s]*)?/i;

function extractPumpFunToken(text) {
  const match = text.match(PUMP_FUN_REGEX);
  return match ? match[1] : null;
}

function extractDexScreenerPair(text) {
  const match = text.match(DEXSCREENER_REGEX);
  return match ? match[1] : null;
}

function extractTerminalToken(text) {
  const match = text.match(TERMINAL_REGEX);
  return match ? match[1] : null;
}

function extractAxiomPair(text) {
  const match = text.match(AXIOM_REGEX);
  return match ? match[1] : null;
}

function extractPumpFunUrl(text) {
  const match = text.match(PUMP_FUN_URL_REGEX);
  return match ? match[0] : null;
}

function extractDexScreenerUrl(text) {
  const match = text.match(DEXSCREENER_URL_REGEX);
  return match ? match[0] : null;
}

function extractTerminalUrl(text) {
  const match = text.match(TERMINAL_URL_REGEX);
  return match ? match[0] : null;
}

function extractAxiomUrl(text) {
  const match = text.match(AXIOM_URL_REGEX);
  return match ? match[0] : null;
}

function extractTokenUrl(text) {
  return extractPumpFunUrl(text) || extractDexScreenerUrl(text) || extractTerminalUrl(text) || extractAxiomUrl(text);
}

function isPureTokenLink(text) {
  // Check if text is ONLY a token link (pump.fun, dexscreener, terminal, or axiom) with optional whitespace
  const trimmed = text.trim();
  const isPumpFun = PUMP_FUN_URL_REGEX.test(trimmed) && trimmed.replace(PUMP_FUN_URL_REGEX, '').trim() === '';
  const isDexScreener = DEXSCREENER_URL_REGEX.test(trimmed) && trimmed.replace(DEXSCREENER_URL_REGEX, '').trim() === '';
  const isTerminal = TERMINAL_URL_REGEX.test(trimmed) && trimmed.replace(TERMINAL_URL_REGEX, '').trim() === '';
  const isAxiom = AXIOM_URL_REGEX.test(trimmed) && trimmed.replace(AXIOM_URL_REGEX, '').trim() === '';
  return isPumpFun || isDexScreener || isTerminal || isAxiom;
}

async function fetchTokenPreviewSafe(tokenAddress) {
  try {
    const response = await fetchTokenPreview(tokenAddress);
    return response?.preview || null;
  } catch (error) {
    console.warn('Failed to fetch token preview:', error);
    return null;
  }
}

async function fetchDexPairPreviewSafe(pairAddress) {
  try {
    const response = await fetchDexPairPreview(pairAddress);
    return response || null;
  } catch (error) {
    console.warn('Failed to fetch DexScreener pair preview:', error);
    return null;
  }
}

// Extract first generic URL from text (excluding token-specific URLs)
function extractGenericUrl(text) {
  const matches = text.match(URL_REGEX);
  if (!matches) return null;
  
  for (const url of matches) {
    // Skip token-specific URLs
    if (PUMP_FUN_URL_REGEX.test(url) || 
        DEXSCREENER_URL_REGEX.test(url) || 
        TERMINAL_URL_REGEX.test(url) || 
        AXIOM_URL_REGEX.test(url)) {
      continue;
    }
    // Ensure it starts with http
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    // Handle www. URLs
    if (url.startsWith('www.')) {
      return 'https://' + url;
    }
  }
  return null;
}

// Link preview cache to avoid duplicate requests
const linkPreviewCache = new Map();
const LINK_PREVIEW_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchLinkPreview(url) {
  if (!url) return null;
  
  // Check cache first
  const cached = linkPreviewCache.get(url);
  if (cached && Date.now() - cached.timestamp < LINK_PREVIEW_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const data = await fetchLinkPreviewApi(url);
    
    // Cache the result
    linkPreviewCache.set(url, { data, timestamp: Date.now() });
    
    return data;
  } catch (error) {
    console.warn('Failed to fetch link preview:', error);
    return null;
  }
}

async function fetchLinkPreviewSafe(url) {
  try {
    return await fetchLinkPreview(url);
  } catch (error) {
    console.warn('Link preview error:', error);
    return null;
  }
}

function formatNumber(num) {
  if (!num || isNaN(num)) return '—';
  const n = parseFloat(num);
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatPrice(price) {
  if (!price || isNaN(price)) return '—';
  const p = parseFloat(price);

  // Show tiny prices in fixed-point form (no scientific notation) with trimmed zeros
  if (p < 0.01) {
    const decimals = p < 0.00001 ? 10 : 8; // more precision for ultra-low prices
    const fixed = p.toFixed(decimals);
    // Trim trailing zeros and possible trailing dot
    const cleaned = fixed.replace(/0+$/, '').replace(/\.$/, '');
    return `$${cleaned}`;
  }

  if (p < 1) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(2)}`;
}

function formatPercentChange(change) {
  if (!change || isNaN(change)) return '';
  const c = parseFloat(change);
  const sign = c >= 0 ? '+' : '';
  return `${sign}${c.toFixed(1)}%`;
}

function linkifyText(text) {
  const safe = escapeHtml(text);
  return safe.replace(URL_REGEX, (url) => {
    const href = url.startsWith('www.') ? `https://${url}` : url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="bubble__link">${url}</a>`;
  });
}

const highlightQuery = (text, query) => {
  const linked = linkifyText(text);
  const regex = new RegExp(`(${escapeRegExp(query)})`, "gi");
  return linked.replace(regex, "<mark>$1</mark>");
};

function escapeHtml(text) {
  return text.replace(/[&<>\"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toggleComposer(enabled) {
  if (ui.messageInput) ui.messageInput.disabled = !enabled;
  if (ui.sendButton) ui.sendButton.disabled = !enabled;
  if (ui.emojiButton) {
    ui.emojiButton.disabled = !enabled;
  }
  if (!enabled && emojiPicker?.isOpen) {
    emojiPicker.close();
  }
  updatePaymentControls();
}

function toggleConnectOverlay(visible, showContinueSign = false) {
  console.log('[Chat] toggleConnectOverlay called, visible:', visible, 'showContinueSign:', showContinueSign);
  
  if (!ui.connectOverlay) {
    console.log('[Chat] connectOverlay element not found!');
    return;
  }
  
  ui.connectOverlay.hidden = !visible;
  
  // Toggle between connect panel and continue sign panel
  // IMPORTANT: Always set both panels to ensure correct state
  if (ui.connectPanel && ui.continueSignPanel) {
    ui.connectPanel.hidden = showContinueSign;
    ui.continueSignPanel.hidden = !showContinueSign;
    console.log('[Chat] connectPanel.hidden:', ui.connectPanel.hidden, 'continueSignPanel.hidden:', ui.continueSignPanel.hidden);
  } else {
    console.warn('[Chat] Panel elements not found! connectPanel:', !!ui.connectPanel, 'continueSignPanel:', !!ui.continueSignPanel);
  }
}

function getPaymentAmountValue() {
  if (!ui.paymentAmount) return 0;
  const parsed = Number.parseFloat(ui.paymentAmount.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function updatePaymentControls() {
  if (!ui.paymentSendButton) return;
  const hasContact = Boolean(state.activeContactKey);
  const amount = getPaymentAmountValue();
  const hasAmount = amount > 0;
  const canSend = Boolean(hasContact && latestAppState?.isAuthenticated && hasAmount && !isPaymentSubmitting);
  ui.paymentSendButton.disabled = !canSend;
}

function updatePaymentRecipient(pubkey) {
  if (ui.paymentRecipient) {
    ui.paymentRecipient.textContent = pubkey ? shortenPubkey(pubkey, 6) : "—";
  }
  updatePaymentControls();
}

async function sendSystemPaymentMessage({ lamports, fromPubkey, toPubkey, signature }) {
  if (!state.activeContactKey) return;
  const timestamp = Date.now();
  const fromDisplay = getSelfDisplayName();
  const toDisplay = getContactDisplayName(toPubkey) || shortenPubkey(toPubkey, 6);
  const paymentMeta = {
    lamports,
    from: fromPubkey,
    to: toPubkey,
    fromName: fromDisplay,
    toName: toDisplay,
    signature,
  };
  const text = buildPaymentSystemText(paymentMeta);
  const message = {
    id: crypto.randomUUID(),
    contactKey: state.activeContactKey,
    direction: "out",
    text,
    timestamp,
    status: "sending",
    meta: {
      systemType: "payment",
      payment: paymentMeta,
    },
  };

  await addMessage(message);
  appendMessageToState(state.activeContactKey, message);
  renderMessages(state.activeContactKey);

  try {
    await sendMessage({
      to: state.activeContactKey,
      text,
      timestamp,
    });
    await setMessageStatus(message.id, "sent");
    const delivered = { ...message, status: "sent" };
    appendMessageToState(state.activeContactKey, delivered);
    renderMessages(state.activeContactKey);
    updateContactPreviewFromMessage(state.activeContactKey, delivered);
    triggerImmediatePoll();
  } catch (error) {
    console.error("Payment notification failed", error);
    await setMessageStatus(message.id, "failed");
    appendMessageToState(state.activeContactKey, { ...message, status: "failed" });
    renderMessages(state.activeContactKey);
    showToast("Payment sent, but notification could not be delivered");
  }
}

function handleCloseChat() {
  clearChatView();
  hideMobileChat();
  history.replaceState(null, "", "#/");
}

async function handleLogoutClick() {
  if (hasWindow && !window.confirm("Log out and disconnect wallet?")) {
    return;
  }
  try {
    await requestLogout();
    state.forwardContext = { source: null, filter: "", selectedTarget: null };
    hideForwardModal();
    clearReplyContext();
    showToast("Logged out");
  } catch (error) {
    console.error("Logout failed", error);
    showToast("Failed to log out");
  }
}

async function handleExportData() {
  try {
    const currentWallet = latestAppState?.walletPubkey || state.currentWallet;
    if (!currentWallet) {
      showToast("Connect wallet first");
      return;
    }
    
    const provider = getProviderInstance();
    const isMobile = isMobileDevice();
    
    // Check if we can sign
    if (!provider?.signMessage && !isMobile) {
      showToast("Wallet not available for signing");
      return;
    }
    
    // Ask for encryption password
    const password = await showPasswordModal({
      title: "Encrypt Backup",
      message: "Create a password to protect your backup. This password will be required to restore the backup.",
      confirmText: "Export",
      showConfirm: true
    });
    
    if (!password) {
      return; // User cancelled
    }
    
    // Get raw data without signature
    const dump = await exportLocalData(currentWallet);
    
    // Add localStorage settings (same as R2 backup)
    dump.localStorageSettings = collectLocalStorageSettings();
    
    // Create message to sign (text, not binary)
    const dataToSign = JSON.stringify({
      version: dump.version,
      exportedAt: dump.exportedAt,
      ownerWallet: dump.ownerWallet,
      contactsCount: dump.contacts?.length || 0,
      messagesCount: dump.messages?.length || 0,
    });
    
    const messageText = `SOLink Backup Verification\n\nThis signature proves ownership of this backup.\n\nData: ${dataToSign}`;
    const messageBytes = new TextEncoder().encode(messageText);
    
    let signatureBase58;
    
    if (isMobile && hasMobileSession()) {
      // For mobile, we skip signing for now (TODO: implement mobile signing)
      showToast("Mobile backup signing not yet supported");
      return;
    } else if (provider?.signMessage) {
      // Desktop wallet signing
      const signed = await provider.signMessage(messageBytes, 'utf8');
      const signature = 'signature' in signed ? signed.signature : signed;
      signatureBase58 = encodeBase58(signature);
    } else {
      showToast("Cannot sign backup");
      return;
    }
    
    // Add signature to dump
    dump.signature = signatureBase58;
    dump.signedMessage = messageText;
    
    // Encrypt the backup with password
    showToast("Encrypting backup...");
    const encryptedData = await encryptBackupWithPassword(dump, password);
    
    const blob = new Blob([encryptedData], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `solink-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.enc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast("Encrypted backup exported");
  } catch (error) {
    console.error("Export failed", error);
    if (error.message?.includes('User rejected')) {
      showToast("Signing cancelled");
    } else {
      showToast("Export failed");
    }
  }
}

async function verifyBackupSignature(parsed, expectedWallet) {
  // If no signature, it's an old backup - check wallet match only
  if (!parsed.signature || !parsed.signedMessage) {
    console.log('[Import] No signature in backup, checking wallet only');
    if (parsed.ownerWallet && parsed.ownerWallet !== expectedWallet) {
      return { valid: false, reason: 'WALLET_MISMATCH' };
    }
    return { valid: true, reason: 'NO_SIGNATURE' };
  }
  
  // Verify wallet matches
  if (parsed.ownerWallet !== expectedWallet) {
    return { valid: false, reason: 'WALLET_MISMATCH' };
  }
  
  try {
    // Recreate the message bytes
    const messageBytes = new TextEncoder().encode(parsed.signedMessage);
    
    // Decode signature and public key
    const signatureBytes = decodeBase58(parsed.signature);
    const publicKeyBytes = decodeBase58(parsed.ownerWallet);
    
    // Verify signature using nacl
    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    
    if (!isValid) {
      console.warn('[Import] Signature verification failed');
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }
    
    console.log('[Import] Signature verified successfully');
    return { valid: true, reason: 'VERIFIED' };
  } catch (error) {
    console.error('[Import] Signature verification error:', error);
    return { valid: false, reason: 'VERIFICATION_ERROR' };
  }
}

async function handleImportFileChange(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  const currentWallet = latestAppState?.walletPubkey || state.currentWallet;
  if (!currentWallet) {
    showToast("Connect wallet first");
    return;
  }

  if (hasWindow && !window.confirm("Importing will replace your current local data. Continue?")) {
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const content = reader.result;
      // Ask for decryption password
      const password = await showPasswordModal({
        title: "Decrypt Backup",
        message: "Enter the password used to encrypt this backup.",
        confirmText: "Decrypt",
        showConfirm: false
      });
      
      if (!password) {
        return; // User cancelled
      }
      
      let parsed;
      try {
        showToast("Decrypting backup...");
        parsed = await decryptBackupWithPassword(content, password);
      } catch (decryptError) {
        if (decryptError.message === 'WRONG_PASSWORD') {
          showToast("Wrong password");
        } else {
          showToast("Failed to decrypt backup");
        }
        return;
      }
      
      // Verify backup ownership (wallet must match, signature is optional)
      if (parsed.ownerWallet && parsed.ownerWallet !== currentWallet) {
        console.warn('[Import] Wallet mismatch:', parsed.ownerWallet, '!==', currentWallet);
        showToast("Backup belongs to a different wallet");
        return;
      }
      
      console.log('[Import] Wallet check passed, importing data...');
      await importLocalData(parsed, currentWallet);
      console.log('[Import] Data imported to IndexedDB');
      
      // Restore localStorage settings if present
      if (parsed.localStorageSettings) {
        restoreLocalStorageSettings(parsed.localStorageSettings);
        console.log("[Import] Settings restored from backup");
      }
      
      // Sync imported data to R2 immediately (before reload)
      if (CLOUD_SYNC_ENABLED && getSessionToken() && state.currentWallet) {
        showToast("Syncing to cloud...");
        console.log("[Import] Syncing imported data to R2...");
        try {
          // Call performFullBackup directly (not debounced)
          const exportData = await exportLocalData(state.currentWallet);
          const localStorageSettings = collectLocalStorageSettings();
          const backupData = {
            version: 3,
            syncedAt: Date.now(),
            ownerWallet: state.currentWallet,
            contacts: exportData.contacts || [],
            messages: exportData.messages || [],
            profile: exportData.profile || null,
            localStorageSettings,
          };
          const encrypted = await encryptFullBackup(backupData);
          if (encrypted) {
            const result = await saveBackupToCloud(encrypted);
            console.log("[Import] R2 sync completed:", result);
          }
        } catch (syncErr) {
          console.warn("[Import] R2 sync failed:", syncErr.message);
        }
      }
      
      showToast("Backup imported");
      setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      console.error("Import failed", error);
      if (error.message === "WALLET_MISMATCH") {
        showToast("Backup belongs to a different wallet");
      } else {
        showToast("Import failed");
      }
    }
  };
  reader.onerror = () => {
    console.error("Failed to read backup file");
    showToast("Import failed");
  };
  reader.readAsText(file);
}

async function handleSendPayment() {
  if (isPaymentSubmitting) return;
  if (!state.activeContactKey) {
    showToast("Select a chat first");
    return;
  }
  if (!latestAppState?.isAuthenticated) {
    showToast("Connect wallet to send SOL");
    return;
  }
  const amount = getPaymentAmountValue();
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast("Enter a valid amount");
    return;
  }
  const lamports = Math.round(amount * LAMPORTS_PER_SOL);
  if (lamports <= 0) {
    showToast("Amount is too small");
    return;
  }
  let toPubkey;
  try {
    toPubkey = new PublicKey(state.activeContactKey);
  } catch {
    showToast("Invalid recipient");
    return;
  }

  const provider = getProviderInstance();
  const isMobile = isMobileDevice();
  
  // Check if we have a provider or mobile session
  if (!provider?.publicKey && !hasMobileSession()) {
    showToast("Connect wallet first");
    return;
  }
  
  // Get from pubkey - either from provider or from wallet state
  let fromPubkey;
  if (provider?.publicKey) {
    fromPubkey = provider.publicKey;
  } else if (isMobile && hasMobileSession()) {
    // On mobile, use the wallet pubkey from state
    const walletPubkeyStr = getWalletPubkey();
    if (!walletPubkeyStr) {
      showToast("Wallet not connected");
      return;
    }
    try {
      fromPubkey = new PublicKey(walletPubkeyStr);
    } catch {
      showToast("Invalid wallet address");
      return;
    }
  } else {
    showToast("Wallet unavailable");
    return;
  }
  const fromPubkeyString = fromPubkey.toBase58();
  const toPubkeyString = toPubkey.toBase58();

  try {
    isPaymentSubmitting = true;
    updatePaymentControls();
    const latestBlockhash = await solanaConnection.getLatestBlockhash();
    const transaction = new Transaction({
      recentBlockhash: latestBlockhash.blockhash,
      feePayer: fromPubkey,
    }).add(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports,
      }),
    );

    let signature;
    
    // Check if we need to use mobile deeplinks
    if (isMobile && !provider?.signAndSendTransaction) {
      // Send SOL not supported on mobile without wallet extension
      showToast("Send SOL is available on desktop only");
      return;
    } else if (typeof provider?.signAndSendTransaction === "function") {
      const result = await provider.signAndSendTransaction(transaction);
      signature = typeof result === "string" ? result : result?.signature;
    } else if (typeof provider?.signTransaction === "function") {
      const signed = await provider.signTransaction(transaction);
      signature = await solanaConnection.sendRawTransaction(signed.serialize());
    } else {
      throw new Error("Wallet cannot send transactions");
    }

    if (!signature) {
      throw new Error("Failed to send transaction");
    }

    showToast("Payment submitted");
    await solanaConnection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed",
    );
    showToast("Payment confirmed");
    if (ui.paymentAmount) {
      ui.paymentAmount.value = "";
    }
    await sendSystemPaymentMessage({
      lamports,
      fromPubkey: fromPubkeyString,
      toPubkey: toPubkeyString,
      signature,
    });
  } catch (error) {
    console.error("Payment failed", error);
    showToast(error.message || "Payment failed");
  } finally {
    isPaymentSubmitting = false;
    updatePaymentControls();
  }
}

function insertEmojiAtCursor(emojiChar) {
  if (!ui.messageInput || !emojiChar) return;
  const input = ui.messageInput;
  const start = Math.max(input.selectionStart ?? input.value.length, 0);
  const end = Math.max(input.selectionEnd ?? input.value.length, 0);
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  input.value = `${before}${emojiChar}${after}`;
  const cursor = before.length + emojiChar.length;
  requestAnimationFrame(() => {
    input.setSelectionRange(cursor, cursor);
    input.focus();
    handleMessageInput();
  });
}

function initializeEmojiPicker() {
  if (!ui.emojiButton || emojiPicker) return;
  emojiPicker = createPopup(
    {
      emojiSize: "1.6rem",
      showPreview: false,
      showVariants: false,
      showSearch: true,
      showRecents: true,
      theme: "dark",
    },
    {
      referenceElement: ui.emojiButton,
      position: "top-end",
      rootElement: document.body,
    },
  );

  emojiPicker.addEventListener("emoji:select", (selection) => {
    const emojiChar =
      selection?.emoji ||
      selection?.unicode ||
      selection?.label ||
      selection?.detail?.emoji ||
      selection?.detail?.unicode ||
      selection?.detail?.selection?.emoji;
    if (!emojiChar) return;
    insertEmojiAtCursor(emojiChar);
    emojiPicker.close();
  });

  emojiPicker.addEventListener("picker:open", () => {
    ui.emojiButton?.classList.add("is-active");
  });

  emojiPicker.addEventListener("picker:close", () => {
    ui.emojiButton?.classList.remove("is-active");
    if (!ui.messageInput?.disabled) {
      ui.messageInput?.focus();
    }
  });
}

function toggleEmojiPicker() {
  if (!emojiPicker) return;
  if (emojiPicker.isOpen) {
    emojiPicker.close();
  } else {
    emojiPicker.open({ triggerElement: ui.emojiButton, referenceElement: ui.emojiButton });
  }
}

function handleMessageInput() {
  if (!ui.messageInput || !ui.charCounter) return;
  const text = ui.messageInput.value;
  setTextContent(ui.charCounter, `${text.length} / ${MAX_MESSAGE_LENGTH}`);
  if (text.length > MAX_MESSAGE_LENGTH) {
    ui.charCounter.classList.add("is-danger");
  } else {
    ui.charCounter.classList.remove("is-danger");
  }
  autoResizeTextarea(ui.messageInput);
}

async function sendPreparedMessage({
  targetPubkey,
  displayText,
  outboundText,
  replyMeta,
  forwardMeta,
  tokenPreview,
  tokenUrl,
  linkPreview,
}) {
  if (!targetPubkey) {
    showToast("Select a chat first");
    return false;
  }
  if (!latestAppState?.isAuthenticated) {
    showToast("Connect wallet to send messages");
    return false;
  }

  const normalized = normalizePubkey(targetPubkey);
  if (!normalized) {
    showToast("Invalid contact");
    return false;
  }

  await ensureContact(normalized);

  // Ensure our encryption key is published before sending
  const keys = await ensureEncryptionKeys();
  const localKey = keys?.publicKey;
  
  // Force publish if key doesn't match or not set
  if (localKey && state.profile?.encryptionPublicKey !== localKey) {
    console.log("[Send] Encryption key mismatch, publishing...");
    const published = await publishEncryptionKey(true);
    if (!published) {
      console.warn("[Send] Failed to publish encryption key, retrying...");
      await new Promise(r => setTimeout(r, 500));
      await publishEncryptionKey(true);
    }
  } else if (!state.profile?.encryptionPublicKey) {
    console.log("[Send] No encryption key in profile, publishing...");
    await publishEncryptionKey(true);
  }

  const trimmedDisplay = (displayText || "").slice(0, MAX_MESSAGE_LENGTH);
  const effectiveOutbound = outboundText || trimmedDisplay;
  const timestamp = Date.now();
  let encryptionMeta = null;
  let sendPayload = {
    to: normalized,
    text: effectiveOutbound,
    timestamp,
    ...(tokenPreview ? { tokenPreview } : {}),
  };
  const sessionSecret = await ensureSessionSecret(normalized);
  if (sessionSecret) {
    const encrypted = encryptWithSecret(sessionSecret, effectiveOutbound);
    if (encrypted) {
      encryptionMeta = { nonce: encrypted.nonce, version: encrypted.version };
      // Include sender's encryption key so recipient can decrypt
      const myEncryptionKey = state.encryptionKeys?.publicKey || state.profile?.encryptionPublicKey;
      sendPayload = {
        to: normalized,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        version: encrypted.version,
        timestamp,
        ...(tokenPreview ? { tokenPreview } : {}),
        ...(myEncryptionKey ? { senderEncryptionKey: myEncryptionKey } : {}),
      };
    }
  }

  const message = {
    id: crypto.randomUUID(),
    contactKey: normalized,
    direction: "out",
    text: trimmedDisplay,
    timestamp,
    status: "sending",
    meta: {
      encryption: encryptionMeta,
      ciphertext: encryptionMeta ? sendPayload.ciphertext : null,
      ...(replyMeta ? { replyTo: replyMeta } : {}),
      ...(forwardMeta ? { forwardedFrom: forwardMeta } : {}),
      ...(tokenPreview ? { tokenPreview, tokenUrl } : {}),
      ...(linkPreview ? { linkPreview } : {}),
    },
  };

  await addMessage(message);
  appendMessageToState(normalized, message);
  if (state.activeContactKey === normalized) {
    renderMessages(normalized);
  }

  try {
    await sendMessage(sendPayload);
    await setMessageStatus(message.id, "sent");
    appendMessageToState(normalized, {
      ...message,
      status: "sent",
      meta: {
        ...message.meta,
        encryption: encryptionMeta,
        ciphertext: encryptionMeta ? sendPayload.ciphertext : null,
      },
    });
    if (state.activeContactKey === normalized) {
      renderMessages(normalized);
    }
    updateContactPreviewFromMessage(normalized, {
      ...message,
      status: "sent",
      text: trimmedDisplay,
    });
    triggerImmediatePoll();
    
    // Broadcast to other tabs
    broadcastSync("MESSAGE_SENT", {
      contactKey: normalized,
      message: { ...message, status: "sent", text: trimmedDisplay },
    });
    
    return true;
  } catch (error) {
    console.error("Send failed", error);
    await setMessageStatus(message.id, "failed");
    appendMessageToState(normalized, { ...message, status: "failed" });
    if (state.activeContactKey === normalized) {
      renderMessages(normalized);
    }
    if (error.isUnauthorized) {
      handleSessionExpired();
    } else {
      showToast(error.message || "Failed to send message");
    }
    return false;
  }
}

async function handleSendMessage(text) {
  if (!state.activeContactKey) {
    showToast("Select a chat first");
    return;
  }

  // Handle scanner input separately
  if (state.activeContactKey === SCANNER_CONTACT_KEY) {
    await handleScannerInput(text);
    return;
  }

  const trimmed = text.slice(0, MAX_MESSAGE_LENGTH);
  const activeReplyContext = getActiveReplyContext();
  const replyEnvelope = activeReplyContext ? createReplyEnvelope(activeReplyContext, trimmed) : null;
  if (activeReplyContext) {
    clearReplyContext();
  }

  // Check for pump.fun, DexScreener, Terminal, or Axiom link and fetch token preview
  let tokenPreview = null;
  let tokenUrl = null;
  let linkPreview = null;
  
  // First check pump.fun (uses token address)
  const pumpFunAddress = extractPumpFunToken(trimmed);
  if (pumpFunAddress) {
    tokenPreview = await fetchTokenPreviewSafe(pumpFunAddress);
    tokenUrl = extractPumpFunUrl(trimmed);
  } else {
    // Then check DexScreener (uses pair address)
    const dexPairAddress = extractDexScreenerPair(trimmed);
    if (dexPairAddress) {
      tokenPreview = await fetchDexPairPreviewSafe(dexPairAddress);
      tokenUrl = extractDexScreenerUrl(trimmed);
    } else {
      // Check Terminal (uses pair address)
      const terminalPairAddress = extractTerminalToken(trimmed);
      if (terminalPairAddress) {
        tokenPreview = await fetchDexPairPreviewSafe(terminalPairAddress);
        tokenUrl = extractTerminalUrl(trimmed);
      } else {
        // Finally check Axiom (uses pair address)
        const axiomPairAddress = extractAxiomPair(trimmed);
        if (axiomPairAddress) {
          tokenPreview = await fetchDexPairPreviewSafe(axiomPairAddress);
          tokenUrl = extractAxiomUrl(trimmed);
        } else {
          // Check for generic URL and fetch link preview
          const genericUrl = extractGenericUrl(trimmed);
          if (genericUrl) {
            linkPreview = await fetchLinkPreviewSafe(genericUrl);
          }
        }
      }
    }
  }

  await sendPreparedMessage({
    targetPubkey: state.activeContactKey,
    displayText: trimmed,
    outboundText: replyEnvelope?.text,
    replyMeta: replyEnvelope?.reply,
    tokenPreview,
    tokenUrl,
    linkPreview,
  });
}

function updateContactPreviewFromMessage(pubkey, message) {
  updateContactInState(pubkey, {
    lastMessage: message,
    updatedAt: message.timestamp,
  });
  refreshContacts(false);
}

async function markMessagesRead(pubkey) {
  if (!pubkey) return;
  updateContactInState(pubkey, { unreadCount: 0 });
  await updateContact(pubkey, { unreadCount: 0, updatedAt: Date.now() });
  await refreshContacts(false);
}

async function handleIncomingMessages(messages) {
  if (!messages.length) return;

  const ackIds = [];
  let deliveredMessageCount = 0;

  for (const payload of messages) {
    // Check if this is a call notification message
    if (payload.text) {
      try {
        const parsed = JSON.parse(payload.text);
        // Log all parsed call-related messages
        if (parsed.type) {
          console.log('[Inbox] Parsed message type:', parsed.type, parsed);
        }
        if (parsed.type === 'incoming_call') {
          console.log('[Call] Incoming call notification:', parsed);
          // Handle incoming call via CallManager
          if (window.callManager) {
            window.callManager.handleIncomingCallNotification({
              callId: parsed.callId,
              roomId: parsed.roomId,
              callerId: parsed.caller,
              callerName: parsed.callerName,
              timestamp: parsed.timestamp,
            });
          }
          // Acknowledge this message
          if (payload.id) {
            ackIds.push(payload.id);
          }
          continue; // Skip normal message processing
        }
        
        // Handle missed/cancelled call notification - close incoming call UI
        if (parsed.type === 'missed_call' || parsed.type === 'cancelled_call') {
          console.log('[Call] Call ended notification:', parsed.type, 'from:', parsed.caller);
          if (window.callManager) {
            const currentCall = window.callManager.currentCall;
            console.log('[Call] Current call state:', {
              hasCurrentCall: !!currentCall,
              isOutgoing: currentCall?.isOutgoing,
              callerId: currentCall?.callerId,
              parsedCaller: parsed.caller,
            });
            // If we have an active incoming call from this caller, cancel it
            if (currentCall && !currentCall.isOutgoing && currentCall.callerId === parsed.caller) {
              console.log('[Call] Cancelling incoming call');
              window.callManager.handleCallCancelled(parsed.type);
            } else if (currentCall && !currentCall.isOutgoing) {
              // Caller might be different format - try anyway
              console.log('[Call] Caller mismatch, forcing cancel anyway');
              window.callManager.handleCallCancelled(parsed.type);
            }
          }
          if (payload.id) {
            ackIds.push(payload.id);
          }
          continue;
        }
      } catch (e) {
        // Not JSON or not a call message, process normally
      }
    }

    // Debug: log incoming message payload
    console.log('[Incoming] Message payload:', {
      from: payload.from?.slice(0, 8),
      text: payload.text?.slice(0, 30),
      hasVoiceKey: !!payload.voiceKey,
      voiceKey: payload.voiceKey?.slice(0, 30),
      voiceDuration: payload.voiceDuration,
    });
    
    const from = normalizePubkey(payload.from);
    if (!from) continue;

    const contact = await ensureContact(from);
    const remoteDisplayName =
      payload.senderDisplayName ||
      (payload.senderNickname ? `@${payload.senderNickname}` : "") ||
      "";
    
    // Detect nickname change
    const oldName = contact.localName || "";
    const hasNicknameChanged = remoteDisplayName && oldName && remoteDisplayName !== oldName;
    
    if (remoteDisplayName && (!contact.localName || hasNicknameChanged)) {
      await updateContact(from, { localName: remoteDisplayName, updatedAt: Date.now() });
      updateContactInState(from, { localName: remoteDisplayName });
      if (state.activeContactKey === from) {
        updateContactHeader();
        updateConversationMeta(from);
      }
      renderContactList();
      
      // Create local system message about nickname change
      if (hasNicknameChanged) {
        const nicknameChangeMessage = {
          id: `nickname-change-${Date.now()}-${crypto.randomUUID()}`,
          contactKey: from,
          direction: "in",
          text: buildNicknameChangeText({ oldName, newName: remoteDisplayName }),
          timestamp: Date.now(),
          status: "delivered",
          meta: {
            systemType: "nickname_change",
            nicknameChange: { oldName, newName: remoteDisplayName },
          },
        };
        await addMessage(nicknameChangeMessage);
        appendMessageToState(from, nicknameChangeMessage);
        if (state.activeContactKey === from) {
          renderMessages(from);
        }
      }
    } else {
      void hydrateContactProfile(from);
    }
    const messageId = typeof payload.id === "string" && payload.id.length ? payload.id : null;
    if (messageId) {
      ackIds.push(messageId);
    }

    const hasCiphertext = typeof payload.ciphertext === "string" && payload.ciphertext.length > 0;
    const encryptionMeta =
      hasCiphertext && payload.nonce
        ? {
            nonce: payload.nonce,
            version: Number.isFinite(payload.encryptionVersion) ? payload.encryptionVersion : 1,
          }
        : null;
    let ciphertext = hasCiphertext ? payload.ciphertext : null;
    let displayText = payload.text || "";
    if (encryptionMeta && ciphertext) {
      let decrypted = null;
      
      // Always try with senderEncryptionKey first if available
      if (payload.senderEncryptionKey) {
        // Force create new session secret with the provided key
        await resetSessionSecret(from);
        const secret = await ensureSessionSecret(from, {
          remoteKeyHint: payload.senderEncryptionKey,
          force: true,
        });
        if (secret) {
          decrypted = decryptWithSecret(secret, ciphertext, encryptionMeta.nonce);
        }
      }
      
      // Fallback: try with cached/fetched key
      if (decrypted === null) {
        const secret = await ensureSessionSecret(from, { force: true });
        if (secret) {
          decrypted = decryptWithSecret(secret, ciphertext, encryptionMeta.nonce);
        }
      }
      
      if (decrypted !== null) {
        displayText = decrypted;
      } else {
        console.warn("Failed to decrypt message", payload.id || "unknown");
        displayText = "[Encrypted message]";
      }
    }

    // Check for voice message
    let voiceMeta = null;
    if (payload.voiceKey) {
      console.log('[Voice] Incoming voice message:', {
        voiceKey: payload.voiceKey,
        duration: payload.voiceDuration,
        nonce: payload.voiceNonce,
        hasWaveform: !!payload.voiceWaveform,
        waveformLength: payload.voiceWaveform?.length,
      });
      // Parse waveform from JSON string
      let waveform = null;
      if (payload.voiceWaveform) {
        try {
          waveform = JSON.parse(payload.voiceWaveform);
        } catch (e) {
          console.warn('[Voice] Failed to parse waveform:', e);
        }
      }
      
      voiceMeta = {
        key: payload.voiceKey,
        duration: payload.voiceDuration || 0,
        mimeType: payload.voiceMimeType || 'audio/webm',
        nonce: payload.voiceNonce,
        waveform: waveform, // Waveform from sender
        senderKey: payload.senderEncryptionKey, // For decryption
        loading: false,
      };
      displayText = 'Voice message';
    }

    // Check if this is a reaction message
    const reactionData = parseReactionMessage(displayText);
    if (reactionData) {
      await handleIncomingReaction(reactionData, from);
      // Acknowledge the reaction message but don't store it as a regular message
      if (messageId) {
        ackIds.push(messageId);
      }
      continue;
    }

    let forwardMeta = null;
    const forwardParse = parseForwardEnvelope(displayText);
    if (forwardParse) {
      displayText = forwardParse.text;
      forwardMeta = forwardParse.forward;
    }

    const replyParse = parseReplyEnvelope(displayText);
    let replyMeta = null;
    if (replyParse) {
      displayText = replyParse.text;
      replyMeta = replyParse.reply;
    }

    const systemMeta = parsePaymentSystemMessage(displayText);
    const message = {
      id: messageId || crypto.randomUUID(),
      contactKey: from,
      direction: "in",
      text: displayText,
      timestamp: Number(payload.timestamp) || Date.now(),
      status: "delivered",
      meta: {
        encryption: encryptionMeta,
        ciphertext,
        ...(systemMeta
          ? {
              systemType: "payment",
              payment: systemMeta,
            }
          : {}),
        ...(replyMeta
          ? {
              replyTo: replyMeta,
            }
          : {}),
        ...(forwardMeta
          ? {
              forwardedFrom: forwardMeta,
            }
          : {}),
        ...(payload.tokenPreview
          ? {
              tokenPreview: payload.tokenPreview,
            }
          : {}),
        ...(voiceMeta
          ? {
              voice: voiceMeta,
            }
          : {}),
      },
    };

    await addMessage(message);
    appendMessageToState(from, message);
    deliveredMessageCount += 1;
    
    // Broadcast to other tabs
    broadcastSync("MESSAGE_RECEIVED", {
      contactKey: from,
      message,
    });

    if (state.activeContactKey === from) {
      renderMessages(from);
      await markMessagesRead(from);
      updateConversationMeta(from);
    } else {
      const unread = (contact?.unreadCount || 0) + 1;
      updateContactInState(from, {
        unreadCount: unread,
        lastMessage: message,
        updatedAt: message.timestamp,
      });
      await updateContact(from, { unreadCount: unread, updatedAt: Date.now() });
    }
  }

  if (deliveredMessageCount > 0) {
    playNotificationSound();
  }
  await refreshContacts(false);

  if (ackIds.length) {
    ackMessages(ackIds).catch((error) => {
      console.warn("Ack failed", error);
    });
  }
}

async function ensureEncryptionKeys() {
  if (state.encryptionKeys?.publicKey && state.encryptionKeys?.secretKey) {
    return state.encryptionKeys;
  }
  
  let keys = await getEncryptionKeys();
  
  if (!keys || !keys.publicKey || !keys.secretKey) {
    // Generate random keys for E2E encryption
    // Messages are backed up in plaintext, so new keys work after restore
    console.log("[Encryption] Generating new encryption keys...");
    const pair = nacl.box.keyPair();
    keys = {
      publicKey: bytesToBase64(pair.publicKey),
      secretKey: bytesToBase64(pair.secretKey),
      createdAt: Date.now(),
    };
    await saveEncryptionKeys(keys);
  }
  
  state.encryptionKeys = keys;
  return keys;
}

async function publishEncryptionKey(force = false) {
  if (!latestAppState?.isAuthenticated) return false;
  const keys = await ensureEncryptionKeys();
  const localKey = keys?.publicKey;
  if (!localKey) return false;
  const remoteKey = state.profile?.encryptionPublicKey || null;
  if (!force && remoteKey === localKey) return true;
  try {
    console.log("[Encryption] Publishing encryption key...", { localKey: localKey?.slice(0, 20), remoteKey: remoteKey?.slice(0, 20) });
    const response = await updateEncryptionKey(localKey);
    if (response?.profile) {
      state.profile = { ...(state.profile || {}), ...response.profile };
      updateProfileHeader();
      console.log("[Encryption] Key published successfully");
      return true;
    }
  } catch (error) {
    console.warn("Failed to publish encryption key", error);
  }
  return false;
}

// Sync encryption key on login - ensures key is always published
async function syncEncryptionKey() {
  try {
    const keys = await ensureEncryptionKeys();
    if (!keys?.publicKey) {
      console.warn("[Encryption] No local keys, generating...");
      return await resetEncryptionKeys();
    }
    
    // Always force publish to ensure server has correct key
    console.log("[Encryption] Syncing encryption key...");
    const response = await updateEncryptionKey(keys.publicKey);
    if (response?.profile) {
      state.profile = { ...(state.profile || {}), ...response.profile };
      
      // Verify sync was successful
      if (state.profile.encryptionPublicKey === keys.publicKey) {
        console.log("[Encryption] Key synced successfully");
        return true;
      }
    }
    
    // If sync failed, regenerate
    console.warn("[Encryption] Sync failed, regenerating keys...");
    return await resetEncryptionKeys();
  } catch (error) {
    console.error("[Encryption] Sync error:", error);
    return false;
  }
}

// Debug/repair function for encryption issues
async function resetEncryptionKeys() {
  console.log("[Encryption] Resetting encryption keys...");
  
  // Clear all session secrets
  state.sessionSecrets.clear();
  state.remoteEncryptionKeys.clear();
  
  // Generate new random keys
  const pair = nacl.box.keyPair();
  const newKeys = {
    publicKey: bytesToBase64(pair.publicKey),
    secretKey: bytesToBase64(pair.secretKey),
    createdAt: Date.now(),
  };
  
  // Save new keys
  await saveEncryptionKeys(newKeys);
  state.encryptionKeys = newKeys;
  
  // Publish to server
  console.log("[Encryption] Publishing new key...");
  const response = await updateEncryptionKey(newKeys.publicKey);
  if (response?.profile) {
    state.profile = { ...(state.profile || {}), ...response.profile };
    updateProfileHeader();
    console.log("[Encryption] New key published successfully");
    showToast("Encryption keys regenerated");
    return true;
  }
  
  console.error("[Encryption] Failed to publish new key");
  return false;
}

// Expose to console for debugging
window.resetEncryptionKeys = resetEncryptionKeys;
window.debugEncryption = () => {
  console.log("Local keys:", state.encryptionKeys?.publicKey?.slice(0, 30) + "...");
  console.log("Profile key:", state.profile?.encryptionPublicKey?.slice(0, 30) + "...");
  console.log("Session secrets:", state.sessionSecrets.size);
  console.log("Remote keys cached:", state.remoteEncryptionKeys.size);
};
async function setActiveContact(pubkey) {
  const normalized = normalizePubkey(pubkey);
  if (!normalized) {
    showToast("Invalid contact");
    return;
  }

  // Switch nav to All Chats when opening a contact
  if (state.activeNav === "scanner") {
    setActiveNav("all");
  }

  // Hide scanner panel, show info panel
  if (ui.scannerPanel) ui.scannerPanel.hidden = true;
  if (ui.infoPanel) ui.infoPanel.hidden = false;

  state.activeContactKey = normalized;
  updateContactListSelection();
  updateReplyPreview();

  await ensureContact(normalized);
  void ensureSessionSecret(normalized);
  void hydrateContactProfile(normalized);
  await loadMessages(normalized);
  
  // Messages should already be loaded from cloud backup if available
  
  await markMessagesRead(normalized);
  await refreshContacts(false);
  updateContactHeader();
  updateConversationMeta(normalized);
  renderMessages(normalized);
  toggleComposer(Boolean(latestAppState?.isAuthenticated));
  updatePaymentRecipient(normalized);
  handleMessageInput();
  
  // Show chat on mobile
  showMobileChat();
}

// Mobile navigation helpers
function showMobileChat() {
  const appLayout = document.querySelector(".app-layout");
  const mobileNav = document.querySelector(".mobile-nav");
  if (appLayout) {
    appLayout.classList.add("chat-active");
  }
  if (mobileNav) {
    mobileNav.classList.add("is-hidden");
  }
}

function hideMobileChat() {
  const appLayout = document.querySelector(".app-layout");
  const mobileNav = document.querySelector(".mobile-nav");
  if (appLayout) {
    appLayout.classList.remove("chat-active");
  }
  if (mobileNav) {
    mobileNav.classList.remove("is-hidden");
  }
}

function handleMobileBack() {
  // Clear active contact so notifications work properly
  state.activeContactKey = null;
  updateContactListSelection();
  hideMobileChat();
}

// PWA Install functionality
const PWA_TOOLTIP_SHOWN_KEY = "solink_install_tooltip_shown";
const PWA_INSTALLED_KEY = "solink_app_installed";

function initPWA() {
  const isFirefox = navigator.userAgent.toLowerCase().includes("firefox");
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  const wasInstalled = localStorage.getItem(PWA_INSTALLED_KEY) === "true";
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  
  // Don't show PWA install on mobile devices
  if (isMobile) {
    console.log("[PWA] Mobile device - hiding install option");
    if (ui.navInstall) {
      ui.navInstall.setAttribute("hidden", "");
    }
    if (ui.installAppOption) {
      ui.installAppOption.setAttribute("hidden", "");
    }
    return;
  }
  
  // Check if already installed (standalone mode)
  if (isStandalone || wasInstalled) {
    console.log("[PWA] Running in standalone mode or already installed");
    if (ui.navInstall) {
      ui.navInstall.setAttribute("hidden", "");
    }
    if (ui.installAppOption) {
      ui.installAppOption.setAttribute("hidden", "");
    }
    return;
  }

  // Firefox doesn't support PWA install
  if (isFirefox) {
    console.log("[PWA] Firefox detected - manual install option available");
    if (ui.navInstall) {
      ui.navInstall.removeAttribute("hidden");
      ui.navInstall.dataset.browser = "firefox";
    }
    if (ui.installAppOption) {
      ui.installAppOption.removeAttribute("hidden");
      ui.installAppOption.dataset.browser = "firefox";
    }
    return;
  }

  // Safari needs manual "Add to Home Screen"
  if (isSafari) {
    console.log("[PWA] Safari detected - manual install option available");
    if (ui.navInstall) {
      ui.navInstall.removeAttribute("hidden");
      ui.navInstall.dataset.browser = "safari";
    }
    if (ui.installAppOption) {
      ui.installAppOption.removeAttribute("hidden");
      ui.installAppOption.dataset.browser = "safari";
    }
    return;
  }

  // Listen for the beforeinstallprompt event (Chromium browsers)
  window.addEventListener("beforeinstallprompt", (e) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Save the event for later use
    deferredInstallPrompt = e;
    // Show the install button (but don't show promotion yet - wait for wallet connect)
    if (ui.navInstall) {
      ui.navInstall.removeAttribute("hidden");
      ui.navInstall.dataset.browser = "chromium";
    }
    // Show install option in settings
    if (ui.installAppOption) {
      ui.installAppOption.removeAttribute("hidden");
      ui.installAppOption.dataset.browser = "chromium";
    }
    console.log("[PWA] Install prompt ready");
  });

  // Listen for successful installation
  window.addEventListener("appinstalled", () => {
    console.log("[PWA] App installed successfully");
    deferredInstallPrompt = null;
    localStorage.setItem(PWA_INSTALLED_KEY, "true");
    hideInstallPromotion();
    if (ui.navInstall) {
      ui.navInstall.setAttribute("hidden", "");
    }
    if (ui.installAppOption) {
      ui.installAppOption.setAttribute("hidden", "");
    }
    showToast("SOLink installed! 🚀");
  });
}

function showInstallPromotion() {
  if (!ui.navInstall) return;
  
  // Don't show promotion on mobile devices
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isMobile) {
    console.log("[PWA] Skipping promotion - mobile device");
    ui.navInstall.setAttribute("hidden", "");
    if (ui.installAppOption) {
      ui.installAppOption.setAttribute("hidden", "");
    }
    return;
  }
  
  // Don't show promotion if already installed
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  const wasInstalled = localStorage.getItem(PWA_INSTALLED_KEY) === "true";
  if (isStandalone || wasInstalled) {
    console.log("[PWA] Skipping promotion - already installed");
    return;
  }
  
  // For Chromium browsers: if no install prompt available, app is already installed
  const browser = ui.navInstall?.dataset.browser;
  if (browser === "chromium" && !deferredInstallPrompt) {
    console.log("[PWA] Skipping promotion - no install prompt (already installed on device)");
    // Hide the install button since it won't work anyway
    ui.navInstall.setAttribute("hidden", "");
    if (ui.installAppOption) {
      ui.installAppOption.setAttribute("hidden", "");
    }
    return;
  }
  
  const tooltipShown = localStorage.getItem(PWA_TOOLTIP_SHOWN_KEY) === "true";
  
  // Add pulsing animation
  ui.navInstall.classList.add("is-pulsing");
  
  // Stop pulsing after 25 seconds
  setTimeout(() => {
    ui.navInstall.classList.remove("is-pulsing");
  }, 25000);
  
  // Show tooltip only once (first visit)
  if (!tooltipShown) {
    // Create tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "install-tooltip";
    tooltip.innerHTML = `
      <button class="install-tooltip__close" aria-label="Close">×</button>
      <span class="install-tooltip__text">Install SOLink as app</span>
      <span class="install-tooltip__hint">Quick access & better experience</span>
    `;
    
    ui.navInstall.style.position = "relative";
    ui.navInstall.appendChild(tooltip);
    
    // Show tooltip after a short delay
    setTimeout(() => {
      tooltip.classList.add("is-visible");
    }, 1500);
    
    // Close button handler
    tooltip.querySelector(".install-tooltip__close").addEventListener("click", (e) => {
      e.stopPropagation();
      tooltip.classList.remove("is-visible");
      localStorage.setItem(PWA_TOOLTIP_SHOWN_KEY, "true");
      setTimeout(() => tooltip.remove(), 300);
    });
    
    // Auto-hide after 15 seconds
    setTimeout(() => {
      if (tooltip.classList.contains("is-visible")) {
        tooltip.classList.remove("is-visible");
        localStorage.setItem(PWA_TOOLTIP_SHOWN_KEY, "true");
        setTimeout(() => tooltip.remove(), 300);
      }
    }, 15000);
  }
}

function hideInstallPromotion() {
  if (!ui.navInstall) return;
  
  // Remove pulsing
  ui.navInstall.classList.remove("is-pulsing");
  
  // Remove tooltip if exists
  const tooltip = ui.navInstall.querySelector(".install-tooltip");
  if (tooltip) {
    tooltip.classList.remove("is-visible");
    setTimeout(() => tooltip.remove(), 300);
  }
}

// Smart scrollbar - shows only when mouse is near the edge
function initSmartScrollbar() {
  const scrollableElements = document.querySelectorAll('.chat-list, .timeline, .info-panel');
  const EDGE_THRESHOLD = 50; // pixels from right edge
  
  scrollableElements.forEach(el => {
    let hideTimeout = null;
    
    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const distanceFromRight = rect.right - e.clientX;
      
      if (distanceFromRight <= EDGE_THRESHOLD) {
        el.classList.add('scrollbar-visible');
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
      } else {
        if (!hideTimeout) {
          hideTimeout = setTimeout(() => {
            el.classList.remove('scrollbar-visible');
            hideTimeout = null;
          }, 900);
        }
      }
    });
    
    el.addEventListener('mouseleave', () => {
      if (hideTimeout) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        el.classList.remove('scrollbar-visible');
        hideTimeout = null;
      }, 500);
    });
  });
}

function initMobileNavigation() {
  const mobileNav = document.querySelector("[data-role=\"mobile-nav\"]");
  if (!mobileNav) return;
  
  const mobileNavItems = mobileNav.querySelectorAll("[data-nav]");
  const desktopNavItems = document.querySelectorAll(".nav-rail__item[data-nav]");
  
  mobileNavItems.forEach((item) => {
    item.addEventListener("click", () => {
      const navTarget = item.dataset.nav;
      
      // Find and click corresponding desktop nav item
      const desktopItem = document.querySelector(`.nav-rail__item[data-nav="${navTarget}"]`);
      if (desktopItem) {
        desktopItem.click();
      }
      
      // Update mobile nav active state
      mobileNavItems.forEach((i) => i.classList.remove("is-active"));
      item.classList.add("is-active");
    });
  });
  
  // Sync mobile nav when desktop nav changes
  desktopNavItems.forEach((item) => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "class") {
          const navTarget = item.dataset.nav;
          const mobileItem = mobileNav.querySelector(`[data-nav="${navTarget}"]`);
          if (mobileItem) {
            if (item.classList.contains("is-active")) {
              mobileNavItems.forEach((i) => i.classList.remove("is-active"));
              mobileItem.classList.add("is-active");
            }
          }
        }
      });
    });
    observer.observe(item, { attributes: true });
  });
}

// Mobile Info Sheet
const mobileInfoUI = {
  sheet: null,
  backdrop: null,
  avatar: null,
  name: null,
  pubkey: null,
  favoriteLabel: null,
  saveLabel: null,
  paymentAmount: null,
  paymentRecipient: null,
};

function cacheMobileInfoUI() {
  mobileInfoUI.sheet = document.querySelector("[data-role=\"mobile-info-sheet\"]");
  mobileInfoUI.backdrop = mobileInfoUI.sheet?.querySelector("[data-action=\"close-mobile-info\"]");
  mobileInfoUI.avatar = document.querySelector("[data-role=\"mobile-info-avatar\"]");
  mobileInfoUI.name = document.querySelector("[data-role=\"mobile-info-name\"]");
  mobileInfoUI.pubkey = document.querySelector("[data-role=\"mobile-info-pubkey\"]");
  mobileInfoUI.favoriteLabel = document.querySelector("[data-role=\"mobile-favorite-label\"]");
  mobileInfoUI.saveLabel = document.querySelector("[data-role=\"mobile-save-label\"]");
  mobileInfoUI.paymentAmount = document.querySelector("[data-role=\"mobile-payment-amount\"]");
  mobileInfoUI.paymentRecipient = document.querySelector("[data-role=\"mobile-payment-recipient\"]");
}

function openMobileInfoSheet() {
  if (!mobileInfoUI.sheet || !state.activeContactKey) return;
  
  const contact = state.contacts.find((c) => c.pubkey === state.activeContactKey);
  if (!contact) return;
  
  // Update sheet content
  const displayName = contact.localName || contact.nickname || shortenPubkey(contact.pubkey);
  setTextContent(mobileInfoUI.name, displayName);
  setTextContent(mobileInfoUI.pubkey, shortenPubkey(contact.pubkey));
  setTextContent(mobileInfoUI.paymentRecipient, shortenPubkey(contact.pubkey));
  
  if (mobileInfoUI.avatar) {
    setAvatar(mobileInfoUI.avatar, contact.pubkey, 56, displayName);
  }
  
  // Update labels
  setTextContent(mobileInfoUI.favoriteLabel, contact.isFavorite ? "Unmark favorite" : "Mark favorite");
  setTextContent(mobileInfoUI.saveLabel, contact.isSaved ? "Unsave contact" : "Save contact");
  
  // Show sheet
  mobileInfoUI.sheet.hidden = false;
  requestAnimationFrame(() => {
    mobileInfoUI.sheet.dataset.visible = "true";
  });
}

function closeMobileInfoSheet() {
  if (!mobileInfoUI.sheet) return;
  
  mobileInfoUI.sheet.dataset.visible = "false";
  setTimeout(() => {
    mobileInfoUI.sheet.hidden = true;
  }, 300);
}

async function handleMobileLocalNameChange() {
  // Function kept for compatibility but no longer used
  refreshContacts(false);
  
}

async function handleMobileToggleFavorite() {
  if (!state.activeContactKey) return;
  
  const contact = state.contacts.find((c) => c.pubkey === state.activeContactKey);
  if (!contact) return;
  
  const newValue = !contact.isFavorite;
  await updateContact(state.activeContactKey, { isFavorite: newValue, updatedAt: Date.now() });
  updateContactInState(state.activeContactKey, { isFavorite: newValue });
  refreshContacts(false);
  
  setTextContent(mobileInfoUI.favoriteLabel, newValue ? "Unmark favorite" : "Mark favorite");
  showToast(newValue ? "Added to favorites" : "Removed from favorites");
}

async function handleMobileToggleSave() {
  if (!state.activeContactKey) return;
  
  const contact = state.contacts.find((c) => c.pubkey === state.activeContactKey);
  if (!contact) return;
  
  const newValue = !contact.isSaved;
  await updateContact(state.activeContactKey, { isSaved: newValue, updatedAt: Date.now() });
  updateContactInState(state.activeContactKey, { isSaved: newValue });
  refreshContacts(false);
  
  setTextContent(mobileInfoUI.saveLabel, newValue ? "Unsave contact" : "Save contact");
  showToast(newValue ? "Contact saved" : "Contact unsaved");
}

function handleMobileCopyWallet() {
  if (!state.activeContactKey) return;
  
  navigator.clipboard.writeText(state.activeContactKey).then(() => {
    showToast("Wallet address copied");
  }).catch(() => {
    showToast("Failed to copy");
  });
}

async function handleMobileClearChat() {
  if (!state.activeContactKey) return;
  
  const confirmed = await showConfirmDialog(
    "Clear chat",
    "Are you sure you want to delete all messages in this chat? This action cannot be undone."
  );
  if (!confirmed) return;
  
  await clearChatMessages(state.activeContactKey);
  closeMobileInfoSheet();
  showToast("Chat cleared");
}

async function handleMobileRemoveContact() {
  if (!state.activeContactKey) return;
  
  const confirmed = await showConfirmDialog(
    "Remove contact",
    "Remove this contact and all messages? This action cannot be undone."
  );
  if (!confirmed) return;
  
  const pubkey = state.activeContactKey;
  closeMobileInfoSheet();
  handleCloseChat();
  
  await removeContact(pubkey);
  state.contacts = state.contacts.filter((c) => c.pubkey !== pubkey);
  state.messages.delete(pubkey);
  refreshContacts();
  showToast("Contact removed");
}

function initMobileInfoSheet() {
  cacheMobileInfoUI();
  if (!mobileInfoUI.sheet) return;
  
  // Open button (menu icon)
  const openBtn = document.querySelector("[data-action=\"open-mobile-info\"]");
  openBtn?.addEventListener("click", openMobileInfoSheet);
  
  // Also open when clicking on contact header (avatar/name) on mobile
  const contactHeader = document.querySelector(".chat-column__contact");
  contactHeader?.addEventListener("click", (e) => {
    // Only on mobile (check if mobile-info-btn is visible)
    const infoBtn = document.querySelector(".mobile-info-btn");
    if (infoBtn && window.getComputedStyle(infoBtn).display !== "none") {
      openMobileInfoSheet();
    }
  });
  
  // Close on backdrop click
  mobileInfoUI.backdrop?.addEventListener("click", closeMobileInfoSheet);
  
  // Action buttons
  document.querySelector("[data-action=\"mobile-toggle-favorite\"]")?.addEventListener("click", handleMobileToggleFavorite);
  document.querySelector("[data-action=\"mobile-toggle-save\"]")?.addEventListener("click", handleMobileToggleSave);
  document.querySelector("[data-action=\"mobile-copy-wallet\"]")?.addEventListener("click", handleMobileCopyWallet);
  document.querySelector("[data-action=\"mobile-clear-chat\"]")?.addEventListener("click", handleMobileClearChat);
  document.querySelector("[data-action=\"mobile-remove-contact\"]")?.addEventListener("click", handleMobileRemoveContact);
  
  // Payment - sync with main payment handler
  const mobilePaymentBtn = document.querySelector("[data-action=\"mobile-send-payment\"]");
  mobilePaymentBtn?.addEventListener("click", async () => {
    const amount = mobileInfoUI.paymentAmount?.value;
    if (!amount || !state.activeContactKey) return;
    
    // Use existing payment handler by setting values and triggering
    if (ui.paymentAmount) {
      ui.paymentAmount.value = amount;
      updatePaymentControls();
      await handleSendPayment();
      mobileInfoUI.paymentAmount.value = "";
      closeMobileInfoSheet();
    }
  });
  
  // Enable/disable payment button based on amount
  mobileInfoUI.paymentAmount?.addEventListener("input", () => {
    const btn = document.querySelector("[data-action=\"mobile-send-payment\"]");
    const amount = parseFloat(mobileInfoUI.paymentAmount?.value || "0");
    if (btn) {
      btn.disabled = !(amount > 0 && state.activeContactKey);
    }
  });
}

function ensureInfoPanelElements() {
  if (!ui.infoPanel) ui.infoPanel = document.querySelector("[data-role=\"info-panel\"]");
  if (!ui.infoName) ui.infoName = document.querySelector("[data-role=\"info-name\"]");
  if (!ui.infoPubkey) ui.infoPubkey = document.querySelector("[data-role=\"info-pubkey\"]");
  if (!ui.infoMessageCount) ui.infoMessageCount = document.querySelector("[data-role=\"info-message-count\"]");
  if (!ui.infoFirstSeen) ui.infoFirstSeen = document.querySelector("[data-role=\"info-first-seen\"]");
  if (!ui.infoAvatar) ui.infoAvatar = document.querySelector("[data-role=\"info-avatar\"]");
  if (!ui.copyContactLinkButton) ui.copyContactLinkButton = document.querySelector("[data-action=\"copy-contact-link\"]");
  if (!ui.removeContactButton) ui.removeContactButton = document.querySelector("[data-action=\"remove-contact\"]");
  if (!ui.toggleFavoriteButton) ui.toggleFavoriteButton = document.querySelector("[data-action=\"toggle-favorite\"]");
}

function updateConversationMeta(pubkey) {
  ensureInfoPanelElements();
  if (!ui.infoPanel || !ui.infoName || !ui.infoPubkey) {
    console.warn("Info panel elements missing");
    return;
  }

  if (!pubkey) {
    ui.infoPanel.classList.remove("has-contact");
    setTextContent(ui.infoName, "No chat selected");
    setTextContent(ui.infoPubkey, "");
    setTextContent(ui.infoMessageCount, "0");
    setTextContent(ui.infoFirstSeen, "—");
    if (ui.infoAvatar) setAvatar(ui.infoAvatar, "solink", 62, "SOLink");
    ui.copyContactLinkButton?.setAttribute("disabled", "disabled");
    ui.clearChatButton?.setAttribute("disabled", "disabled");
    ui.removeContactButton?.setAttribute("disabled", "disabled");
    ui.toggleFavoriteButton?.setAttribute("disabled", "disabled");
    ui.saveContactButton?.setAttribute("disabled", "disabled");
    return;
  }

  const contact = state.contacts.find((item) => item.pubkey === pubkey);
  const messages = state.messages.get(pubkey) || [];

  ui.infoPanel.classList.add("has-contact");
  setTextContent(ui.infoName, contact?.localName || shortenPubkey(pubkey, 6));
  setTextContent(ui.infoPubkey, shortenPubkey(pubkey, 6));
  setTextContent(ui.infoMessageCount, String(messages.length));
  setTextContent(ui.infoFirstSeen, messages[0] ? formatDate(messages[0].timestamp) : "—");
  if (ui.infoAvatar) setAvatar(ui.infoAvatar, pubkey, 62, getContactAvatarLabel(contact) || pubkey);

  ui.copyContactLinkButton?.removeAttribute("disabled");
  ui.clearChatButton?.removeAttribute("disabled");
  ui.removeContactButton?.removeAttribute("disabled");
  ui.toggleFavoriteButton?.removeAttribute("disabled");
  setTextContent(ui.toggleFavoriteButton, contact?.pinned ? "Unmark favorite" : "Mark favorite");
  if (ui.saveContactButton) {
    ui.saveContactButton.removeAttribute("disabled");
    setTextContent(ui.saveContactButton, contact?.isSaved ? "Remove from contacts" : "Save contact");
  }
}


async function handleSearchSubmit() {
  const raw = ui.searchInput?.value?.trim();
  if (!raw) return;

  if (isNicknameQuery(raw)) {
    const normalized = normalizeNicknameInput(raw);
    try {
      const response = await lookupProfile(normalized);
      const profile = response?.profile;
      if (!profile?.pubkey) {
        throw new Error("User not found");
      }
      if (profile.encryptionPublicKey) {
        rememberRemoteEncryptionKey(profile.pubkey, profile.encryptionPublicKey);
      }
      await ensureContact(profile.pubkey, {
        localName: profile.displayName || (profile.nickname ? `@${profile.nickname}` : ""),
      });
      await refreshContacts(false);
      await setActiveContact(profile.pubkey);
      ui.searchInput.value = "";
      state.contactQuery = "";
      renderContactList();
      showToast(`Opened chat with ${profile.displayName || `@${normalized}`}`);
      return;
    } catch (error) {
      console.warn("Global search failed", error);
      showToast(error.message || "User not found");
      return;
    }
  }

  const pubkey = normalizePubkey(raw);
  if (pubkey) {
    const knownContact =
      state.contacts.find((item) => item.pubkey === pubkey) || (await getContact(pubkey));

    if (!knownContact) {
      try {
        const response = await fetchProfileByPubkey(pubkey);
        const profile = response?.profile;
        if (!profile?.pubkey) {
          throw new Error("User not found");
        }
        const displayName = profile.displayName || (profile.nickname ? `@${profile.nickname}` : "");
        const toastLabel = displayName || shortenPubkey(profile.pubkey, 6);
        if (profile.encryptionPublicKey) {
          rememberRemoteEncryptionKey(profile.pubkey, profile.encryptionPublicKey);
        }
        await ensureContact(profile.pubkey, {
          localName: displayName,
          encryptionPublicKey: profile.encryptionPublicKey || null,
        });
        await refreshContacts(false);
        await setActiveContact(profile.pubkey);
        ui.searchInput.value = "";
        state.contactQuery = "";
        renderContactList();
        showToast(`Opened chat with ${toastLabel}`);
        return;
      } catch (error) {
        console.warn("Pubkey lookup failed", error);
        showToast(error.message || "User not found");
        return;
      }
    }

    await setActiveContact(pubkey);
    ui.searchInput.value = "";
    state.contactQuery = "";
    renderContactList();
    return;
  }

  showToast("Enter @nickname or a valid public key");
}

async function initializeProfile() {
  let profile = await getProfile();
  if (!profile) {
    profile = await saveProfile({
      nickname: "",
      displayName: "",
      avatarSeed: crypto.randomUUID(),
      theme: "dark",
    });
  }
  if (!profile.avatarSeed) {
    profile = await updateProfile({ avatarSeed: crypto.randomUUID() });
  }
  if (typeof profile.displayName !== "string") {
    profile = await updateProfile({ displayName: profile.nickname ? `@${profile.nickname}` : "" });
  }

  state.profile = profile;
  updateProfileHeader();
  // Don't open nickname modal here - wait for server sync in syncProfileFromServer()
}

async function syncProfileFromServer() {
  try {
    const response = await fetchProfileMe();
    const remote = response?.profile;
    if (!remote) return;

    const updated = await updateProfile({
      nickname: remote.nickname || "",
      displayName: remote.displayName || (remote.nickname ? `@${remote.nickname}` : ""),
      encryptionPublicKey: remote.encryptionPublicKey || state.profile?.encryptionPublicKey || "",
    });

    state.profile = updated;
    updateProfileHeader();
    updateShareLink(latestAppState);

    if (!updated.nickname) {
      openNicknameModal();
    } else {
      hideOnboarding();
    }
  } catch (error) {
    console.warn("Profile sync failed", error);
  }
}

function ensureProfileHeaderElements() {
  if (!ui.profileNickname) {
    ui.profileNickname = document.querySelector("[data-role=\"profile-nickname\"]");
  }
  if (!ui.profileWallet) {
    ui.profileWallet = document.querySelector("[data-role=\"profile-wallet\"]");
  }
  if (!ui.profileAvatar) {
    ui.profileAvatar = document.querySelector("[data-role=\"profile-avatar\"]");
  }
  ensureStatusElements();
}

function updateProfileHeader() {
  ensureProfileHeaderElements();
  if (!state.profile || !ui.profileNickname || !ui.profileWallet || !ui.profileAvatar) return;

  const displayName = state.profile.displayName || (state.profile.nickname ? `@${state.profile.nickname}` : "Set nickname");
  setTextContent(ui.profileNickname, displayName);

  const walletPubkey = latestAppState?.walletPubkey || getWalletPubkey();
  setTextContent(ui.profileWallet, walletPubkey ? shortenPubkey(walletPubkey) : "Wallet not connected");

  setAvatar(ui.profileAvatar, state.profile.avatarSeed || "solink", 52, displayName);
  updateProfilePanel();
}

function updateProfilePanel() {
  if (!state.profile || !ui.profileSettingsPanel) return;
  const displayName = state.profile.displayName || (state.profile.nickname ? `@${state.profile.nickname}` : "Set nickname");
  setTextContent(ui.profilePanelName, displayName);
  const walletPubkey = latestAppState?.walletPubkey || getWalletPubkey();
  setTextContent(ui.profilePanelWallet, walletPubkey ? shortenPubkey(walletPubkey) : "Wallet not connected");
  if (ui.profilePanelAvatar) {
    setAvatar(ui.profilePanelAvatar, state.profile.avatarSeed || "solink", 62, displayName);
  }
  if (ui.profileSettingsInput && document.activeElement !== ui.profileSettingsInput) {
    ui.profileSettingsInput.value = state.profile?.nickname || "";
  }
}

async function handleNicknameSubmit(inputNode = ui.nicknameInput, hintNode = ui.nicknameHint, options = {}) {
  if (!inputNode || !hintNode) return false;
  if (!isAuthenticated()) {
    setTextContent(hintNode, "Connect wallet to update nickname");
    showToast("Connect wallet to update nickname");
    return false;
  }

  const inputValue = inputNode.value.trim();
  const validation = validateNickname(inputValue);
  if (!validation.ok) {
    setTextContent(hintNode, validation.message);
    return false;
  }

  try {
    setTextContent(hintNode, "");
    const result = await updateNicknameRequest(validation.normalized);
    const remoteProfile = result?.profile;
    if (!remoteProfile?.nickname) {
      throw new Error("Failed to save nickname");
    }

    const updated = await updateProfile({
      nickname: remoteProfile.nickname,
      displayName: remoteProfile.displayName || `@${remoteProfile.nickname}`,
    });
    state.profile = updated;
    state.hasFetchedProfile = true;
    updateProfileHeader();
    updateShareLink(latestAppState);
    inputNode.value = validation.normalized;
    showToast("Nickname saved");
    if (options.closeOnSuccess) {
      hideOnboarding();
    }
    return true;
  } catch (error) {
    console.error("Nickname update failed", error);
    setTextContent(hintNode, error.message || "Failed to save nickname");
    return false;
  }
}

function validateNickname(value) {
  const normalized = normalizeNicknameInput(value);
  if (!normalized) {
    return { ok: false, message: "Nickname is required" };
  }
  if (normalized.length < 3) {
    return { ok: false, message: "Nickname must be at least 3 characters" };
  }
  if (normalized.length > 16) {
    return { ok: false, message: "Nickname must be 16 characters or less" };
  }
  if (!/^[a-z]/.test(normalized)) {
    return { ok: false, message: "Nickname must start with a letter" };
  }
  if (!NICKNAME_REGEX.test(normalized)) {
    return {
      ok: false,
      message: "Use only letters (a-z), numbers, and underscore",
    };
  }
  if (NICKNAME_BLOCKLIST.has(normalized)) {
    return { ok: false, message: "This nickname is not allowed" };
  }
  // Check for blocklist partial matches (e.g. "solink_scam", "admin123")
  for (const blocked of NICKNAME_BLOCKLIST) {
    if (normalized.includes(blocked) || blocked.includes(normalized)) {
      return { ok: false, message: "This nickname is not allowed" };
    }
  }
  return { ok: true, normalized };
}

function showOnboardingStep(step) {
  if (!ui.onboarding) return;
  ui.onboarding.hidden = false;
  ui.onboarding.style.display = ''; // Remove inline display:none
  ui.onboarding
    .querySelectorAll(".onboarding__step")
    .forEach((node) => node.classList.toggle("is-active", node.dataset.step === step));
  
  // Hide close button on nickname step (nickname is required)
  if (ui.closeOnboarding) {
    ui.closeOnboarding.style.display = step === "nickname" ? "none" : "";
  }
}

function hideOnboarding() {
  if (!ui.onboarding) return;
  ui.onboarding.hidden = true;
}

function openNicknameModal() {
  if (!ui.nicknameInput) return;
  setTextContent(ui.nicknameHint, "");
  ui.nicknameInput.value = state.profile?.nickname || "";
  showOnboardingStep("nickname");
  requestAnimationFrame(() => ui.nicknameInput?.focus());
}

async function runPollCycle(abortSignal) {
  if (!isAuthenticated()) {
    return;
  }
  const messages = await pollInbox({ waitMs: POLL_LONG_WAIT_MS, signal: abortSignal });
  await handleIncomingMessages(messages);
}

async function pollLoop() {
  while (pollLoopShouldRun && isAuthenticated()) {
    pollAbortController = new AbortController();
    try {
      await runPollCycle(pollAbortController.signal);
    } catch (error) {
      if (error.name !== "AbortError") {
        console.warn("Polling error", error);
        if (error.isUnauthorized) {
          handleSessionExpired();
          break;
        }
        await delay(POLL_RETRY_DELAY_MS);
      }
    } finally {
      pollAbortController = null;
    }
  }
  pollLoopPromise = null;
}

function ensurePollLoop() {
  if (!pollLoopPromise) {
    pollLoopPromise = pollLoop();
  }
}

function triggerImmediatePoll() {
  if (!isAuthenticated()) return;
  if (!pollLoopShouldRun) {
    startPolling();
    return;
  }
  if (pollAbortController) {
    pollAbortController.abort(new DOMException("Immediate poll", "AbortError"));
  }
}

function startPolling() {
  if (pollLoopShouldRun) return;
  pollLoopShouldRun = true;
  ensurePollLoop();
}

function stopPolling() {
  if (!pollLoopShouldRun) return;
  pollLoopShouldRun = false;
  if (pollAbortController) {
    pollAbortController.abort(new DOMException("Polling stopped", "AbortError"));
  }
}

async function loadRouteContact() {
  const route = getCurrentRoute();
  if (route.name === "dm" && route.pubkey) {
    await ensureContact(route.pubkey);
    await refreshContacts(false);
    await setActiveContact(route.pubkey);
  }
}

async function handleAppStateChange(appState) {
  console.log('[Chat] handleAppStateChange called');
  console.log('[Chat] appState:', appState);
  latestAppState = appState;
  updateStatusLabel(appState);
  updateShareLink(appState);
  updateProfileHeader();
  const hasSession = Boolean(appState?.walletPubkey && appState?.isAuthenticated);
  console.log('[Chat] hasSession:', hasSession, 'walletPubkey:', appState?.walletPubkey, 'isAuthenticated:', appState?.isAuthenticated);
  
  // Check if we're in the middle of mobile sign flow (iOS Safari)
  // hasPendingMobileSign checks localStorage directly - works even in new tab
  const pendingSign = hasPendingMobileSign();
  console.log('[Chat] pendingMobileSign:', pendingSign, 'hasSession:', hasSession);
  
  if (pendingSign && !hasSession) {
    // Show "Continue to sign" panel (mobile only)
    toggleConnectOverlay(true, true);
  } else {
    toggleConnectOverlay(!hasSession, false);
  }

  toggleComposer(Boolean(appState?.isAuthenticated && state.activeContactKey));
  updatePaymentRecipient(state.activeContactKey);

  const nextWallet = appState.walletPubkey || null;
  const walletChanged = nextWallet !== state.currentWallet;
  if (walletChanged) {
    await loadWorkspace(nextWallet);
  }

  if (appState.isAuthenticated) {
    startPolling();
    if (!state.hasFetchedProfile) {
      await syncProfileFromServer();
      state.hasFetchedProfile = true;
      
      // Try to restore from cloud backup FIRST (before other UI updates)
      try {
        console.log("[CloudSync] Starting restore check after auth...");
        const restored = await restoreFromCloudBackup();
        if (restored) {
          console.log("[CloudSync] Restore successful, refreshing UI...");
          await refreshContacts();
          renderContactList();
        }
      } catch (err) {
        console.warn("[CloudSync] Restore failed:", err.message);
      }
      
      // Show install promotion after first successful auth
      showInstallPromotion();
      // Sync push toggle and check if we should show the prompt (AFTER restore)
      syncPushToggle();
      checkPushPrompt();
    }
    // Always ensure encryption key is synced on auth
    await syncEncryptionKey();
    await refreshContacts();
    await loadRouteContact();
  } else {
    stopPolling();
    state.hasFetchedProfile = false;
    toggleComposer(false);
  }
}

function registerDebugHelpers() {
  window.SOLINK_DEBUG = {
    state,
    ui,
    setActiveContact,
    refreshContacts,
    getEncryptionKeys,
    logContacts() {
      console.table(
        state.contacts.map((contact) => ({
          pubkey: contact.pubkey.slice(0, 6),
          pinned: contact.pinned,
          saved: contact.isSaved,
          last: contact.lastMessage?.timestamp || contact.updatedAt || 0,
        })),
      );
    },
  };
}

// Check for pending mobile payment after returning from Phantom
async function checkPendingMobilePayment() {
  const signatureStr = localStorage.getItem('solink.pending.tx.signature');
  const pendingPaymentStr = localStorage.getItem('solink.pending.payment');
  
  if (!signatureStr || !pendingPaymentStr) {
    // Clean up any stale data
    localStorage.removeItem('solink.pending.tx.signature');
    localStorage.removeItem('solink.pending.payment');
    return;
  }
  
  try {
    const pendingPayment = JSON.parse(pendingPaymentStr);
    
    // Check if payment is not too old (10 minutes)
    if (pendingPayment.timestamp && Date.now() - pendingPayment.timestamp > 10 * 60 * 1000) {
      console.log('[Payment] Pending payment expired');
      localStorage.removeItem('solink.pending.tx.signature');
      localStorage.removeItem('solink.pending.payment');
      return;
    }
    
    console.log('[Payment] Found pending payment, signature:', signatureStr);
    showToast("Payment submitted");
    
    // Confirm the transaction
    await solanaConnection.confirmTransaction(
      {
        signature: signatureStr,
        blockhash: pendingPayment.blockhash,
        lastValidBlockHeight: pendingPayment.lastValidBlockHeight,
      },
      "confirmed",
    );
    
    showToast("Payment confirmed!");
    
    // Send system message about the payment
    await sendSystemPaymentMessage({
      lamports: pendingPayment.lamports,
      fromPubkey: pendingPayment.fromPubkey,
      toPubkey: pendingPayment.toPubkey,
      signature: signatureStr,
    });
    
  } catch (error) {
    console.error('[Payment] Failed to process pending payment:', error);
    showToast("Payment confirmation failed");
  } finally {
    localStorage.removeItem('solink.pending.tx.signature');
    localStorage.removeItem('solink.pending.payment');
  }
}

async function initialize() {
  cacheDom();
  initPWA();
  setActiveNav(state.activeNav);
  setSidebarView(state.sidebarView);
  bindEvents();
  initializeEmojiPicker();
  initMobileNavigation();
  initMobileInfoSheet();
  initSmartScrollbar();
  initPushUI();
  initVoiceRecorder();
  handleMessageInput();
  toggleComposer(false);
  registerDebugHelpers();

  // Register Service Worker for push notifications
  registerServiceWorker();
  
  // Initialize cross-tab sync
  initSyncChannel();

  // Initialize audio calls UI
  initAudioCalls();

  await ensureEncryptionKeys();
  await loadWorkspace(null);

  console.log('[Chat Init] Registering state change listener...');
  onStateChange(handleAppStateChange);
  console.log('[Chat Init] Calling initApp...');
  await initApp();
  console.log('[Chat Init] initApp completed, calling loadRouteContact...');
  await loadRouteContact();
  
  // Check for pending mobile payment
  await checkPendingMobilePayment();
  console.log('[Chat Init] Initialize complete');
}

document.addEventListener("DOMContentLoaded", () => {
  initialize().catch((error) => {
    console.error("Initialization error", error);
    showToast("Failed to initialize app");
  });
});

window.addEventListener("focus", () => {
  triggerImmediatePoll();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    triggerImmediatePoll();
  }
});
