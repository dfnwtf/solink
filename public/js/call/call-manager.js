/**
 * Call Manager for SOLINK Audio Calls
 * Main module that orchestrates WebRTC and Signaling
 */

import { WebRTCClient } from './webrtc-client.js';
import { CallSignaling } from './call-signaling.js';
import { getSessionToken, getPersistedSession } from '../api.js';

// Cloudflare Worker URL for API calls (Hostinger doesn't proxy all requests)
const WORKER_API_BASE = 'https://solink-worker.official-716.workers.dev';

// Call states
export const CallState = {
  IDLE: 'idle',
  INITIATING: 'initiating',
  RINGING: 'ringing',
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  ENDING: 'ending',
  ENDED: 'ended',
};

// Call end reasons
export const CallEndReason = {
  ENDED_BY_USER: 'ended_by_user',
  REJECTED: 'rejected',
  TIMEOUT: 'timeout',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
  MAX_DURATION: 'max_duration',
};

class CallManager {
  constructor() {
    this.webrtc = null;
    this.signaling = null;
    this.state = CallState.IDLE;
    this.currentCall = null;
    this.callStartTime = null;
    this.callTimer = null;
    this.ringTimeout = null;
    this.audioElement = null;
    this.ringtoneElement = null;
    
    // Ring timeout in milliseconds (30 seconds)
    this.RING_TIMEOUT_MS = 30000;
    
    // Event listeners
    this.listeners = new Map();
  }

