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
  logout as requestLogout,
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

  ui.navReconnect?.addEventListener("click", handleReconnectClick);
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

  ui.closeChatButton?.addEventListener("click", handleCloseChat);

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

  ui.settingsSoundToggle?.addEventListener("change", (event) => {
    updateSettings({ soundEnabled: event.target.checked });
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
    const dump = await exportLocalData();
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
    showToast("Backup exported");
  } catch (error) {
    console.error("Export failed", error);
    showToast("Export failed");
  }
}

function handleImportFileChange(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  if (hasWindow && !window.confirm("Importing will replace your current local data. Continue?")) {
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      await importLocalData(parsed);
      showToast("Backup imported");
      setTimeout(() => window.location.reload(), 400);
    } catch (error) {
      console.error("Import failed", error);
      showToast("Import failed");
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
  if (!provider?.publicKey) {
    showToast("Wallet unavailable");
    return;
  }
  const fromPubkey = provider.publicKey;
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
    showToast(error.message || "Failed to send message");
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

  await sendPreparedMessage({
    targetPubkey: state.activeContactKey,
    displayText: trimmed,
    outboundText: replyEnvelope?.text,
    replyMeta: replyEnvelope?.reply,
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
    if (ui.infoAvatar) setAvatar(ui.infoAvatar, "solink", 62, "SOLink");
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
  if (ui.infoAvatar) setAvatar(ui.infoAvatar, pubkey, 62, getContactAvatarLabel(contact) || pubkey);

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
