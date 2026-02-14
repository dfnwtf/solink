/**
 * WebRTC Client for SOLINK Audio Calls
 * Handles peer connection, media streams, and ICE negotiation
 */

export class WebRTCClient {
  constructor(options = {}) {
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.iceServers = null;
    
    // Callbacks
    this.onLocalStream = options.onLocalStream || (() => {});
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onIceCandidate = options.onIceCandidate || (() => {});
    this.onConnectionStateChange = options.onConnectionStateChange || (() => {});
    this.onError = options.onError || console.error;
    
    // State
    this.isInitiator = false;
    this.connectionState = 'new';
  }

  /**
   * Initialize with ICE servers configuration from Cloudflare TURN
   */
  async initialize(iceServersConfig) {
    this.iceServers = iceServersConfig;
    console.log('[WebRTC] Initialized with ICE servers:', iceServersConfig);
  }

  /**
   * Get user's microphone stream
   */
  async getUserMedia() {
    try {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false, // Audio only
      };

      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('[WebRTC] Got local audio stream');
      
      this.onLocalStream(this.localStream);
      return this.localStream;
    } catch (error) {
      console.error('[WebRTC] getUserMedia error:', error);
      this.onError(error);
      throw error;
    }
  }

  /**
   * Create RTCPeerConnection
   */
  createPeerConnection() {
    if (this.peerConnection) {
      console.warn('[WebRTC] Peer connection already exists');
      return this.peerConnection;
    }

    // Limit to 4 ICE servers to avoid browser warning about slow discovery
    const servers = this.iceServers?.iceServers || [
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];
    
    const config = {
      iceServers: servers.slice(0, 4),
      iceCandidatePoolSize: 10,
    };

    this.peerConnection = new RTCPeerConnection(config);

    // Add local tracks to connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // Handle incoming tracks (remote audio)
    this.peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Remote track received');
      this.remoteStream = event.streams[0];
      this.onRemoteStream(this.remoteStream);
    };

    // Handle ICE candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[WebRTC] ICE candidate:', event.candidate.type);
        this.onIceCandidate(event.candidate);
      }
    };

    // Handle connection state changes
    this.peerConnection.onconnectionstatechange = () => {
      this.connectionState = this.peerConnection.connectionState;
      console.log('[WebRTC] Connection state:', this.connectionState);
      this.onConnectionStateChange(this.connectionState);
    };

    // Handle ICE connection state
    this.peerConnection.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE connection state:', this.peerConnection.iceConnectionState);
      
      if (this.peerConnection.iceConnectionState === 'failed') {
        // Attempt ICE restart
        console.log('[WebRTC] ICE failed, attempting restart...');
        this.peerConnection.restartIce();
      }
    };

    // Handle negotiation needed
    this.peerConnection.onnegotiationneeded = async () => {
      console.log('[WebRTC] Negotiation needed');
      // Only create offer if we're the initiator
      if (this.isInitiator) {
        try {
          await this.createOffer();
        } catch (error) {
          console.error('[WebRTC] Negotiation error:', error);
        }
      }
    };

    console.log('[WebRTC] Peer connection created');
    return this.peerConnection;
  }

  /**
   * Create and return SDP offer (caller)
   */
  async createOffer() {
    if (!this.peerConnection) {
      throw new Error('Peer connection not created');
    }

    this.isInitiator = true;

    const offer = await this.peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });

    await this.peerConnection.setLocalDescription(offer);
    
    console.log('[WebRTC] Offer created');
    return this.peerConnection.localDescription;
  }

  /**
   * Handle received offer and create answer (callee)
   */
  async handleOffer(offer) {
    if (!this.peerConnection) {
      this.createPeerConnection();
    }

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    
    console.log('[WebRTC] Answer created');
    return this.peerConnection.localDescription;
  }

  /**
   * Handle received answer (caller)
   */
  async handleAnswer(answer) {
    if (!this.peerConnection) {
      throw new Error('Peer connection not created');
    }

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    console.log('[WebRTC] Remote description set (answer)');
  }

  /**
   * Add received ICE candidate
   */
  async addIceCandidate(candidate) {
    if (!this.peerConnection) {
      console.warn('[WebRTC] Cannot add ICE candidate, no peer connection');
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('[WebRTC] ICE candidate added');
    } catch (error) {
      console.error('[WebRTC] Error adding ICE candidate:', error);
    }
  }

  /**
   * Mute/unmute local audio
   */
  setMuted(muted) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
      console.log('[WebRTC] Muted:', muted);
    }
  }

  /**
   * Check if local audio is muted
   */
  isMuted() {
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      return audioTrack ? !audioTrack.enabled : true;
    }
    return true;
  }

  /**
   * Get connection statistics
   */
  async getStats() {
    if (!this.peerConnection) return null;

    const stats = await this.peerConnection.getStats();
    const result = {
      bytesReceived: 0,
      bytesSent: 0,
      packetsLost: 0,
      roundTripTime: 0,
    };

    stats.forEach(report => {
      if (report.type === 'inbound-rtp' && report.kind === 'audio') {
        result.bytesReceived = report.bytesReceived || 0;
        result.packetsLost = report.packetsLost || 0;
      }
      if (report.type === 'outbound-rtp' && report.kind === 'audio') {
        result.bytesSent = report.bytesSent || 0;
      }
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        result.roundTripTime = report.currentRoundTripTime || 0;
      }
    });

    return result;
  }

  /**
   * Close connection and cleanup
   */
  close() {
    // Stop local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Close peer connection
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.remoteStream = null;
    this.connectionState = 'closed';
    
    console.log('[WebRTC] Connection closed');
  }
}

export default WebRTCClient;


