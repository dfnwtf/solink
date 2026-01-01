import nacl from "https://cdn.skypack.dev/tweetnacl@1.0.3?min";
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
} from "./api.js";
import {
  upsertContact,
  getContact,
  getContacts,
  getMessagesForContact,
  addMessage,
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
} from "./db.js";

const POLL_LONG_WAIT_MS = 15000;
const POLL_RETRY_DELAY_MS = 1000;
const MAX_MESSAGE_LENGTH = 2000;
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NICKNAME_REGEX = /^[a-z0-9_.-]{3,24}$/;
const PROFILE_LOOKUP_COOLDOWN_MS = 5 * 60 * 1000;
const hasWindow = typeof window !== 'undefined';
const isLocalhost =
  hasWindow && ['localhost', '127.0.0.1'].includes(window.location.hostname);
const DEFAULT_SOLANA_RPC = isLocalhost
  ? 'https://api.mainnet-beta.solana.com'
  : hasWindow
    ? new URL('/api/solana', window.location.origin).toString()
    : 'https://api.mainnet-beta.solana.com';
const SOLANA_RPC_URL = window.SOLINK_RPC_URL || DEFAULT_SOLANA_RPC;
const solanaConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
window.Buffer = window.Buffer || Buffer;

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
};

const ui = {
  navButtons: [],
};

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
  contactProfileLookups.clear();
  contactProfileCooldown.clear();
  clearChatView();
  updatePaymentRecipient(null);
  renderContactList();
  await initializeProfile();
  await refreshContacts();
}

function cacheDom() {
  ui.navButtons = Array.from(document.querySelectorAll("[data-nav]"));
  ui.navReconnect = document.querySelector("[data-action=\"reconnect-wallet\"]");
  ui.connectOverlay = document.querySelector("[data-role=\"connect-overlay\"]");
  ui.overlayConnectButton = document.querySelector("[data-role=\"connect-overlay\"] [data-action=\"connect-wallet\"]");

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

  ui.infoPanel = document.querySelector("[data-role=\"info-panel\"]");
  ui.infoAvatar = document.querySelector("[data-role=\"info-avatar\"]");
  ui.infoName = document.querySelector("[data-role=\"info-name\"]");
  ui.infoPubkey = document.querySelector("[data-role=\"info-pubkey\"]");
  ui.infoLocalName = document.querySelector("[data-role=\"info-local-name\"]");
  ui.infoMessageCount = document.querySelector("[data-role=\"info-message-count\"]");
  ui.infoFirstSeen = document.querySelector("[data-role=\"info-first-seen\"]");
  ui.copyContactLinkButton = document.querySelector("[data-action=\"copy-contact-link\"]");
  ui.removeContactButton = document.querySelector("[data-action=\"remove-contact\"]");
  ui.toggleFavoriteButton = document.querySelector("[data-action=\"toggle-favorite\"]");
  ui.saveContactButton = document.querySelector("[data-action=\"toggle-save-contact\"]");
  ui.toggleInfoButton = document.querySelector("[data-action=\"toggle-info\"]");
  ui.paymentAmount = document.querySelector("[data-role=\"payment-amount\"]");
  ui.paymentToken = document.querySelector("[data-role=\"payment-token\"]");
  ui.paymentRecipient = document.querySelector("[data-role=\"payment-recipient\"]");
  ui.paymentSendButton = document.querySelector("[data-action=\"send-payment\"]");

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

  updatePaymentControls();
}

function setActiveNav(target) {
  state.activeNav = target;
  ui.navButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.nav === target);
  });
}

