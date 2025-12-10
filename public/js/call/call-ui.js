/**
 * Call UI for SOLINK Audio Calls
 * Full-featured call interface with minimizable window
 */

import { callManager, CallState, CallEndReason } from './call-manager.js';

class CallUI {
  constructor() {
    this.container = null;
    this.isVisible = false;
    this.isMinimized = false;
    this.currentCall = null;
    
    // Bind event handlers
    this.handleStateChange = this.handleStateChange.bind(this);
    this.handleTimerUpdate = this.handleTimerUpdate.bind(this);
    this.handleIncomingCall = this.handleIncomingCall.bind(this);
    this.handleCallInitiated = this.handleCallInitiated.bind(this);
    this.handleCallEnded = this.handleCallEnded.bind(this);
    
    // Subscribe to call manager events
    callManager.on('stateChange', this.handleStateChange);
    callManager.on('timerUpdate', this.handleTimerUpdate);
    callManager.on('incomingCall', this.handleIncomingCall);
    callManager.on('callInitiated', this.handleCallInitiated);
    callManager.on('callEnded', this.handleCallEnded);
  }

  init() {
    if (this.container) {
      console.log('[CallUI] Already initialized');
      return;
    }
    
    console.log('[CallUI] Initializing...');
    
    // Ensure DOM is ready
    if (!document.body) {
      console.error('[CallUI] Document body not ready!');
      return;
    }
    
    this.container = document.createElement('div');
    this.container.id = 'solink-call-ui';
    this.container.className = 'call-overlay';
    this.container.style.display = 'none';
    document.body.appendChild(this.container);
    
    this.injectStyles();
    
    console.log('[CallUI] Initialized successfully, container:', this.container);
  }

  showOutgoingCall(calleeId, calleeName) {
    console.log('[CallUI] showOutgoingCall:', { calleeId, calleeName });
    if (!this.container) this.init();
    this.currentCall = { calleeId, calleeName, isOutgoing: true };
    this.isMinimized = false;
    this.render('outgoing');
    this.show();
  }

  showIncomingCall(callerId, callerName) {
    console.log('[CallUI] showIncomingCall:', { callerId, callerName });
    if (!this.container) this.init();
    this.currentCall = { callerId, callerName, isOutgoing: false };
    this.isMinimized = false;
    this.render('incoming');
    this.show();
  }

  showActiveCall() {
    this.render('active');
    this.show();
  }

  hide() {
    if (this.container) {
      this.container.style.display = 'none';
      this.container.classList.remove('call-overlay--visible', 'call-overlay--minimized');
    }
    this.isVisible = false;
    this.isMinimized = false;
  }

  show() {
    console.log('[CallUI] show() called, container exists:', !!this.container);
    if (!this.container) {
      console.error('[CallUI] Cannot show - container is null! Attempting init...');
      this.init();
    }
    if (this.container) {
      this.container.style.display = 'flex';
      this.container.offsetHeight; // Force reflow
      this.container.classList.add('call-overlay--visible');
      this.container.classList.toggle('call-overlay--minimized', this.isMinimized);
      console.log('[CallUI] Container shown, classes:', this.container.className);
    } else {
      console.error('[CallUI] Still no container after init!');
    }
    this.isVisible = true;
  }

  minimize() {
    this.isMinimized = true;
    if (this.container) {
      this.container.classList.add('call-overlay--minimized');
    }
    this.render(this.getRenderType());
  }

  maximize() {
    this.isMinimized = false;
    if (this.container) {
      this.container.classList.remove('call-overlay--minimized');
    }
    this.render(this.getRenderType());
  }

