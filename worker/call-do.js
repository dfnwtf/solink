/**
 * CallSignalingDurable - Durable Object for WebRTC call signaling
 * Uses Cloudflare's WebSocket Hibernation API as per documentation:
 * https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
 */

import { DurableObject } from "cloudflare:workers";

export class CallSignalingDurable extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    
    // Map of participantId -> session data
    this.sessions = new Map();
    
    // Call state - will be loaded from storage
    this.callState = null;
    this.callStateLoaded = false;
    
    // Grace period for reconnection (5 seconds)
    this.RECONNECT_GRACE_PERIOD = 5000;
    
    // Restore any hibernated WebSocket connections
    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment();
      if (attachment?.participantId) {
        this.sessions.set(attachment.participantId, {
          ws,
          participantId: attachment.participantId,
        });
        console.log(`[Call DO] Restored WebSocket for: ${attachment.participantId}`);
      }
    });
    
    // Set up auto-response for ping/pong (doesn't wake hibernated DO)
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    );
  }
  
  /**
   * Load callState from storage (persists through hibernation)
   */
  async loadCallState() {
    if (this.callStateLoaded) return;
    
    try {
      const stored = await this.ctx.storage.get('callState');
      if (stored) {
        // Check if call is still valid (not older than 5 minutes)
        const age = Date.now() - (stored.initiatedAt || 0);
        if (age < 5 * 60 * 1000 && stored.status !== 'ended') {
          this.callState = stored;
          console.log(`[Call DO] Restored callState from storage:`, stored.callId);
        } else {
          // Clear expired call
          await this.ctx.storage.delete('callState');
          console.log(`[Call DO] Cleared expired callState`);
        }
      }
    } catch (e) {
      console.error(`[Call DO] Failed to load callState:`, e.message);
    }
    
    this.callStateLoaded = true;
  }
  
  /**
   * Save callState to storage
   */
  async saveCallState() {
    try {
      if (this.callState) {
        await this.ctx.storage.put('callState', this.callState);
      } else {
        await this.ctx.storage.delete('callState');
      }
    } catch (e) {
      console.error(`[Call DO] Failed to save callState:`, e.message);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    // Load callState from storage (persists through hibernation)
    await this.loadCallState();
    
    // WebSocket upgrade for real-time signaling
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request, url);
    }

    // HTTP endpoints for call management
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const action = body.action || url.searchParams.get("action");

      switch (action) {
        case "initiate":
          return this.handleInitiateCall(body);
        case "status":
          return this.handleGetStatus();
        case "end":
          return this.handleEndCall(body);
        default:
          return json({ error: "Unknown action" }, 400);
      }
    }

    return json({ error: "Method not allowed" }, 405);
  }

  /**
   * Handle WebSocket upgrade request
   */
  async handleWebSocketUpgrade(request, url) {
    const participantId = url.searchParams.get("participant");
    
    if (!participantId) {
      return new Response("Missing participant ID", { status: 400 });
    }

    console.log(`[Call DO] WebSocket upgrade for participant: ${participantId}`);

    // Cancel any pending disconnection alarm for this participant (they're reconnecting)
    const pending = await this.ctx.storage.get('pendingDisconnection');
    if (pending && pending.participantId === participantId) {
      console.log(`[Call DO] Cancelling pending disconnection alarm for: ${participantId}`);
      await this.ctx.storage.delete('pendingDisconnection');
      await this.ctx.storage.deleteAlarm();
    }

    // Create WebSocket pair
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept the WebSocket with Hibernation API
    // This allows the DO to hibernate while keeping connections open
    this.ctx.acceptWebSocket(server);

    // Attach participant ID to the WebSocket for restoration after hibernation
    server.serializeAttachment({ participantId });

    // Store session
    this.sessions.set(participantId, {
      ws: server,
      participantId,
    });

    console.log(`[Call DO] WebSocket connected: ${participantId}, total sessions: ${this.sessions.size}`);

    // Send current call state to new participant
    if (this.callState && this.callState.status !== 'ended') {
      try {
        server.send(JSON.stringify({
          type: "call_state",
          state: this.callState
        }));
      } catch (e) {
        console.error(`[Call DO] Failed to send initial state:`, e.message);
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle incoming WebSocket messages (Hibernation API handler)
   */
  async webSocketMessage(ws, message) {
    try {
      // Load callState from storage (in case we woke from hibernation)
      await this.loadCallState();
      
      const attachment = ws.deserializeAttachment();
      const senderId = attachment?.participantId;
      
      if (!senderId) {
        console.error("[Call DO] No participant ID in attachment");
        return;
      }

      const data = JSON.parse(message);
      console.log(`[Call DO] Message from ${senderId}:`, data.type);

      switch (data.type) {
        case "ping":
          // Explicit ping handling (in addition to auto-response)
          this.sendTo(senderId, { type: "pong" });
          break;
        case "offer":
          this.handleOffer(senderId, data);
          break;
        case "answer":
          await this.handleAnswer(senderId, data);
          break;
        case "ice_candidate":
          this.handleIceCandidate(senderId, data);
          break;
        case "call_accept":
          await this.handleCallAccept(senderId);
          break;
        case "call_reject":
          await this.handleCallReject(senderId);
          break;
        case "call_end":
          await this.handleCallEndSignal(senderId, data);
          break;
        default:
          console.warn(`[Call DO] Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error("[Call DO] Message handling error:", error.message);
    }
  }

  /**
   * Handle WebSocket close (Hibernation API handler)
   */
  async webSocketClose(ws, code, reason, wasClean) {
    // Load callState from storage
    await this.loadCallState();
    
    const attachment = ws.deserializeAttachment();
    const participantId = attachment?.participantId;
    
    console.log(`[Call DO] WebSocket closed: ${participantId}, code: ${code}, reason: ${reason}, wasClean: ${wasClean}, sessions: ${this.sessions.size}`);
    
    if (participantId) {
      this.sessions.delete(participantId);
      console.log(`[Call DO] Removed session, remaining: ${this.sessions.size}`);
      
      // Check if there's an active call that might be affected
      if (this.callState && (this.callState.status === "active" || this.callState.status === "ringing" || this.callState.status === "connecting")) {
        
        // For abnormal closures (1006, 1001), use alarm for delayed check
        // This survives DO hibernation better than setTimeout
        if (code === 1006 || code === 1001) {
          console.log(`[Call DO] Abnormal closure, scheduling reconnection check via alarm`);
          
          // Store pending disconnection in storage for alarm to check
          await this.ctx.storage.put('pendingDisconnection', {
            participantId,
            timestamp: Date.now()
          });
          
          // Schedule alarm in 5 seconds (DO alarms survive hibernation)
          await this.ctx.storage.setAlarm(Date.now() + this.RECONNECT_GRACE_PERIOD);
          
        } else {
          // Clean closure (1000) - end call immediately
          console.log(`[Call DO] Clean closure (${code}), ending call immediately`);
          
          this.broadcastExcept(participantId, {
            type: "participant_disconnected",
            participant: participantId
          });
          
          this.callState.status = "ended";
          this.callState.endReason = "disconnected";
          this.callState.endedAt = Date.now();
          await this.saveCallState();
        }
      }
    }
  }
  
  /**
   * Handle alarm (used for delayed disconnection check)
   */
  async alarm() {
    console.log(`[Call DO] Alarm triggered`);
    
    const pending = await this.ctx.storage.get('pendingDisconnection');
    if (!pending) {
      console.log(`[Call DO] No pending disconnection`);
      return;
    }
    
    await this.ctx.storage.delete('pendingDisconnection');
    
    const { participantId, timestamp } = pending;
    const age = Date.now() - timestamp;
    
    console.log(`[Call DO] Checking disconnection for ${participantId}, age: ${age}ms`);
    
    // Check if participant reconnected
    if (this.sessions.has(participantId)) {
      console.log(`[Call DO] ${participantId} reconnected, not ending call`);
      return;
    }
    
    // Load callState
    await this.loadCallState();
    
    // Only end call if still in active state
    if (this.callState && this.callState.status !== "ended") {
      console.log(`[Call DO] Grace period expired, ending call due to ${participantId} disconnection`);
      
      this.broadcastExcept(participantId, {
        type: "participant_disconnected",
        participant: participantId
      });
      
      this.callState.status = "ended";
      this.callState.endReason = "disconnected";
      this.callState.endedAt = Date.now();
      await this.saveCallState();
    }
  }

  /**
   * Handle WebSocket error (Hibernation API handler)
   */
  async webSocketError(ws, error) {
    const attachment = ws.deserializeAttachment();
    console.error(`[Call DO] WebSocket error for ${attachment?.participantId}:`, error);
  }

  // === Call Management ===

  async handleInitiateCall(body) {
    const { callerId, calleeId, callerName } = body;

    if (!callerId || !calleeId) {
      return json({ error: "Missing caller or callee ID" }, 400);
    }

    if (this.callState && this.callState.status === "active") {
      return json({ error: "Call already in progress" }, 409);
    }

    const callId = crypto.randomUUID();
    
    this.callState = {
      callId,
      callerId,
      calleeId,
      callerName: callerName || null,
      status: "ringing",
      initiatedAt: Date.now(),
      answeredAt: null,
      endedAt: null,
      endReason: null
    };

    // Persist callState to storage
    await this.saveCallState();

    console.log(`[Call DO] Call initiated: ${callerId} -> ${calleeId}, callId: ${callId}`);

    return json({ 
      success: true, 
      callId,
      callState: this.callState 
    });
  }

  handleGetStatus() {
    return json({ callState: this.callState });
  }

  async handleEndCall(body) {
    const { reason } = body;

    if (this.callState) {
      this.callState.status = "ended";
      this.callState.endReason = reason || "ended";
      this.callState.endedAt = Date.now();

      this.broadcast({
        type: "call_ended",
        reason: this.callState.endReason,
        callState: this.callState
      });
      
      // Clear from storage
      await this.saveCallState();
    }

    return json({ success: true });
  }

  // === WebRTC Signaling ===

  handleOffer(senderId, data) {
    const targetId = this.getOtherParticipant(senderId);
    
    if (targetId) {
      console.log(`[Call DO] Forwarding offer from ${senderId} to ${targetId}`);
      this.sendTo(targetId, {
        type: "offer",
        sdp: data.sdp,
        from: senderId
      });
    } else {
      console.log(`[Call DO] No target for offer from ${senderId}`);
    }
  }

  async handleAnswer(senderId, data) {
    const targetId = this.getOtherParticipant(senderId);
    
    if (targetId) {
      console.log(`[Call DO] Forwarding answer from ${senderId} to ${targetId}`);
      this.sendTo(targetId, {
        type: "answer",
        sdp: data.sdp,
        from: senderId
      });
    }

    if (this.callState && (this.callState.status === "ringing" || this.callState.status === "connecting")) {
      this.callState.status = "active";
      this.callState.answeredAt = Date.now();
      await this.saveCallState();
    }
  }

  handleIceCandidate(senderId, data) {
    const targetId = this.getOtherParticipant(senderId);
    
    if (targetId) {
      this.sendTo(targetId, {
        type: "ice_candidate",
        candidate: data.candidate,
        from: senderId
      });
    }
  }

  async handleCallAccept(senderId) {
    console.log(`[Call DO] handleCallAccept from ${senderId}, callState: ${JSON.stringify(this.callState)}`);
    
    if (this.callState && this.callState.calleeId === senderId) {
      this.callState.status = "connecting";
      
      console.log(`[Call DO] Call accepted by ${senderId}, notifying caller: ${this.callState.callerId}`);
      await this.saveCallState();
      
      const sent = this.sendTo(this.callState.callerId, {
        type: "call_accepted",
        from: senderId
      });
      
      if (!sent) {
        console.error(`[Call DO] CRITICAL: Failed to notify caller ${this.callState.callerId} about call acceptance!`);
        // Broadcast to all connected sessions as fallback
        this.broadcast({
          type: "call_accepted",
          from: senderId
        });
      }
    } else {
      console.warn(`[Call DO] handleCallAccept: callState mismatch or null. calleeId: ${this.callState?.calleeId}, senderId: ${senderId}`);
    }
  }

  async handleCallReject(senderId) {
    if (this.callState) {
      this.callState.status = "ended";
      this.callState.endReason = "rejected";
      this.callState.endedAt = Date.now();

      console.log(`[Call DO] Call rejected by ${senderId}`);
      await this.saveCallState();

      this.broadcast({
        type: "call_ended",
        reason: "rejected",
        callState: this.callState
      });
    }
  }

  async handleCallEndSignal(senderId, data) {
    if (this.callState) {
      this.callState.status = "ended";
      this.callState.endReason = data.reason || "ended_by_user";
      this.callState.endedAt = Date.now();

      console.log(`[Call DO] Call ended by ${senderId}`);
      await this.saveCallState();

      this.broadcastExcept(senderId, {
        type: "call_ended",
        reason: this.callState.endReason,
        callState: this.callState
      });
    }
  }

  // === Helpers ===

  getOtherParticipant(currentId) {
    if (!this.callState) return null;
    
    if (this.callState.callerId === currentId) {
      return this.callState.calleeId;
    } else if (this.callState.calleeId === currentId) {
      return this.callState.callerId;
    }
    return null;
  }

  sendTo(participantId, message) {
    const session = this.sessions.get(participantId);
    console.log(`[Call DO] sendTo ${participantId}: ${message.type}, hasSession: ${!!session}, wsState: ${session?.ws?.readyState}`);
    
    if (session?.ws) {
      try {
        // Check WebSocket is actually open (readyState 1 = OPEN)
        if (session.ws.readyState === 1) {
          session.ws.send(JSON.stringify(message));
          console.log(`[Call DO] Sent ${message.type} to ${participantId}`);
          return true;
        } else {
          console.warn(`[Call DO] WebSocket not open for ${participantId}, state: ${session.ws.readyState}`);
          this.sessions.delete(participantId);
        }
      } catch (e) {
        console.error(`[Call DO] Failed to send to ${participantId}:`, e.message);
        this.sessions.delete(participantId);
      }
    } else {
      console.warn(`[Call DO] No WebSocket session for: ${participantId}, available sessions: ${Array.from(this.sessions.keys()).join(', ')}`);
    }
    return false;
  }

  broadcast(message) {
    const msg = JSON.stringify(message);
    for (const [id, session] of this.sessions) {
      try {
        session.ws.send(msg);
      } catch (e) {
        console.error(`[Call DO] Broadcast failed for ${id}:`, e.message);
        this.sessions.delete(id);
      }
    }
  }

  broadcastExcept(excludeId, message) {
    const msg = JSON.stringify(message);
    for (const [id, session] of this.sessions) {
      if (id !== excludeId) {
        try {
          session.ws.send(msg);
        } catch (e) {
          console.error(`[Call DO] Broadcast failed for ${id}:`, e.message);
          this.sessions.delete(id);
        }
      }
    }
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json;charset=UTF-8" }
  });
}
