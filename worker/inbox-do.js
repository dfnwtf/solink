const STORAGE_KEY = "queue";
export const MAX_BATCH = 100;
export const INBOX_DELIVERY_TTL_MS = 5 * 60 * 1000;

export class InboxDurable {
  constructor(state) {
    this.state = state;
    this.queueCache = null;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let payload = null;
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }

    const action = payload?.action;
    switch (action) {
      case "store":
        return this.handleStore(payload?.message);
      case "pull":
        return this.handlePull(payload?.limit);
      case "ack":
        return this.handleAck(payload?.ids || []);
      default:
        return new Response("Unknown action", { status: 400 });
    }
  }

  async loadQueue() {
    if (!this.queueCache) {
      this.queueCache = (await this.state.storage.get(STORAGE_KEY)) || [];
    }
    return this.queueCache;
  }

  cleanupExpired() {
    if (!this.queueCache) return;
    const now = Date.now();
    this.queueCache = this.queueCache.filter((message) => !message?.expiresAt || message.expiresAt > now);
  }

  async persistQueue() {
    await this.state.storage.put(STORAGE_KEY, this.queueCache || []);
  }

  async handleStore(message) {
    if (!message || typeof message !== "object" || !message.id) {
      return json({ error: "Invalid message payload" }, 400);
    }
    await this.state.blockConcurrencyWhile(async () => {
      await this.loadQueue();
      this.cleanupExpired();
      const exists = this.queueCache.some((item) => item.id === message.id);
      if (!exists) {
        this.queueCache.push(message);
      }
      await this.persistQueue();
    });
    return json({ ok: true });
  }

  async handlePull(limit) {
    await this.loadQueue();
    this.cleanupExpired();
    await this.persistQueue();
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_BATCH) : MAX_BATCH;
    const messages = this.queueCache.slice(0, safeLimit);
    return json({ messages });
  }

  async handleAck(ids) {
    if (!Array.isArray(ids) || !ids.length) {
      return json({ ok: true });
    }
    const idSet = new Set(ids.filter(Boolean));
    if (!idSet.size) {
      return json({ ok: true });
    }
    await this.state.blockConcurrencyWhile(async () => {
      await this.loadQueue();
      this.queueCache = this.queueCache.filter((message) => !idSet.has(message.id));
      await this.persistQueue();
    });
    return json({ ok: true });
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json;charset=UTF-8" },
  });
}

