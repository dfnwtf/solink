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
    
    // Call state stored in memory (will be lost on hibernation, but that's OK for short calls)
    this.callState = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    
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
  handleWebSocketUpgrade(request, url) {
    const participantId = url.searchParams.get("participant");
    
    if (!participantId) {
      return new Response("Missing participant ID", { status: 400 });
    }

    console.log(`[Call DO] WebSocket upgrade for participant: ${participantId}`);

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
    if (this.callState) {
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
      const attachment = ws.deserializeAttachment();
      const senderId = attachment?.participantId;
      
      if (!senderId) {
        console.error("[Call DO] No participant ID in attachment");
        return;
      }

      const data = JSON.parse(message);
      console.log(`[Call DO] Message from ${senderId}:`, data.type);

      switch (data.type) {
        case "offer":
          this.handleOffer(senderId, data);
          break;
        case "answer":
          this.handleAnswer(senderId, data);
          break;
        case "ice_candidate":
          this.handleIceCandidate(senderId, data);
          break;
        case "call_accept":
          this.handleCallAccept(senderId);
          break;
        case "call_reject":
          this.handleCallReject(senderId);
          break;
        case "call_end":
          this.handleCallEndSignal(senderId, data);
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
    const attachment = ws.deserializeAttachment();
    const participantId = attachment?.participantId;
    
    console.log(`[Call DO] WebSocket closed: ${participantId}, code: ${code}, reason: ${reason}`);
    
    if (participantId) {
      this.sessions.delete(participantId);
      
      // Notify other participant about disconnection
      if (this.callState && (this.callState.status === "active" || this.callState.status === "ringing")) {
        this.broadcastExcept(participantId, {
          type: "participant_disconnected",
          participant: participantId
        });
        
        this.callState.status = "ended";
        this.callState.endReason = "disconnected";
        this.callState.endedAt = Date.now();
      }
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

  handleInitiateCall(body) {
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

  handleEndCall(body) {
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

  handleAnswer(senderId, data) {
    const targetId = this.getOtherParticipant(senderId);
    
    if (targetId) {
      console.log(`[Call DO] Forwarding answer from ${senderId} to ${targetId}`);
      this.sendTo(targetId, {
        type: "answer",
        sdp: data.sdp,
        from: senderId
      });
    }

    if (this.callState && this.callState.status === "ringing") {
      this.callState.status = "active";
      this.callState.answeredAt = Date.now();
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

  handleCallAccept(senderId) {
    if (this.callState && this.callState.calleeId === senderId) {
      this.callState.status = "connecting";
      
      console.log(`[Call DO] Call accepted by ${senderId}`);
      
      this.sendTo(this.callState.callerId, {
        type: "call_accepted",
        from: senderId
      });
    }
  }

  handleCallReject(senderId) {
    if (this.callState) {
      this.callState.status = "ended";
      this.callState.endReason = "rejected";
      this.callState.endedAt = Date.now();

      console.log(`[Call DO] Call rejected by ${senderId}`);

      this.broadcast({
        type: "call_ended",
        reason: "rejected",
        callState: this.callState
      });
    }
  }

  handleCallEndSignal(senderId, data) {
    if (this.callState) {
      this.callState.status = "ended";
      this.callState.endReason = data.reason || "ended_by_user";
      this.callState.endedAt = Date.now();

      console.log(`[Call DO] Call ended by ${senderId}`);

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
    if (session?.ws) {
      try {
        session.ws.send(JSON.stringify(message));
        return true;
      } catch (e) {
        console.error(`[Call DO] Failed to send to ${participantId}:`, e.message);
        this.sessions.delete(participantId);
      }
    } else {
      console.log(`[Call DO] No WebSocket session for: ${participantId}`);
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