function setSidebarView(view) {
  state.sidebarView = view;
  const showProfile = view === "profile";
  if (ui.sidebarDefault) {
    ui.sidebarDefault.hidden = showProfile;
  }
  if (ui.profileSettingsPanel) {
    ui.profileSettingsPanel.hidden = !showProfile;
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
        showToast("Coming soon");
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

  ui.navReconnect?.addEventListener("click", handleConnectClick);
  ui.overlayConnectButton?.addEventListener("click", handleConnectClick);

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

  ui.newChatButton?.addEventListener("click", () => {
    showToast("Type @nickname or paste a public key to start a chat");
    ui.searchInput?.focus();
  });

  ui.copyOnboardingLink?.addEventListener("click", () => {
    copyToClipboard(ui.onboardingShareLink?.value, "Link copied");
  });

  ui.copyContactLinkButton?.addEventListener("click", () => {
    if (!state.activeContactKey) return;
    copyToClipboard(createShareLink(state.activeContactKey), "Contact link copied");
  });

  ui.removeContactButton?.addEventListener("click", async () => {
    if (!state.activeContactKey) return;
    await deleteContact(state.activeContactKey);
    state.messages.delete(state.activeContactKey);
    state.activeContactKey = null;
    await refreshContacts();
    clearChatView();
    showToast("Contact removed");
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

  ui.infoLocalName?.addEventListener("change", async (event) => {
    if (!state.activeContactKey) return;
    const value = event.target.value.trim();
    await updateContact(state.activeContactKey, { localName: value, updatedAt: Date.now() });
    updateContactInState(state.activeContactKey, { localName: value });
    await refreshContacts(false);
    updateConversationMeta(state.activeContactKey);
    showToast("Saved");
  });

  ui.nicknameForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleNicknameSubmit(ui.nicknameInput, ui.nicknameHint, { closeOnSuccess: true });
  });

  ui.profileSettingsForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleNicknameSubmit(ui.profileSettingsInput, ui.profileSettingsHint);
  });

  ui.finishOnboarding?.addEventListener("click", hideOnboarding);
  ui.closeOnboarding?.addEventListener("click", hideOnboarding);
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
  ui.notificationAudio?.play().catch(() => {});
}

