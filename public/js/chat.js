import nacl from "https://cdn.skypack.dev/tweetnacl@1.0.3?min";

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
} from "./api.js";
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
} from "./db.js";

const POLL_LONG_WAIT_MS = 15000;
const POLL_RETRY_DELAY_MS = 1000;
const MAX_MESSAGE_LENGTH = 2000;
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NICKNAME_REGEX = /^[a-z0-9_.-]{3,24}$/;
const PROFILE_LOOKUP_COOLDOWN_MS = 5 * 60 * 1000;
const hasWindow = typeof window !== "undefined";
const isLocalhost = hasWindow && ["localhost", "127.0.0.1"].includes(window.location.hostname);
const DEFAULT_SOLANA_RPC = isLocalhost
  ? "https://api.mainnet-beta.solana.com"
  : hasWindow
    ? new URL("/api/solana", window.location.origin).toString()
    : "https://api.mainnet-beta.solana.com";
const PAYMENT_SYSTEM_PREFIX = "__SOLINK_PAYMENT__";
const SOLANA_EXPLORER_TX = "https://explorer.solana.com/tx/";
const REPLY_PREFIX = "__SOLINK_REPLY__";
const REPLY_DELIMITER = "::";
const REPLY_PREVIEW_LIMIT = 140;
const FORWARD_PREFIX = "__SOLINK_FORWARD__";
const FORWARD_DELIMITER = "::";
const FORWARD_PREVIEW_LIMIT = 140;
const SETTINGS_STORAGE_KEY = "solink_settings_v1";
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
  ui.navInstall = document.querySelector("[data-action=\"install-app\"]");
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

