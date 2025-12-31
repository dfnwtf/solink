import EventEmitter from './eventemitter3-wrapper.js';

function ensureJson(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value);
  }
  return String(value ?? '');
}

let fallbackRequestId = 0;

export default class RpcWebSocketClient extends EventEmitter {
  constructor(url, options = {}, generateRequestId) {
    super();
    this.url = url;
    this.options = {
      autoconnect: true,
      reconnect: true,
      max_reconnects: 0,
      reconnect_interval: 1000,
      protocols: undefined,
      requestTimeoutMs: 15000,
      ...options,
    };
    this.generateRequestId =
      generateRequestId ||
      options.generate_request_id ||
      (() => ++fallbackRequestId);

    this.socket = null;
    this._pending = new Map();
    this._currentReconnects = 0;

    if (this.options.autoconnect) {
      this.connect();
    }
  }

  get ready() {
    return this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  connect() {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const ws = new WebSocket(this.url, this.options.protocols);
    this.socket = ws;

    ws.addEventListener('open', () => {
      this._currentReconnects = 0;
      this.emit('open');
    });

    ws.addEventListener('message', (event) => {
      this._handleMessage(event.data);
    });

    ws.addEventListener('error', (event) => {
      this.emit('error', event);
    });

    ws.addEventListener('close', (event) => {
      this.emit('close', event.code, event.reason);
      this.socket = null;
      for (const [, { reject }] of this._pending) {
        reject(new Error('WebSocket closed before response'));
      }
      this._pending.clear();
      this._maybeReconnect();
    });
  }

  close(code = 1000, reason) {
    this.options.reconnect = false;
    if (this.socket) {
      this.socket.close(code, reason);
    }
  }

  call(method, params = [], timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.ready) {
        reject(new Error('WebSocket is not open'));
        return;
      }

      const id = this.generateRequestId(method, params);
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      const timeout =
        typeof timeoutMs === 'number'
          ? timeoutMs
          : this.options.requestTimeoutMs;

      const record = {
        resolve,
        reject,
        timeoutHandle: timeout
          ? setTimeout(() => {
              this._pending.delete(id);
              reject(new Error('reply timeout'));
            }, timeout)
          : null,
      };

      this._pending.set(id, record);
      this.socket.send(JSON.stringify(payload));
    });
  }

  async notify(method, params = []) {
    if (!this.ready) {
      throw new Error('WebSocket is not open');
    }
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.socket.send(JSON.stringify(payload));
  }

  _handleMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(ensureJson(raw));
    } catch (err) {
      this.emit('error', err);
      return;
    }

    if (Array.isArray(payload)) {
      payload.forEach((entry) => this._handleMessage(JSON.stringify(entry)));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'id')) {
      const handler = this._pending.get(payload.id);
      if (!handler) {
        return;
      }
      this._pending.delete(payload.id);
      if (handler.timeoutHandle) {
        clearTimeout(handler.timeoutHandle);
      }
      if (payload.error) {
        handler.reject(payload.error);
      } else {
        handler.resolve(payload.result);
      }
      return;
    }

    if (payload.method) {
      if (
        payload.params &&
        Object.prototype.hasOwnProperty.call(payload.params, 'subscription')
      ) {
        this.emit(
          payload.method,
          payload.params.result,
          payload.params.subscription,
        );
      } else {
        this.emit(payload.method, payload.params);
      }
    }
  }

  _maybeReconnect() {
    if (
      !this.options.reconnect ||
      (this.options.max_reconnects &&
        this._currentReconnects >= this.options.max_reconnects)
    ) {
      return;
    }

    this._currentReconnects += 1;
    setTimeout(() => {
      this.connect();
    }, this.options.reconnect_interval);
  }
}