function ensureStatusElements() {
  if (!ui.statusLabel) {
    ui.statusLabel = document.querySelector("[data-role=\"status\"]");
  }
  if (!ui.statusIndicator) {
    ui.statusIndicator = document.querySelector("[data-role=\"connection-indicator\"]");
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

  if (!appState?.provider) {
    setTextContent(
      ui.statusLabel,
      appState?.isMobile ? "Tap Connect to open Phantom" : "Install Phantom wallet to continue",
    );
    ui.statusIndicator?.classList.remove("is-online");
  } else if (!appState.walletPubkey) {
    setTextContent(ui.statusLabel, "Wallet disconnected");
    ui.statusIndicator?.classList.remove("is-online");
  } else if (!appState.isAuthenticated) {
    setTextContent(ui.statusLabel, "Authenticating...");
    ui.statusIndicator?.classList.remove("is-online");
  } else {
    setTextContent(ui.statusLabel, "Connected");
    ui.statusIndicator?.classList.add("is-online");
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

async function ensureRemoteEncryptionKey(pubkey) {
  if (!pubkey) return "";
  if (state.remoteEncryptionKeys.has(pubkey)) {
    return state.remoteEncryptionKeys.get(pubkey) || "";
  }
  const fetched = await fetchRemoteEncryptionKey(pubkey);
  return fetched || "";
}

async function ensureSessionSecret(pubkey) {
  if (!pubkey) return null;
  if (state.sessionSecrets.has(pubkey)) {
    return state.sessionSecrets.get(pubkey);
  }
  const cached = await getSessionSecret(pubkey);
  if (cached?.secret) {
    state.sessionSecrets.set(pubkey, cached.secret);
    return cached.secret;
  }
  const remoteKey = await ensureRemoteEncryptionKey(pubkey);
  if (!remoteKey) {
    return null;
  }
  const keys = await ensureEncryptionKeys();
  const secretKeyBytes = base64ToBytes(keys.secretKey);
  const remoteKeyBytes = base64ToBytes(remoteKey);
  try {
    const shared = nacl.box.before(remoteKeyBytes, secretKeyBytes);
    const encoded = bytesToBase64(shared);
    state.sessionSecrets.set(pubkey, encoded);
    await saveSessionSecret(pubkey, encoded);
    return encoded;
  } catch (error) {
    console.warn("Failed to derive session secret", error);
    return null;
  }
}

function generateAvatarGradient(seed) {
  const hash = hashCode(seed || "solink");
  const hue = Math.abs(hash % 360);
  return `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 36) % 360} 70% 55%))`;
}

function setAvatar(element, seed, size = 48) {
  if (!element) return;
  element.style.width = `${size}px`;
  element.style.height = `${size}px`;
  element.style.borderRadius = `${size < 60 ? 16 : 20}px`;
  element.style.background = generateAvatarGradient(seed);
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
}

function truncateText(text, limit) {
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
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
  setAvatar(avatar, contact.pubkey, 46);

  const meta = document.createElement("div");
  meta.className = "chat-item__meta";

  const nameEl = document.createElement("div");
  nameEl.className = "chat-item__name";
  nameEl.textContent = contact.localName || shortenPubkey(contact.pubkey, 6);

  const previewEl = document.createElement("div");
  previewEl.className = "chat-item__preview";
  previewEl.textContent = contact.lastMessage
    ? `${contact.lastMessage.direction === "out" ? "You: " : ""}${truncateText(contact.lastMessage.text || "", 48)}`
    : "No messages yet";

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
    if (contact.pubkey === state.activeContactKey) return;
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
  if (ui.chatAvatar) setAvatar(ui.chatAvatar, "solink", 52);

  if (ui.messageTimeline) {
    ui.messageTimeline.innerHTML = "";
  }
  toggleEmptyState(true);
  toggleComposer(false);
  updateConversationMeta(null);
}

function updateContactHeader() {
  if (!ui.chatName || !ui.chatStatus || !ui.chatAvatar || !ui.chatHeaderMain) return;

  if (!state.activeContactKey) {
    ui.chatHeaderMain.classList.remove("is-active");
    setTextContent(ui.chatName, "Select chat");
    setTextContent(ui.chatStatus, "No conversation yet");
    setAvatar(ui.chatAvatar, "solink", 52);
    return;
  }

  const contact = state.contacts.find((item) => item.pubkey === state.activeContactKey);
  if (contact) {
    setTextContent(ui.chatName, contact.localName || shortenPubkey(contact.pubkey, 6));
    setTextContent(ui.chatStatus, shortenPubkey(contact.pubkey, 6));
    setAvatar(ui.chatAvatar, contact.pubkey, 52);
  } else {
    setTextContent(ui.chatName, shortenPubkey(state.activeContactKey, 6));
    setTextContent(ui.chatStatus, state.activeContactKey);
    setAvatar(ui.chatAvatar, state.activeContactKey, 52);
  }
  ui.chatHeaderMain.classList.add("is-active");
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
}

function renderMessages(pubkey) {
  if (!ui.messageTimeline) return;
  ui.messageTimeline.innerHTML = "";

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
  const bubble = document.createElement("div");
  bubble.className = `bubble bubble--${message.direction === "out" ? "out" : "in"}`;
  bubble.dataset.messageId = message.id;

  const textEl = document.createElement("div");
  textEl.className = "bubble__text";

  const text = message.text || "";
  if (highlightQueryText) {
    textEl.innerHTML = highlightQuery(text, highlightQueryText);
  } else {
    textEl.textContent = text;
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

  bubble.appendChild(textEl);
  bubble.appendChild(meta);
  return bubble;
}

const highlightQuery = (text, query) => {
  const safe = escapeHtml(text);
  const regex = new RegExp(`(${escapeRegExp(query)})`, "gi");
  return safe.replace(regex, "<mark>$1</mark>");
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

function toggleConnectOverlay(visible) {
  if (!ui.connectOverlay) return;
  ui.connectOverlay.hidden = !visible;
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
  if (!provider?.publicKey) {
    showToast("Wallet unavailable");
    return;
  }

  try {
    isPaymentSubmitting = true;
    updatePaymentControls();
    const fromPubkey = provider.publicKey;
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
    if (typeof provider.signAndSendTransaction === "function") {
      const result = await provider.signAndSendTransaction(transaction);
      signature = typeof result === "string" ? result : result?.signature;
    } else if (typeof provider.signTransaction === "function") {
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

async function handleSendMessage(text) {
  if (!state.activeContactKey) {
    showToast("Select a chat first");
    return;
  }
  if (!latestAppState?.isAuthenticated) {
    showToast("Connect wallet to send messages");
    return;
  }

  const trimmed = text.slice(0, MAX_MESSAGE_LENGTH);
  const timestamp = Date.now();
  let encryptionMeta = null;
  let sendPayload = {
    to: state.activeContactKey,
    text: trimmed,
    timestamp,
  };
  const sessionSecret = await ensureSessionSecret(state.activeContactKey);
  if (sessionSecret) {
    const encrypted = encryptWithSecret(sessionSecret, trimmed);
    if (encrypted) {
      encryptionMeta = { nonce: encrypted.nonce, version: encrypted.version };
      sendPayload = {
        to: state.activeContactKey,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        version: encrypted.version,
        timestamp,
      };
    }
  }

  const message = {
    id: crypto.randomUUID(),
    contactKey: state.activeContactKey,
    direction: "out",
    text: trimmed,
    timestamp,
    status: "sending",
    meta: {
      encryption: encryptionMeta,
      ciphertext: encryptionMeta ? sendPayload.ciphertext : null,
    },
  };

  await addMessage(message);
  appendMessageToState(state.activeContactKey, message);
  renderMessages(state.activeContactKey);

  try {
    await sendMessage(sendPayload);
    await setMessageStatus(message.id, "sent");
    appendMessageToState(state.activeContactKey, {
      ...message,
      status: "sent",
      meta: {
        ...message.meta,
        encryption: encryptionMeta,
        ciphertext: encryptionMeta ? sendPayload.ciphertext : null,
      },
    });
    renderMessages(state.activeContactKey);
    updateContactPreviewFromMessage(state.activeContactKey, {
      ...message,
      status: "sent",
      text: trimmed,
    });
    triggerImmediatePoll();
  } catch (error) {
    console.error("Send failed", error);
    await setMessageStatus(message.id, "failed");
    appendMessageToState(state.activeContactKey, { ...message, status: "failed" });
    renderMessages(state.activeContactKey);
    showToast(error.message || "Failed to send message");
  }
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

  for (const payload of messages) {
    const from = normalizePubkey(payload.from);
    if (!from) continue;

    const contact = await ensureContact(from);
    const remoteDisplayName =
      payload.senderDisplayName ||
      (payload.senderNickname ? `@${payload.senderNickname}` : "") ||
      "";
    if (remoteDisplayName && !contact.localName) {
      await updateContact(from, { localName: remoteDisplayName, updatedAt: Date.now() });
      updateContactInState(from, { localName: remoteDisplayName });
      if (state.activeContactKey === from) {
        updateContactHeader();
        updateConversationMeta(from);
      }
      renderContactList();
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
      const secret = await ensureSessionSecret(from);
      if (secret) {
        const decrypted = decryptWithSecret(secret, ciphertext, encryptionMeta.nonce);
        if (decrypted !== null) {
          displayText = decrypted;
        } else {
          console.warn("Failed to decrypt message", payload.id || "unknown");
          displayText = "[Encrypted message]";
        }
      } else {
        console.warn("Missing session secret for contact", from);
        displayText = "[Encrypted message]";
      }
    }

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
      },
    };

    await addMessage(message);
    appendMessageToState(from, message);

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

  playNotificationSound();
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

async function publishEncryptionKey() {
  if (!latestAppState?.isAuthenticated) return;
  const keys = await ensureEncryptionKeys();
  const localKey = keys?.publicKey;
  if (!localKey) return;
  const remoteKey = state.profile?.encryptionPublicKey || null;
  if (remoteKey === localKey) return;
  try {
    const response = await updateEncryptionKey(localKey);
    if (response?.profile) {
      state.profile = { ...(state.profile || {}), ...response.profile };
      updateProfileHeader();
    }
  } catch (error) {
    console.warn("Failed to publish encryption key", error);
  }
}
async function setActiveContact(pubkey) {
  const normalized = normalizePubkey(pubkey);
  if (!normalized) {
    showToast("Invalid contact");
    return;
  }

  state.activeContactKey = normalized;
  updateContactListSelection();

  await ensureContact(normalized);
  void ensureSessionSecret(normalized);
  void hydrateContactProfile(normalized);
  await loadMessages(normalized);
  await markMessagesRead(normalized);
  await refreshContacts(false);
  updateContactHeader();
  updateConversationMeta(normalized);
  renderMessages(normalized);
  toggleComposer(Boolean(latestAppState?.isAuthenticated));
  updatePaymentRecipient(normalized);
  handleMessageInput();
}

function ensureInfoPanelElements() {
  if (!ui.infoPanel) ui.infoPanel = document.querySelector("[data-role=\"info-panel\"]");
  if (!ui.infoName) ui.infoName = document.querySelector("[data-role=\"info-name\"]");
  if (!ui.infoPubkey) ui.infoPubkey = document.querySelector("[data-role=\"info-pubkey\"]");
  if (!ui.infoLocalName) ui.infoLocalName = document.querySelector("[data-role=\"info-local-name\"]");
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
    if (ui.infoLocalName) ui.infoLocalName.value = "";
    setTextContent(ui.infoMessageCount, "0");
    setTextContent(ui.infoFirstSeen, "—");
    if (ui.infoAvatar) setAvatar(ui.infoAvatar, "solink", 62);
    ui.copyContactLinkButton?.setAttribute("disabled", "disabled");
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
  if (ui.infoLocalName) ui.infoLocalName.value = contact?.localName || "";
  setTextContent(ui.infoMessageCount, String(messages.length));
  setTextContent(ui.infoFirstSeen, messages[0] ? formatDate(messages[0].timestamp) : "—");
  if (ui.infoAvatar) setAvatar(ui.infoAvatar, pubkey, 62);

  ui.copyContactLinkButton?.removeAttribute("disabled");
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
    await ensureContact(pubkey);
    await refreshContacts(false);
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

  if (!profile.nickname) {
    openNicknameModal();
  }
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

  setAvatar(ui.profileAvatar, state.profile.avatarSeed || "solink", 52);
  updateProfilePanel();
}

function updateProfilePanel() {
  if (!state.profile || !ui.profileSettingsPanel) return;
  const displayName = state.profile.displayName || (state.profile.nickname ? `@${state.profile.nickname}` : "Set nickname");
  setTextContent(ui.profilePanelName, displayName);
  const walletPubkey = latestAppState?.walletPubkey || getWalletPubkey();
  setTextContent(ui.profilePanelWallet, walletPubkey ? shortenPubkey(walletPubkey) : "Wallet not connected");
  if (ui.profilePanelAvatar) {
    setAvatar(ui.profilePanelAvatar, state.profile.avatarSeed || "solink", 62);
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
  if (!NICKNAME_REGEX.test(normalized)) {
    return {
      ok: false,
      message: "Use 3-24 chars: letters, numbers, dot, hyphen or underscore",
    };
  }
  return { ok: true, normalized };
}

function showOnboardingStep(step) {
  if (!ui.onboarding) return;
  ui.onboarding.hidden = false;
  ui.onboarding
    .querySelectorAll(".onboarding__step")
    .forEach((node) => node.classList.toggle("is-active", node.dataset.step === step));
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
  latestAppState = appState;
  updateStatusLabel(appState);
  updateShareLink(appState);
  updateProfileHeader();
  const hasSession = Boolean(appState?.walletPubkey && appState?.isAuthenticated);
  toggleConnectOverlay(!hasSession);

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
    }
    await publishEncryptionKey();
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

async function initialize() {
  cacheDom();
  setActiveNav(state.activeNav);
  setSidebarView(state.sidebarView);
  bindEvents();
  initializeEmojiPicker();
  handleMessageInput();
  toggleComposer(false);
  registerDebugHelpers();

  await ensureEncryptionKeys();
  await loadWorkspace(null);

  onStateChange(handleAppStateChange);
  initApp();
  await loadRouteContact();
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