function updateSettings(partial) {
  state.settings = {
    ...state.settings,
    ...partial,
  };
  persistSettings();
  syncSettingsUI();
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

  const handleInstallClick = async () => {
    const browser = ui.navInstall?.dataset.browser;
    
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
  ui.overlayConnectButton?.addEventListener("click", handleConnectClick);
  
  // PWA Install button
  ui.navInstall?.addEventListener("click", handleInstallClick);

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

async function ensureSessionSecret(pubkey, options = {}) {
  if (!pubkey) return null;
  const force = Boolean(options.force);
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
  const remoteKey = hintKey || (await ensureRemoteEncryptionKey(pubkey));
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

function createReplyPreviewBlock(replyMeta) {
  const wrapper = document.createElement("div");
  wrapper.className = "bubble__reply";
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
  const preview = truncateText(record?.message?.text || "[No text]", FORWARD_PREVIEW_LIMIT);
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
  if (p < 0.00001) return `$${p.toExponential(2)}`;
  if (p < 0.01) return `$${p.toFixed(6)}`;
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

function toggleConnectOverlay(visible) {
  console.log('[Chat] toggleConnectOverlay called, visible:', visible);
  console.log('[Chat] ui.connectOverlay:', ui.connectOverlay);
  if (!ui.connectOverlay) {
    console.log('[Chat] connectOverlay element not found!');
    return;
  }
  ui.connectOverlay.hidden = !visible;
  console.log('[Chat] connectOverlay.hidden set to:', ui.connectOverlay.hidden);
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
    
    // Get raw data without signature
    const dump = await exportLocalData(currentWallet);
    
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
    
    const blob = new Blob([JSON.stringify(dump, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `solink-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast("Backup exported & signed");
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

function handleImportFileChange(event) {
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
      const parsed = JSON.parse(reader.result);
      
      // Verify backup signature
      const verification = await verifyBackupSignature(parsed, currentWallet);
      
      if (!verification.valid) {
        console.warn('[Import] Verification failed:', verification.reason);
        if (verification.reason === 'WALLET_MISMATCH') {
          showToast("Backup belongs to a different wallet");
        } else if (verification.reason === 'INVALID_SIGNATURE') {
          showToast("Backup signature is invalid or tampered");
        } else {
          showToast("Backup verification failed");
        }
        return;
      }
      
      await importLocalData(parsed, currentWallet);
      showToast("Backup imported");
      setTimeout(() => window.location.reload(), 400);
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
      sendPayload = {
        to: normalized,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        version: encrypted.version,
        timestamp,
        ...(tokenPreview ? { tokenPreview } : {}),
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

  const trimmed = text.slice(0, MAX_MESSAGE_LENGTH);
  const activeReplyContext = getActiveReplyContext();
  const replyEnvelope = activeReplyContext ? createReplyEnvelope(activeReplyContext, trimmed) : null;
  if (activeReplyContext) {
    clearReplyContext();
  }

  // Check for pump.fun, DexScreener, Terminal, or Axiom link and fetch token preview
  let tokenPreview = null;
  let tokenUrl = null;
  
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
      let decrypted = null;
      let secret = await ensureSessionSecret(from, {
        remoteKeyHint: payload.senderEncryptionKey || null,
      });
      if (secret) {
        decrypted = decryptWithSecret(secret, ciphertext, encryptionMeta.nonce);
      }
      if (decrypted === null && payload.senderEncryptionKey) {
        await resetSessionSecret(from);
        secret = await ensureSessionSecret(from, {
          remoteKeyHint: payload.senderEncryptionKey,
          force: true,
        });
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
  updateReplyPreview();

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

// Backup reminder
const BACKUP_REMINDER_KEY = "solink_last_backup_reminder";
const BACKUP_REMINDER_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days

function initPWA() {
  const isFirefox = navigator.userAgent.toLowerCase().includes("firefox");
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  const wasInstalled = localStorage.getItem(PWA_INSTALLED_KEY) === "true";
  
  // Check if already installed (standalone mode)
  if (isStandalone || wasInstalled) {
    console.log("[PWA] Running in standalone mode or already installed");
    if (ui.navInstall) {
      ui.navInstall.setAttribute("hidden", "");
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
    return;
  }

  // Safari needs manual "Add to Home Screen"
  if (isSafari) {
    console.log("[PWA] Safari detected - manual install option available");
    if (ui.navInstall) {
      ui.navInstall.removeAttribute("hidden");
      ui.navInstall.dataset.browser = "safari";
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
    showToast("SOLink installed! 🚀");
  });
}

function showInstallPromotion() {
  if (!ui.navInstall) return;
  
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

// Backup reminder functionality
const BACKUP_REMINDER_DELAY = 10 * 60 * 1000; // 10 minutes after authorization

// Expose for testing in console
window.testBackupReminder = function() {
  localStorage.removeItem(BACKUP_REMINDER_KEY);
  showBackupReminder();
};

function checkBackupReminder() {
  const lastReminder = localStorage.getItem(BACKUP_REMINDER_KEY);
  const now = Date.now();
  
  // Check if enough time has passed since last reminder
  if (lastReminder && (now - parseInt(lastReminder, 10)) < BACKUP_REMINDER_INTERVAL) {
    return;
  }
  
  // Check if user has any contacts (no need to remind if empty)
  if (state.contacts.length === 0) {
    return;
  }
  
  // Show reminder after 10 minutes
  setTimeout(() => {
    // Re-check conditions in case things changed
    if (state.contacts.length > 0) {
      showBackupReminder();
    }
  }, BACKUP_REMINDER_DELAY);
}

function showBackupReminder() {
  // Don't show if already showing
  if (document.querySelector(".backup-toast")) return;
  
  const toast = document.createElement("div");
  toast.className = "backup-toast";
  toast.innerHTML = `
    <div class="backup-toast__icon">🔐</div>
    <div class="backup-toast__content">
      <div class="backup-toast__title">Backup your conversations</div>
      <p class="backup-toast__text">
        Your messages are <strong>end-to-end encrypted</strong> and stored only on your device. 
        We can't recover them — only you can back them up.
      </p>
      <p class="backup-toast__text backup-toast__text--warning">
        Clearing browser data <strong>may lead to data loss</strong>.
      </p>
      <p class="backup-toast__hint">This reminder appears once a week</p>
    </div>
    <div class="backup-toast__actions">
      <button type="button" class="backup-toast__btn backup-toast__btn--secondary" data-action="remind-later">
        Later
      </button>
      <button type="button" class="backup-toast__btn" data-action="backup-now">
        Backup
      </button>
    </div>
  `;
  
  document.body.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add("is-visible");
  });
  
  const closeToast = () => {
    toast.classList.remove("is-visible");
    setTimeout(() => toast.remove(), 300);
  };
  
  // Remind later - snooze for 7 days
  toast.querySelector("[data-action='remind-later']").addEventListener("click", () => {
    localStorage.setItem(BACKUP_REMINDER_KEY, Date.now().toString());
    closeToast();
  });
  
  // Backup now - trigger export and close
  toast.querySelector("[data-action='backup-now']").addEventListener("click", async () => {
    localStorage.setItem(BACKUP_REMINDER_KEY, Date.now().toString());
    closeToast();
    await handleExportData();
  });
  
  // Auto-hide after 30 seconds
  setTimeout(() => {
    if (document.body.contains(toast)) {
      localStorage.setItem(BACKUP_REMINDER_KEY, Date.now().toString());
      closeToast();
    }
  }, 30000);
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
  ui.onboarding.style.display = ''; // Remove inline display:none
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
      // Show install promotion after first successful auth
      showInstallPromotion();
      // Check if backup reminder is needed
      checkBackupReminder();
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
  handleMessageInput();
  toggleComposer(false);
  registerDebugHelpers();

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
