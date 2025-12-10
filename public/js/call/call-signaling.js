/**
 * Call Signaling Client for SOLINK Audio Calls
 * Handles WebSocket communication with signaling server
 */

export class CallSignaling {
  constructor(options = {}) {
    this.ws = null;
    this.roomId = null;
    this.participantId = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5; // Increased from 3 to 5
    this.pingInterval = null;
    this.intentionalClose = false; // Flag to prevent reconnect after intentional disconnect
    this.reconnectDelay = 1000; // Start with 1 second delay
    this.pendingMessages = []; // Queue messages during reconnect
    
    // Callbacks
    this.onOffer = options.onOffer || (() => {});
    this.onAnswer = options.onAnswer || (() => {});
    this.onIceCandidate = options.onIceCandidate || (() => {});
    this.onCallAccepted = options.onCallAccepted || (() => {});
    this.onCallEnded = options.onCallEnded || (() => {});
    this.onCallState = options.onCallState || (() => {});
    this.onParticipantDisconnected = options.onParticipantDisconnected || (() => {});
    this.onConnected = options.onConnected || (() => {});
    this.onDisconnected = options.onDisconnected || (() => {});
    this.onReconnecting = options.onReconnecting || (() => {});
    this.onError = options.onError || console.error;
  }

  /**
   * Connect to signaling server
   */
  connect(roomId, participantId) {
    return new Promise((resolve, reject) => {
      this.roomId = roomId;
      this.participantId = participantId;
      
      // Reset intentionalClose flag BEFORE connecting (in case of reconnect after previous call)
      this.intentionalClose = false;

      // Use Cloudflare Worker directly for WebSocket (Hostinger doesn't proxy WebSocket)
      const workerHost = 'solink-worker.official-716.workers.dev';
      const url = `wss://${workerHost}/api/call/signal/${roomId}?participant=${participantId}`;

      console.log('[Signaling] Connecting to:', url);

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[Signaling] Connected');
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.intentionalClose = false; // Reset flag on new connection
        this.startPing();
        
        // Flush any pending messages
        this.flushPendingMessages();
        
        this.onConnected();
        resolve();
      };

      this.ws.onclose = (event) => {
        console.log('[Signaling] Disconnected:', event.code, event.reason, 'intentional:', this.intentionalClose);
        this.stopPing();
        this.onDisconnected(event);
        
        // Attempt reconnect only for abnormal closures and if not intentionally closed
        // Code 1006 = abnormal closure (network issue), 1001 = going away
        const shouldReconnect = !this.intentionalClose && 
          event.code !== 1000 && 
          this.reconnectAttempts < this.maxReconnectAttempts;
          
        if (shouldReconnect) {
          this.reconnectAttempts++;
          // Exponential backoff with jitter
          const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 10000);
          const jitter = Math.random() * 500;
          
          console.log(`[Signaling] Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${Math.round(delay)}ms...`);
          this.onReconnecting({ attempt: this.reconnectAttempts, maxAttempts: this.maxReconnectAttempts });
          
          setTimeout(() => {
            if (!this.intentionalClose) {
              this.connect(roomId, participantId).catch(err => {
                console.error('[Signaling] Reconnect failed:', err);
              });
            }
          }, delay + jitter);
        }
      };

      this.ws.onerror = (error) => {
        // Don't treat page unload interruptions as errors
        if (document.readyState !== 'complete' || document.hidden) {
          console.log('[Signaling] WebSocket error during page transition, ignoring');
          return;
        }
        console.error('[Signaling] Error:', error);
        this.onError(error);
        reject(error);
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  /**
   * Handle incoming messages
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      console.log('[Signaling] Received:', message.type);

      switch (message.type) {
        case 'offer':
          this.onOffer(message.sdp, message.from);
          break;
        case 'answer':
          this.onAnswer(message.sdp, message.from);
          break;
        case 'ice_candidate':
          this.onIceCandidate(message.candidate, message.from);
          break;
        case 'call_accepted':
          this.onCallAccepted(message.from);
          break;
        case 'call_ended':
          this.onCallEnded(message.reason, message.callState);
          break;
        case 'call_state':
          this.onCallState(message.state);
          break;
        case 'participant_disconnected':
          this.onParticipantDisconnected(message.participant);
          break;
        case 'pong':
          // Keep-alive response
          break;
        case 'error':
          this.onError(new Error(message.message));
          break;
        default:
          console.warn('[Signaling] Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('[Signaling] Message parse error:', error);
    }
  }

  /**
   * Send SDP offer
   */
  sendOffer(sdp) {
    this.send({
      type: 'offer',
      sdp: sdp,
    });
  }

  /**
   * Send SDP answer
   */
  sendAnswer(sdp) {
    this.send({
      type: 'answer',
      sdp: sdp,
    });
  }

  /**
   * Send ICE candidate
   */
  sendIceCandidate(candidate) {
    this.send({
      type: 'ice_candidate',
      candidate: candidate,
    });
  }

  /**
   * Accept incoming call
   */
  sendCallAccept() {
    this.send({
      type: 'call_accept',
    });
  }

  /**
   * Reject incoming call
   */
  sendCallReject() {
    this.send({
      type: 'call_reject',
    });
  }

  /**
   * End the call
   */
  sendCallEnd(reason = 'ended_by_user') {
    this.send({
      type: 'call_end',
      reason: reason,
    });
  }

  /**
   * Send message to server (with queue for reconnect scenarios)
   */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue important messages (not ping) for retry after reconnect
      if (message.type !== 'ping') {
        console.warn('[Signaling] WebSocket not open, queuing message:', message.type);
        this.pendingMessages.push(message);
        
        // Limit queue size
        if (this.pendingMessages.length > 20) {
          this.pendingMessages.shift();
        }
      }
    }
  }
  