  /**
   * Add event listener
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  /**
   * Remove event listener
   */
  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  /**
   * Emit event
   */
  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`[CallManager] Event handler error:`, error);
        }
      });
    }
  }

  /**
   * Update state and emit event
   */
  setState(newState) {
    const previousState = this.state;
    this.state = newState;
    console.log(`[CallManager] State: ${previousState} -> ${newState}`);
    this.emit('stateChange', { state: newState, previousState });
  }

  /**
   * Get TURN credentials from server
   */
  async getTurnCredentials() {
    const token = getSessionToken();
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${WORKER_API_BASE}/api/call/turn-credentials`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to get TURN credentials');
    }

    return response.json();
  }

  /**
   * Initiate outgoing call
   */
  async initiateCall(calleeId, calleeName = null) {
    if (this.state !== CallState.IDLE) {
      throw new Error('Call already in progress');
    }

    this.setState(CallState.INITIATING);
    
    try {
      const token = getSessionToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      // Get TURN credentials
      const iceServers = await this.getTurnCredentials();

      // Initiate call on server
      const response = await fetch(`${WORKER_API_BASE}/api/call/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ callee: calleeId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to initiate call');
      }

      const { callId, roomId, signalUrl } = await response.json();

      // Store call info
      this.currentCall = {
        callId,
        roomId,
        calleeId,
        calleeName,
        isOutgoing: true,
      };

      // Initialize WebRTC
      this.webrtc = new WebRTCClient({
        onLocalStream: (stream) => this.emit('localStream', stream),
        onRemoteStream: (stream) => this.handleRemoteStream(stream),
        onIceCandidate: (candidate) => this.signaling?.sendIceCandidate(candidate),
        onConnectionStateChange: (state) => this.handleConnectionStateChange(state),
        onError: (error) => this.handleError(error),
      });

      await this.webrtc.initialize(iceServers);
      await this.webrtc.getUserMedia();
      this.webrtc.createPeerConnection();

      // Initialize signaling
      this.signaling = new CallSignaling({
        onOffer: (sdp, from) => this.handleOffer(sdp, from),
        onAnswer: (sdp, from) => this.handleAnswer(sdp, from),
        onIceCandidate: (candidate, from) => this.handleIceCandidate(candidate, from),
        onCallAccepted: (from) => this.handleCallAccepted(from),
        onCallEnded: (reason, callState) => this.handleCallEnded(reason),
        onParticipantDisconnected: (participant) => this.handleParticipantDisconnected(participant),
        onError: (error) => this.handleError(error),
      });

      // Get my pubkey from localStorage
      const myPubkey = this.getMyPubkey();
      await this.signaling.connect(roomId, myPubkey);

      // Emit callInitiated FIRST so UI can store call info
      this.emit('callInitiated', this.currentCall);
      
      // Then change state (which triggers UI update)
      this.setState(CallState.RINGING);
      this.playRingtone('outgoing');
      
      // Start ring timeout (30 seconds)
      this.startRingTimeout();

    } catch (error) {
      console.error('[CallManager] Initiate call error:', error);
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Start timeout for unanswered calls
   */
  startRingTimeout() {
    this.clearRingTimeout();
    this.ringTimeout = setTimeout(() => {
      if (this.state === CallState.RINGING && this.currentCall?.isOutgoing) {
        console.log('[CallManager] Ring timeout - no answer');
        this.endCall(CallEndReason.TIMEOUT);
      }
    }, this.RING_TIMEOUT_MS);
  }

  /**
   * Clear ring timeout
   */
  clearRingTimeout() {
    if (this.ringTimeout) {
      clearTimeout(this.ringTimeout);
      this.ringTimeout = null;
    }
  }

  /**
   * Answer incoming call
   */
  async answerCall(callInfo) {
    if (this.state !== CallState.RINGING) {
      throw new Error('No incoming call to answer');
    }

    this.setState(CallState.CONNECTING);
    this.stopRingtone();

    try {
      // Get TURN credentials
      const iceServers = await this.getTurnCredentials();

      // Initialize WebRTC if not already
      if (!this.webrtc) {
        this.webrtc = new WebRTCClient({
          onLocalStream: (stream) => this.emit('localStream', stream),
          onRemoteStream: (stream) => this.handleRemoteStream(stream),
          onIceCandidate: (candidate) => this.signaling?.sendIceCandidate(candidate),
          onConnectionStateChange: (state) => this.handleConnectionStateChange(state),
          onError: (error) => this.handleError(error),
        });

        await this.webrtc.initialize(iceServers);
        await this.webrtc.getUserMedia();
      }

      // Send accept signal
      this.signaling?.sendCallAccept();

      this.emit('callAnswered', this.currentCall);

    } catch (error) {
      console.error('[CallManager] Answer call error:', error);
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Handle incoming call notification from inbox polling
   */
  handleIncomingCallNotification(notification) {
    console.log('[CallManager] Received call notification:', notification);
    
    // Check if call is still fresh (not older than 60 seconds)
    const callAge = Date.now() - notification.timestamp;
    if (callAge > 60000) {
      console.log('[CallManager] Call notification too old, ignoring');
      return;
    }
    
    // Trigger the incoming call handler
    this.handleIncomingCall({
      callId: notification.callId,
      roomId: notification.roomId,
      callerId: notification.callerId,
      callerName: notification.callerName,
    });
  }

  /**
   * Handle incoming call (called from outside)
   */
  async handleIncomingCall(callInfo) {
    if (this.state !== CallState.IDLE) {
      console.warn('[CallManager] Busy, rejecting incoming call');
      // TODO: Send busy signal
      return;
    }

    const { callId, callerId, callerName, roomId } = callInfo;

    this.currentCall = {
      callId,
      roomId,
      callerId,
      callerName,
      isOutgoing: false,
    };

    // Initialize signaling
    this.signaling = new CallSignaling({
      onOffer: (sdp, from) => this.handleOffer(sdp, from),
      onAnswer: (sdp, from) => this.handleAnswer(sdp, from),
      onIceCandidate: (candidate, from) => this.handleIceCandidate(candidate, from),
      onCallEnded: (reason, callState) => this.handleCallEnded(reason),
      onParticipantDisconnected: (participant) => this.handleParticipantDisconnected(participant),
      onError: (error) => this.handleError(error),
    });

    const myPubkey = this.getMyPubkey();
    await this.signaling.connect(roomId, myPubkey);

    // Emit incomingCall FIRST so UI can store call info  
    this.emit('incomingCall', this.currentCall);
    
    // Then change state (which triggers UI update)
    this.setState(CallState.RINGING);
    this.playRingtone('incoming');
  }

  /**
   * Reject incoming call
   */
  rejectCall() {
    this.stopRingtone();
    this.signaling?.sendCallReject();
    this.cleanup();
    this.emit('callRejected', this.currentCall);
  }
  
  /**
   * Handle call cancelled by caller (received via Inbox notification)
   */
  handleCallCancelled(notificationType) {
    if (this.state !== CallState.RINGING || this.currentCall?.isOutgoing) {
      return; // Only handle for incoming calls in ringing state
    }
    
    console.log('[CallManager] Call cancelled by caller:', notificationType);
    
    const reason = notificationType === 'missed_call' 
      ? CallEndReason.TIMEOUT 
      : CallEndReason.ENDED_BY_USER;
    
    this.stopRingtone();
    
    this.emit('callEnded', {
      call: this.currentCall,
      reason,
      duration: 0,
    });
    
    this.cleanup();
  }

  /**
   * End current call
   */
  async endCall(reason = CallEndReason.ENDED_BY_USER) {
    if (this.state === CallState.IDLE || this.state === CallState.ENDED) {
      return;
    }

    this.setState(CallState.ENDING);
    this.stopRingtone();
    this.clearRingTimeout();
    
    // Send end signal through WebSocket
    console.log('[CallManager] Sending call_end via WebSocket, reason:', reason);
    this.signaling?.sendCallEnd(reason);
    
    // For timeout/cancelled - also notify via Inbox API (more reliable)
    if ((reason === CallEndReason.TIMEOUT || reason === CallEndReason.ENDED_BY_USER) 
        && this.currentCall?.isOutgoing && this.currentCall?.calleeId) {
      console.log('[CallManager] Sending Inbox notification to:', this.currentCall.calleeId);
      await this.sendMissedCallNotification(reason);
    }
    
    const durationMs = this.callStartTime ? Date.now() - this.callStartTime : 0;
    const durationSec = Math.round(durationMs / 1000);
    
    this.emit('callEnded', {
      call: this.currentCall,
      reason,
      duration: durationMs,  // Keep milliseconds for UI
    });

    // Log call for analytics - only from caller to avoid duplicates (fire and forget)
    if (this.currentCall?.isOutgoing) {
      this.logCallForAnalytics(reason, durationSec).catch(e => 
        console.warn('[CallManager] Failed to log call:', e)
      );
    }

    // Wait a bit for the message to be sent before cleanup
    await new Promise(resolve => setTimeout(resolve, 300));
    
    this.cleanup();
  }
  
  /**
   * Log call data for analytics (only called by caller)
   */
  async logCallForAnalytics(endReason, duration) {
    try {
      const session = getPersistedSession();
      if (!session?.token || !this.currentCall) {
        return;
      }
      
      const successful = this.state === CallState.ACTIVE || duration > 0;
      
      const response = await fetch(`${WORKER_API_BASE}/api/call/log`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.token}`,
        },
        body: JSON.stringify({
          callId: this.currentCall.callId,
          caller: session.pubkey,
          callee: this.currentCall.calleeId,
          duration,
          successful,
          endReason,
        }),
      });
      
      if (response.ok) {
        console.log('[CallManager] Call logged for analytics');
      }
    } catch (e) {
      console.warn('[CallManager] Failed to log call:', e.message);
    }
  }
  
  /**
   * Send missed call notification via Inbox API
   */
  async sendMissedCallNotification(reason) {
    try {
      const { getPersistedSession } = await import('../api.js');
      const session = getPersistedSession();
      if (!session?.token) {
        console.warn('[CallManager] No session token, cannot send notification');
        return;
      }
      
      const notificationType = reason === CallEndReason.TIMEOUT ? 'missed_call' : 'cancelled_call';
      
      const response = await fetch('/api/call/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.token}`,
        },
        body: JSON.stringify({
          to: this.currentCall.calleeId,
          type: notificationType,
          callId: this.currentCall.callId,
        }),
      });
      
      if (response.ok) {
        console.log(`[CallManager] Sent ${notificationType} notification successfully`);
      } else {
        const error = await response.text();
        console.error(`[CallManager] Failed to send notification:`, response.status, error);
      }
    } catch (e) {
      console.error('[CallManager] Failed to send missed call notification:', e);
    }
  }

  /**
   * Toggle mute
   */
  toggleMute() {
    if (this.webrtc) {
      const isMuted = this.webrtc.isMuted();
      this.webrtc.setMuted(!isMuted);
      this.emit('muteChanged', !isMuted);
      return !isMuted;
    }
    return false;
  }

  /**
   * Check if muted
   */
  isMuted() {
    return this.webrtc?.isMuted() ?? true;
  }

  /**
   * Get call duration in seconds
   */
  getCallDuration() {
    if (!this.callStartTime) return 0;
    return Math.floor((Date.now() - this.callStartTime) / 1000);
  }

  // ==================
  // Internal handlers
  // ==================

  handleOffer(sdp, from) {
    console.log('[CallManager] Received offer from:', from);
    
    // If we're the callee, handle the offer
    if (!this.currentCall?.isOutgoing) {
      this.webrtc?.handleOffer(sdp).then(answer => {
        this.signaling?.sendAnswer(answer);
      }).catch(error => {
        console.error('[CallManager] Handle offer error:', error);
        this.handleError(error);
      });
    }
  }

  handleAnswer(sdp, from) {
    console.log('[CallManager] Received answer from:', from);
    this.webrtc?.handleAnswer(sdp).catch(error => {
      console.error('[CallManager] Handle answer error:', error);
      this.handleError(error);
    });
  }

  handleIceCandidate(candidate, from) {
    this.webrtc?.addIceCandidate(candidate);
  }

  handleCallAccepted(from) {
    console.log('[CallManager] Call accepted by:', from);
    this.clearRingTimeout();
    this.stopRingtone();
    this.setState(CallState.CONNECTING);

    // Create and send offer (caller)
    if (this.currentCall?.isOutgoing) {
      this.webrtc?.createOffer().then(offer => {
        this.signaling?.sendOffer(offer);
      }).catch(error => {
        console.error('[CallManager] Create offer error:', error);
        this.handleError(error);
      });
    }
  }

  handleCallEnded(reason) {
    console.log('[CallManager] Call ended:', reason);
    this.stopRingtone();
    
    const duration = this.callStartTime ? Date.now() - this.callStartTime : 0;
    
    this.emit('callEnded', {
      call: this.currentCall,
      reason,
      duration,
    });

    this.cleanup();
  }

  handleParticipantDisconnected(participant) {
    console.log('[CallManager] Participant disconnected:', participant);
    this.endCall(CallEndReason.DISCONNECTED);
  }

  handleRemoteStream(stream) {
    console.log('[CallManager] Remote stream received');
    
    // Create or reuse audio element
    if (!this.audioElement) {
      this.audioElement = document.createElement('audio');
      this.audioElement.autoplay = true;
      document.body.appendChild(this.audioElement);
    }
    
    this.audioElement.srcObject = stream;
    
    // Mark call as active
    if (this.state === CallState.CONNECTING) {
      this.setState(CallState.ACTIVE);
      this.callStartTime = Date.now();
      this.startCallTimer();
    }

    this.emit('remoteStream', stream);
  }

  handleConnectionStateChange(state) {
    console.log('[CallManager] Connection state:', state);
    
    if (state === 'connected' && this.state === CallState.CONNECTING) {
      this.setState(CallState.ACTIVE);
      this.callStartTime = Date.now();
      this.startCallTimer();
    } else if (state === 'disconnected' || state === 'failed') {
      this.endCall(CallEndReason.DISCONNECTED);
    }

    this.emit('connectionStateChange', state);
  }

  handleError(error) {
    console.error('[CallManager] Error:', error);
    this.emit('error', error);
    
    if (this.state !== CallState.IDLE && this.state !== CallState.ENDED) {
      this.endCall(CallEndReason.ERROR);
    }
  }

  // ==================
  // Utilities
  // ==================

  getMyPubkey() {
    // Get pubkey from session using the api module
    const session = getPersistedSession();
    if (session?.pubkey) {
      return session.pubkey;
    }
    console.error('[CallManager] No pubkey in session!');
    return null;
  }

  playRingtone(type) {
    this.stopRingtone();
    
    // Use existing inbox sound for now
    this.ringtoneElement = new Audio('/media/inbox.mp3');
    this.ringtoneElement.loop = true;
    this.ringtoneElement.play().catch(e => console.warn('Cannot play ringtone:', e));
  }

  stopRingtone() {
    if (this.ringtoneElement) {
      this.ringtoneElement.pause();
      this.ringtoneElement.currentTime = 0;
      this.ringtoneElement = null;
    }
  }

  startCallTimer() {
    this.stopCallTimer();
    this.callTimer = setInterval(() => {
      this.emit('timerUpdate', this.getCallDuration());
    }, 1000);
  }

  stopCallTimer() {
    if (this.callTimer) {
      clearInterval(this.callTimer);
      this.callTimer = null;
    }
  }

  cleanup() {
    this.clearRingTimeout();
    this.stopCallTimer();
    this.stopRingtone();
    
    this.webrtc?.close();
    this.webrtc = null;
    
    this.signaling?.disconnect();
    this.signaling = null;
    
    if (this.audioElement) {
      this.audioElement.srcObject = null;
      this.audioElement.remove();
      this.audioElement = null;
    }
    
    this.currentCall = null;
    this.callStartTime = null;
    
    this.setState(CallState.IDLE);
  }
}

// Singleton instance
export const callManager = new CallManager();
export default callManager;


