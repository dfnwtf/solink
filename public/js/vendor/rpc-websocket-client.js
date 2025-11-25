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

const defaultBrowserFactory = (url, options = {}) =>
  new WebSocket(url, options.protocols);

export default class RpcWebSocketClient extends EventEmitter {
  constructor(arg1, arg2 = 'ws://localhost:8080', arg3 = {}, arg4) {
    super();

    let factory = arg1;
    let address = arg2;
    let options = arg3;
    let generator = arg4;

    if (typeof factory !== 'function') {
      generator = arg3;
      options = typeof arg2 === 'object' && arg2 !== null ? arg2 : {};
      address = typeof arg1 === 'string' ? arg1 : 'ws://localhost:8080';
      factory = defaultBrowserFactory;
    }

    const safeOptions = options || {};
    const {
      autoconnect = true,
      reconnect = true,
      reconnect_interval = 1000,
      max_reconnects = 5,
      requestTimeoutMs = 15000,
      protocols,
      ...restOptions
    } = safeOptions;

    this.webSocketFactory = factory;
    this.address = address;
    this.autoconnect = autoconnect;
    this.reconnect = reconnect;
    this.reconnectInterval = reconnect_interval;
    this.maxReconnects = max_reconnects;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectionOptions = { protocols, ...restOptions };
    this.generateRequestId =
      generator || safeOptions.generate_request_id || (() => ++fallbackRequestId);

    this.socket = null;
    this.ready = false;
    this.queue = {};
    this.currentReconnects = 0;
    this.reconnectTimer = undefined;

    if (this.autoconnect) {
      this._connect(this.address, this.connectionOptions);
    }
  }

  get readyState() {
    return this.socket ? this.socket.readyState : WebSocket.CLOSED;
  }

  connect() {
    if (this.socket) {
      return;
    }
    this._connect(this.address, this.connectionOptions);
  }

  call(method, params = null, timeoutOrOptions, maybeWsOptions) {
    let timeout = timeoutOrOptions;
    let wsOptions = maybeWsOptions;

    if (
      typeof timeout === 'object' &&
      timeout !== null &&
      typeof wsOptions === 'undefined'
    ) {
      wsOptions = timeout;
      timeout = undefined;
    }

    const effectiveTimeout =
      typeof timeout === 'number' ? timeout : this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      if (!this.ready) {
        reject(new Error('socket not ready'));
        return;
      }

      const id = this.generateRequestId(method, params);
      const message = {
        jsonrpc: '2.0',
        method,
        params: params ?? null,
        id,
      };

      try {
        const payload = JSON.stringify(message);
        if (this.socket.send.length >= 2 && (wsOptions || this.socket.send.length > 1)) {
          this.socket.send(payload, wsOptions, (error) => {
            if (error) {
              reject(error);
            }
          });
        } else {
          this.socket.send(payload);
        }
      } catch (error) {
        reject(error);
        return;
      }

      const record = {
        resolve,
        reject,
        timeoutHandle: effectiveTimeout
          ? setTimeout(() => {
              delete this.queue[id];
              reject(new Error('reply timeout'));
            }, effectiveTimeout)
          : null,
      };

      this.queue[id] = record;
    });
  }

  login(params) {
    return this.call('rpc.login', params).then((result) => {
      if (!result) {
        throw new Error('authentication failed');
      }
      return result;
    });
  }

  listMethods() {
    return this.call('__listMethods');
  }

  notify(method, params = null) {
    return new Promise((resolve, reject) => {
      if (!this.ready) {
        reject(new Error('socket not ready'));
        return;
      }
      const payload = {
        jsonrpc: '2.0',
        method,
        params: params ?? null,
      };
      try {
        const serialized = JSON.stringify(payload);
        if (this.socket.send.length >= 1) {
          this.socket.send(serialized, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
          if (this.socket.send.length === 1) {
            resolve();
          }
        } else {
          this.socket.send(serialized);
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  subscribe(event) {
    const list = typeof event === 'string' ? [event] : event;
    return this.call('rpc.on', list);
  }

  unsubscribe(event) {
    const list = typeof event === 'string' ? [event] : event;
    return this.call('rpc.off', list);
  }

  close(code = 1000, reason) {
    this.reconnect = false;
    if (this.socket) {
      this.socket.close(code, reason);
    }
  }

  _handleIncomingMessage(raw) {
    let payload = raw;
    if (payload && typeof payload === 'object' && 'data' in payload) {
      payload = payload.data;
    }

    let message;
    try {
      message = JSON.parse(ensureJson(payload));
    } catch {
      return;
    }

    if (Array.isArray(message)) {
      message.forEach((entry) => this._handleIncomingMessage({ data: entry }));
      return;
    }

    if (message.notification && this.listeners(message.notification).length) {
      if (!Object.keys(message.params || {}).length) {
        this.emit(message.notification);
        return;
      }
      const args = [message.notification];
      if (Array.isArray(message.params)) {
        args.push(...message.params);
      } else {
        args.push(message.params);
      }
      Promise.resolve().then(() => this.emit.apply(this, args));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(this.queue, message.id)) {
      const record = this.queue[message.id];
      if (record.timeoutHandle) {
        clearTimeout(record.timeoutHandle);
      }
      if (message.error) {
        record.reject(message.error);
      } else {
        record.resolve(message.result);
      }
      delete this.queue[message.id];
      return;
    }

    if (message.method && message.params) {
      this.emit(message.method, message.params);
    }
  }

  _connect(address, options) {
    clearTimeout(this.reconnectTimer);
    const socket = this.webSocketFactory(address, options);
    this.socket = socket;

    const onOpen = () => {
      this.ready = true;
      this.currentReconnects = 0;
      this.emit('open');
    };

    const onMessage = (event) => this._handleIncomingMessage(event);

    const onError = (event) => {
      this.emit('error', event);
      // For browser WebSockets, errors usually precede a close event,
      // so proactively terminate to avoid lingering sockets and noise.
      if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
        this.socket.close();
      }
    };

    const onClose = (event = {}) => {
      const { code = 1000, reason = '' } = event;
      if (this.ready) {
        setTimeout(() => this.emit('close', code, reason), 0);
      }
      this.ready = false;
      this.socket = null;

      Object.keys(this.queue).forEach((key) => {
        const record = this.queue[key];
        if (record.timeoutHandle) {
          clearTimeout(record.timeoutHandle);
        }
        record.reject(new Error('socket closed'));
        delete this.queue[key];
      });

      if (code !== 1000) {
        this._scheduleReconnect(address, options);
      }
    };

    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    } else {
      socket.onopen = onOpen;
      socket.onmessage = onMessage;
      socket.onerror = onError;
      socket.onclose = onClose;
    }
  }

  _scheduleReconnect(address, options) {
    if (
      !this.reconnect ||
      (this.maxReconnects &&
        this.currentReconnects >= this.maxReconnects)
    ) {
      return;
    }

    this.currentReconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this._connect(address, options);
    }, this.reconnectInterval);
  }
}