  /**
   * Flush pending messages after reconnect
   */
  flushPendingMessages() {
    if (this.pendingMessages.length > 0) {
      console.log(`[Signaling] Flushing ${this.pendingMessages.length} pending messages`);
      const messages = [...this.pendingMessages];
      this.pendingMessages = [];
      
      for (const message of messages) {
        this.send(message);
      }
    }
  }

  /**
   * Start ping interval for keep-alive
   * Cloudflare Workers WebSocket has ~30s idle timeout, so ping every 10s to be safe
   */
  startPing() {
    this.stopPing();
    // Send ping immediately
    this.send({ type: 'ping' });
    
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
        console.log('[Signaling] Ping sent');
      } else {
        console.warn('[Signaling] WebSocket not open during ping, state:', this.ws?.readyState);
      }
    }, 10000); // Ping every 10 seconds (CF idle timeout is ~30s)
  }

  /**
   * Stop ping interval
   */
  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
  
  /**
   * Check if WebSocket is in a stale state (CLOSING or CLOSED but not intentionally)
   */
  isStale() {
    if (!this.ws) return false;
    // CLOSING = 2, CLOSED = 3
    return (this.ws.readyState === 2 || this.ws.readyState === 3) && !this.intentionalClose;
  }
  
  /**
   * Force reconnect if connection is stale
   */
  async ensureConnected() {
    if (this.isStale() && this.roomId && this.participantId) {
      console.log('[Signaling] Connection is stale, forcing reconnect');
      this.ws = null;
      this.reconnectAttempts = 0;
      await this.connect(this.roomId, this.participantId);
    }
  }

  /**
   * Disconnect from signaling server
   */
  disconnect() {
    console.log('[Signaling] Disconnecting intentionally...');
    this.intentionalClose = true; // Prevent reconnect attempts
    this.stopPing();
    
    if (this.ws) {
      this.ws.close(1000, 'User disconnect');
      this.ws = null;
    }
    
    this.roomId = null;
    this.participantId = null;
  }
}

export default CallSignaling;