  render(type) {
    if (!this.container) this.init();

    const name = this.currentCall?.calleeName || 
                 this.currentCall?.callerName || 
                 this.shortenPubkey(this.currentCall?.calleeId || this.currentCall?.callerId);

    if (this.isMinimized) {
      this.container.innerHTML = this.renderMinimizedCall(name, type);
      this.attachMinimizedHandlers(type);
      return;
    }

    switch (type) {
      case 'incoming':
        this.container.innerHTML = this.renderIncomingCall(name);
        this.attachIncomingCallHandlers();
        break;
      case 'outgoing':
        this.container.innerHTML = this.renderOutgoingCall(name);
        this.attachOutgoingCallHandlers();
        break;
      case 'active':
        this.container.innerHTML = this.renderActiveCall(name);
        this.attachActiveCallHandlers();
        break;
      case 'ended':
        this.container.innerHTML = this.renderCallEnded();
        setTimeout(() => this.hide(), 2000);
        break;
    }
  }

  renderMinimizedCall(name, type) {
    const isActive = type === 'active';
    const isOutgoing = type === 'outgoing';
    const isIncoming = type === 'incoming';
    const isMuted = callManager.isMuted();
    
    let avatarClass = '';
    let statusText = '';
    let miniClass = '';
    
    if (isActive) {
      avatarClass = 'call-mini__avatar--active';
      statusText = '<span id="call-timer-mini">00:00</span>';
    } else if (isOutgoing) {
      avatarClass = 'call-mini__avatar--calling';
      statusText = 'Calling...';
      miniClass = 'call-mini--outgoing';
    } else if (isIncoming) {
      avatarClass = 'call-mini__avatar--incoming';
      statusText = 'Incoming...';
      miniClass = 'call-mini--incoming';
    }
    
    return `
      <div class="call-mini ${miniClass}">
        <div class="call-mini__info" data-action="maximize">
          <div class="call-mini__avatar ${avatarClass}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </div>
          <div class="call-mini__text">
            <span class="call-mini__name">${this.escapeHtml(name)}</span>
            <span class="call-mini__status">${statusText}</span>
          </div>
        </div>
        <div class="call-mini__actions">
          ${isActive ? `
            <button class="call-mini__btn call-mini__btn--mute ${isMuted ? 'call-mini__btn--muted' : ''}" data-action="mute" title="${isMuted ? 'Unmute' : 'Mute'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${isMuted ? 
                  '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>' :
                  '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>'
                }
              </svg>
            </button>
          ` : ''}
          ${isIncoming ? `
            <button class="call-mini__btn call-mini__btn--accept" data-action="accept" title="Accept">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
            </button>
            <button class="call-mini__btn call-mini__btn--reject" data-action="reject" title="Decline">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
            </button>
          ` : `
            <button class="call-mini__btn call-mini__btn--end" data-action="end" title="End Call">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
            </button>
          `}
        </div>
      </div>
    `;
  }

  renderIncomingCall(name) {
    return `
      <div class="call-card call-card--incoming">
        <button class="call-card__minimize" data-action="minimize" title="Minimize">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 14 10 14 10 20"/>
            <polyline points="20 10 14 10 14 4"/>
            <line x1="14" y1="10" x2="21" y2="3"/>
            <line x1="3" y1="21" x2="10" y2="14"/>
          </svg>
        </button>
        <div class="call-card__pulse"></div>
        <div class="call-card__avatar call-card__avatar--incoming">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        </div>
        <div class="call-card__info">
          <span class="call-card__label">Incoming Call</span>
          <span class="call-card__name">${this.escapeHtml(name)}</span>
        </div>
        <div class="call-card__actions">
          <button class="call-btn call-btn--reject" data-action="reject" title="Decline">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </button>
          <button class="call-btn call-btn--accept" data-action="accept" title="Accept">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  renderOutgoingCall(name) {
    return `
      <div class="call-card call-card--outgoing">
        <button class="call-card__minimize" data-action="minimize" title="Minimize">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 14 10 14 10 20"/>
            <polyline points="20 10 14 10 14 4"/>
            <line x1="14" y1="10" x2="21" y2="3"/>
            <line x1="3" y1="21" x2="10" y2="14"/>
          </svg>
        </button>
        
        <!-- Pulsing rings animation -->
        <div class="call-card__rings">
          <div class="call-card__ring"></div>
          <div class="call-card__ring"></div>
          <div class="call-card__ring"></div>
        </div>
        
        <div class="call-card__avatar call-card__avatar--calling">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          <!-- Phone icon indicator -->
          <div class="call-card__phone-indicator">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </div>
        </div>
        <div class="call-card__info">
          <span class="call-card__label">Calling</span>
          <span class="call-card__name">${this.escapeHtml(name)}</span>
        </div>
        <div class="call-card__status">
          <span class="call-card__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
        <div class="call-card__actions">
          <button class="call-btn call-btn--end" data-action="end" title="Cancel Call">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  renderActiveCall(name) {
    const isMuted = callManager.isMuted();
    
    return `
      <div class="call-card call-card--active">
        <button class="call-card__minimize" data-action="minimize" title="Minimize">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 14 10 14 10 20"/>
            <polyline points="20 10 14 10 14 4"/>
            <line x1="14" y1="10" x2="21" y2="3"/>
            <line x1="3" y1="21" x2="10" y2="14"/>
          </svg>
        </button>
        <div class="call-card__avatar call-card__avatar--active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          <div class="call-card__audio-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
        <div class="call-card__info">
          <span class="call-card__name">${this.escapeHtml(name)}</span>
          <span class="call-card__timer" id="call-timer">00:00</span>
        </div>
        <div class="call-card__actions">
          <button class="call-btn call-btn--mute ${isMuted ? 'call-btn--muted' : ''}" data-action="mute" title="${isMuted ? 'Unmute' : 'Mute'}">
            ${this.getMuteIcon(isMuted)}
          </button>
          <button class="call-btn call-btn--end" data-action="end" title="End Call">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  renderCallEnded() {
    return `
      <div class="call-card call-card--ended">
        <div class="call-card__info">
          <span class="call-card__label">Call Ended</span>
        </div>
      </div>
    `;
  }

  getMuteIcon(isMuted) {
    return isMuted ? `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
    ` : `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
    `;
  }

  // Event handlers
  attachMinimizedHandlers(type) {
    this.container.querySelector('[data-action="maximize"]')?.addEventListener('click', () => {
      this.maximize();
    });
    
    this.container.querySelector('[data-action="mute"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isMuted = callManager.toggleMute();
      const btn = e.currentTarget;
      btn.classList.toggle('call-mini__btn--muted', isMuted);
    });
    
    this.container.querySelector('[data-action="end"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      callManager.endCall();
      this.hide();
    });
    
    // For minimized incoming call
    this.container.querySelector('[data-action="accept"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      callManager.answerCall(this.currentCall);
    });
    
    this.container.querySelector('[data-action="reject"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      callManager.rejectCall();
      this.hide();
    });
  }

  attachIncomingCallHandlers() {
    this.container.querySelector('[data-action="minimize"]')?.addEventListener('click', () => {
      this.minimize();
    });
    
    this.container.querySelector('[data-action="accept"]')?.addEventListener('click', () => {
      callManager.answerCall(this.currentCall);
    });
    
    this.container.querySelector('[data-action="reject"]')?.addEventListener('click', () => {
      callManager.rejectCall();
      this.hide();
    });
  }

  attachOutgoingCallHandlers() {
    this.container.querySelector('[data-action="minimize"]')?.addEventListener('click', () => {
      this.minimize();
    });
    
    this.container.querySelector('[data-action="end"]')?.addEventListener('click', () => {
      callManager.endCall();
      this.hide();
    });
  }

  attachActiveCallHandlers() {
    this.container.querySelector('[data-action="minimize"]')?.addEventListener('click', () => {
      this.minimize();
    });
    
    this.container.querySelector('[data-action="mute"]')?.addEventListener('click', (e) => {
      const isMuted = callManager.toggleMute();
      const btn = e.currentTarget;
      btn.classList.toggle('call-btn--muted', isMuted);
      btn.title = isMuted ? 'Unmute' : 'Mute';
      btn.innerHTML = this.getMuteIcon(isMuted);
    });
    
    this.container.querySelector('[data-action="end"]')?.addEventListener('click', () => {
      callManager.endCall();
    });
  }

  // Determine which view to render based on call state and direction
  getRenderType() {
    const state = callManager.state;
    if (state === CallState.ACTIVE || state === CallState.CONNECTING) {
      return 'active';
    }
    if (this.currentCall?.isOutgoing) {
      return 'outgoing';
    }
    return 'incoming';
  }

  // Call manager event handlers
  handleStateChange({ state, previousState }) {
    switch (state) {
      case CallState.RINGING:
        if (this.currentCall?.isOutgoing) {
          this.showOutgoingCall(this.currentCall.calleeId, this.currentCall.calleeName);
        }
        break;
      case CallState.CONNECTING:
      case CallState.ACTIVE:
        this.showActiveCall();
        break;
      case CallState.ENDED:
      case CallState.IDLE:
        if (previousState !== CallState.IDLE) {
          // Always hide on call end, regardless of minimized state
          this.isMinimized = false;
          this.hide();
        }
        break;
    }
  }

  handleTimerUpdate(seconds) {
    const timerEl = this.container?.querySelector('#call-timer');
    if (timerEl) {
      timerEl.textContent = this.formatDuration(seconds);
    }
    // Also update mini timer
    const miniTimerEl = this.container?.querySelector('#call-timer-mini');
    if (miniTimerEl) {
      miniTimerEl.textContent = this.formatDuration(seconds);
    }
  }

  handleIncomingCall(callInfo) {
    this.currentCall = {
      callerId: callInfo.callerId,
      callerName: callInfo.callerName,
      isOutgoing: false,
    };
    this.showIncomingCall(callInfo.callerId, callInfo.callerName);
  }

  handleCallInitiated(callInfo) {
    console.log('[CallUI] handleCallInitiated:', callInfo);
    // Store call info for outgoing calls
    this.currentCall = {
      calleeId: callInfo.calleeId,
      calleeName: callInfo.calleeName,
      isOutgoing: true,
    };
    // Show outgoing call UI immediately
    this.showOutgoingCall(callInfo.calleeId, callInfo.calleeName);
  }

  handleCallEnded({ reason, duration }) {
    console.log(`[CallUI] Call ended: ${reason}, duration: ${duration}ms`);
  }

  // Utilities
  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  shortenPubkey(pubkey) {
    if (!pubkey || pubkey.length < 10) return pubkey || 'Unknown';
    return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[m]);
  }

  injectStyles() {
    if (document.getElementById('solink-call-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'solink-call-styles';
    style.textContent = `
      /* ===== CALL OVERLAY ===== */
      .call-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(10, 9, 14, 0.95);
        backdrop-filter: blur(20px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        opacity: 0;
        transition: all 0.3s ease;
      }
      
      .call-overlay--visible {
        opacity: 1;
      }
      
      .call-overlay--minimized {
        background: transparent;
        backdrop-filter: none;
        pointer-events: none;
        align-items: flex-start;
        justify-content: flex-end;
        padding: 16px;
      }
      
      .call-overlay--minimized > * {
        pointer-events: auto;
      }
      
      /* ===== CALL CARD (Full Size) ===== */
      .call-card {
        background: linear-gradient(135deg, rgba(139, 92, 246, 0.15) 0%, rgba(30, 27, 38, 0.95) 100%);
        border: 1px solid rgba(139, 92, 246, 0.3);
        border-radius: 24px;
        padding: 48px 40px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 24px;
        min-width: 340px;
        max-width: 400px;
        position: relative;
        animation: callCardIn 0.4s ease;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      }
      
      @keyframes callCardIn {
        from { opacity: 0; transform: scale(0.9) translateY(20px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      
      .call-card__minimize {
        position: absolute;
        top: 16px;
        right: 16px;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.7);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }
      
      .call-card__minimize:hover {
        background: rgba(255, 255, 255, 0.2);
        color: white;
      }
      
      .call-card__minimize svg {
        width: 18px;
        height: 18px;
      }
      
      .call-card__pulse {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 200px;
        height: 200px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(34, 197, 94, 0.3) 0%, transparent 70%);
        animation: pulse 2s ease-in-out infinite;
      }
      
      @keyframes pulse {
        0%, 100% { transform: translate(-50%, -50%) scale(0.8); opacity: 0.5; }
        50% { transform: translate(-50%, -50%) scale(1.2); opacity: 0.8; }
      }
      
      .call-card__avatar {
        width: 110px;
        height: 110px;
        border-radius: 50%;
        background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        z-index: 1;
        box-shadow: 0 10px 40px rgba(139, 92, 246, 0.3);
      }
      
      .call-card__avatar svg {
        width: 52px;
        height: 52px;
        color: white;
      }
      
      .call-card__avatar--active {
        animation: avatarPulse 2s ease-in-out infinite;
      }
      
      @keyframes avatarPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.4), 0 10px 40px rgba(139, 92, 246, 0.3); }
        50% { box-shadow: 0 0 0 20px rgba(139, 92, 246, 0), 0 10px 40px rgba(139, 92, 246, 0.3); }
      }
      
      /* Outgoing call - pulsing rings */
      .call-card__rings {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -60%);
        width: 200px;
        height: 200px;
        pointer-events: none;
      }
      
      .call-card__ring {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 120px;
        height: 120px;
        border: 2px solid rgba(139, 92, 246, 0.4);
        border-radius: 50%;
        animation: ringPulse 2s ease-out infinite;
      }
      
      .call-card__ring:nth-child(2) {
        animation-delay: 0.4s;
      }
      
      .call-card__ring:nth-child(3) {
        animation-delay: 0.8s;
      }
      
      @keyframes ringPulse {
        0% {
          width: 120px;
          height: 120px;
          opacity: 0.6;
        }
        100% {
          width: 220px;
          height: 220px;
          opacity: 0;
        }
      }
      
      .call-card__avatar--calling {
        animation: callingPulse 1.5s ease-in-out infinite;
      }
      
      @keyframes callingPulse {
        0%, 100% { 
          transform: scale(1);
          box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.5);
        }
        50% { 
          transform: scale(1.05);
          box-shadow: 0 0 0 15px rgba(139, 92, 246, 0);
        }
      }
      
      .call-card__avatar--incoming {
        animation: incomingCardPulse 1s ease-in-out infinite;
      }
      
      @keyframes incomingCardPulse {
        0%, 100% { 
          transform: scale(1);
          box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.6);
        }
        50% { 
          transform: scale(1.08);
          box-shadow: 0 0 0 20px rgba(139, 92, 246, 0);
        }
      }
      
      .call-card__phone-indicator {
        position: absolute;
        bottom: -6px;
        right: -6px;
        width: 32px;
        height: 32px;
        background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: phoneRing 0.5s ease-in-out infinite alternate;
        box-shadow: 0 2px 10px rgba(34, 197, 94, 0.4);
      }
      
      .call-card__phone-indicator svg {
        width: 16px;
        height: 16px;
        color: white;
      }
      
      @keyframes phoneRing {
        0% { transform: rotate(-10deg); }
        100% { transform: rotate(10deg); }
      }
      
      .call-card__audio-indicator {
        position: absolute;
        bottom: -10px;
        display: flex;
        gap: 4px;
      }
      
      .call-card__audio-indicator span {
        width: 4px;
        height: 16px;
        background: #22c55e;
        border-radius: 2px;
        animation: audioBar 0.5s ease-in-out infinite;
      }
      
      .call-card__audio-indicator span:nth-child(2) { animation-delay: 0.1s; }
      .call-card__audio-indicator span:nth-child(3) { animation-delay: 0.2s; }
      
      @keyframes audioBar {
        0%, 100% { height: 8px; }
        50% { height: 20px; }
      }
      
      .call-card__info {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        z-index: 1;
      }
      
      .call-card__label {
        font-size: 13px;
        color: rgba(255, 255, 255, 0.5);
        text-transform: uppercase;
        letter-spacing: 2px;
        font-weight: 500;
      }
      
      .call-card__name {
        font-size: 26px;
        font-weight: 600;
        color: white;
      }
      
      .call-card__timer {
        font-size: 18px;
        color: rgba(255, 255, 255, 0.7);
        font-variant-numeric: tabular-nums;
        font-weight: 500;
      }
      
      .call-card__status { z-index: 1; }
      
      .call-card__dots {
        display: flex;
        gap: 8px;
      }
      
      .call-card__dots span {
        width: 10px;
        height: 10px;
        background: rgba(255, 255, 255, 0.4);
        border-radius: 50%;
        animation: dotPulse 1.4s ease-in-out infinite;
      }
      
      .call-card__dots span:nth-child(2) { animation-delay: 0.2s; }
      .call-card__dots span:nth-child(3) { animation-delay: 0.4s; }
      
      @keyframes dotPulse {
        0%, 100% { opacity: 0.3; transform: scale(0.8); }
        50% { opacity: 1; transform: scale(1); }
      }
      
      .call-card__actions {
        display: flex;
        gap: 28px;
        z-index: 1;
        margin-top: 8px;
      }
      
      /* ===== CALL BUTTONS ===== */
      .call-btn {
        width: 68px;
        height: 68px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }
      
      .call-btn svg {
        width: 28px;
        height: 28px;
      }
      
      .call-btn--accept {
        background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
        color: white;
        box-shadow: 0 8px 25px rgba(34, 197, 94, 0.4);
      }
      
      .call-btn--accept:hover {
        transform: scale(1.1);
        box-shadow: 0 12px 35px rgba(34, 197, 94, 0.5);
      }
      
      .call-btn--reject,
      .call-btn--end {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        color: white;
        box-shadow: 0 8px 25px rgba(239, 68, 68, 0.4);
      }
      
      .call-btn--reject:hover,
      .call-btn--end:hover {
        transform: scale(1.1);
        box-shadow: 0 12px 35px rgba(239, 68, 68, 0.5);
      }
      
      .call-btn--mute {
        background: rgba(255, 255, 255, 0.1);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.2);
      }
      
      .call-btn--mute:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      
      .call-btn--muted {
        background: rgba(239, 68, 68, 0.2);
        border-color: rgba(239, 68, 68, 0.5);
        color: #ef4444;
      }
      
      /* ===== MINIMIZED CALL CARD ===== */
      .call-mini {
        background: linear-gradient(135deg, rgba(30, 27, 38, 0.98) 0%, rgba(20, 18, 28, 0.98) 100%);
        border: 1px solid rgba(139, 92, 246, 0.3);
        border-radius: 16px;
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 16px;
        min-width: 280px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
        animation: miniCardIn 0.3s ease;
      }
      
      @keyframes miniCardIn {
        from { opacity: 0; transform: translateY(-20px) scale(0.9); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      
      .call-mini__info {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1;
        cursor: pointer;
      }
      
      .call-mini__avatar {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      
      .call-mini__avatar--active {
        animation: miniAvatarPulse 2s ease-in-out infinite;
      }
      
      .call-mini__avatar--calling {
        animation: miniCallingPulse 1s ease-in-out infinite;
        background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
      }
      
      @keyframes miniAvatarPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.4); }
        50% { box-shadow: 0 0 0 8px rgba(139, 92, 246, 0); }
      }
      
      @keyframes miniCallingPulse {
        0%, 100% { 
          box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
          transform: scale(1);
        }
        50% { 
          box-shadow: 0 0 0 6px rgba(34, 197, 94, 0);
          transform: scale(1.05);
        }
      }
      
      .call-mini--outgoing .call-mini__status {
        color: #22c55e;
      }
      
      /* Incoming call mini-mode */
      .call-mini--incoming {
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(139, 92, 246, 0.15) 100%);
        border-color: rgba(139, 92, 246, 0.4);
        animation: incomingPulse 1.5s ease-in-out infinite;
      }
      
      @keyframes incomingPulse {
        0%, 100% { 
          box-shadow: 0 4px 20px rgba(139, 92, 246, 0.2);
        }
        50% { 
          box-shadow: 0 4px 30px rgba(139, 92, 246, 0.4);
        }
      }
      
      .call-mini__avatar--incoming {
        background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
        animation: incomingAvatarPulse 1s ease-in-out infinite;
      }
      
      @keyframes incomingAvatarPulse {
        0%, 100% { 
          box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.5);
          transform: scale(1);
        }
        50% { 
          box-shadow: 0 0 0 8px rgba(139, 92, 246, 0);
          transform: scale(1.05);
        }
      }
      
      .call-mini--incoming .call-mini__status {
        color: #a78bfa;
      }
      
      .call-mini__btn--accept {
        background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
      }
      
      .call-mini__btn--accept:hover {
        background: linear-gradient(135deg, #16a34a 0%, #15803d 100%);
        transform: scale(1.1);
      }
      
      .call-mini__btn--reject {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      }
      
      .call-mini__btn--reject:hover {
        background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
        transform: scale(1.1);
      }
      
      .call-mini__avatar svg {
        width: 22px;
        height: 22px;
        color: white;
      }
      
      .call-mini__text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      
      .call-mini__name {
        font-size: 14px;
        font-weight: 600;
        color: white;
      }
      
      .call-mini__status {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.6);
        font-variant-numeric: tabular-nums;
      }
      
      .call-mini__actions {
        display: flex;
        gap: 8px;
      }
      
      .call-mini__btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }
      
      .call-mini__btn svg {
        width: 18px;
        height: 18px;
      }
      
      .call-mini__btn--mute {
        background: rgba(255, 255, 255, 0.1);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.2);
      }
      
      .call-mini__btn--mute:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      
      .call-mini__btn--muted {
        background: rgba(239, 68, 68, 0.2);
        border-color: rgba(239, 68, 68, 0.5);
        color: #ef4444;
      }
      
      .call-mini__btn--end {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        color: white;
      }
      
      .call-mini__btn--end:hover {
        transform: scale(1.1);
      }
      
      /* ===== CALL ENDED ===== */
      .call-card--ended {
        animation: callCardOut 0.4s ease forwards;
      }
      
      @keyframes callCardOut {
        from { opacity: 1; transform: scale(1); }
        to { opacity: 0; transform: scale(0.9); }
      }
      
      /* ===== RESPONSIVE ===== */
      @media (max-width: 768px) {
        .call-overlay--minimized {
          padding: 12px;
          justify-content: center;
        }
        
        .call-mini {
          width: calc(100% - 24px);
          max-width: 400px;
        }
      }
      
      @media (max-width: 480px) {
        .call-card {
          padding: 36px 28px;
          min-width: 0;
          width: calc(100% - 32px);
          max-width: 340px;
          border-radius: 20px;
        }
        
        .call-card__avatar {
          width: 90px;
          height: 90px;
        }
        
        .call-card__avatar svg {
          width: 42px;
          height: 42px;
        }
        
        .call-card__name {
          font-size: 22px;
        }
        
        .call-btn {
          width: 60px;
          height: 60px;
        }
        
        .call-btn svg {
          width: 24px;
          height: 24px;
        }
        
        .call-card__actions {
          gap: 20px;
        }
      }
    `;
    
    document.head.appendChild(style);
  }
}

export const callUI = new CallUI();
export default callUI;
