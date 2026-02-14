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
    this.maxReconnectAttempts = 3;
    this.pingInterval = null;
    this.intentionalClose = false; // Flag to prevent reconnect after intentional disconnect
    
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
    this.onError = options.onError || console.error;
  }

  /**
   * Connect to signaling server
   */
  connect(roomId, participantId) {
    return new Promise((resolve, reject) => {
      this.roomId = roomId;
      this.participantId = participantId;

      // Use Cloudflare Worker directly for WebSocket (Hostinger doesn't proxy WebSocket)
      const workerHost = 'solink-worker.official-716.workers.dev';
      const url = `wss://${workerHost}/api/call/signal/${roomId}?participant=${participantId}`;

      console.log('[Signaling] Connecting to:', url);

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[Signaling] Connected');
        this.reconnectAttempts = 0;
        this.intentionalClose = false; // Reset flag on new connection
        this.startPing();
        this.onConnected();
        resolve();
      };

      this.ws.onclose = (event) => {
        console.log('[Signaling] Disconnected:', event.code, event.reason, 'intentional:', this.intentionalClose);
        this.stopPing();
        this.onDisconnected(event);
        
        // Attempt reconnect only for abnormal closures and if not intentionally closed
        if (!this.intentionalClose && event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`[Signaling] Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          setTimeout(() => this.connect(roomId, participantId), 1000 * this.reconnectAttempts);
        }
      };

      this.ws.onerror = (error) => {
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
   * Send message to server
   */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('[Signaling] Cannot send, WebSocket not open');
    }
  }

  /**
   * Start ping interval for keep-alive
   */
  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping' });
    }, 30000); // Ping every 30 seconds
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


