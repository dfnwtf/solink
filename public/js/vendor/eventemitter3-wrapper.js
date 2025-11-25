/**
 * Lightweight EventEmitter compatible with the subset of the original
 * eventemitter3 API that rpc-websockets relies on. We vendor it locally so we
 * don't depend on jsDelivr's bundled ESM quirks.
 */
class EventEmitter {
  constructor() {
    this._events = Object.create(null);
  }

  _getListeners(event) {
    if (!this._events[event]) {
      this._events[event] = [];
    }
    return this._events[event];
  }

  on(event, fn, context) {
    if (typeof fn !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    this._getListeners(event).push({
      fn,
      context: context ?? this,
      once: false,
    });
    return this;
  }

  addListener(event, fn, context) {
    return this.on(event, fn, context);
  }

  once(event, fn, context) {
    const listeners = this._getListeners(event);
    listeners.push({
      fn,
      context: context ?? this,
      once: true,
    });
    return this;
  }

  off(event, fn, context) {
    const listeners = this._events[event];
    if (!listeners) {
      return this;
    }
    this._events[event] = listeners.filter(
      (listener) => listener.fn !== fn || (context && listener.context !== context),
    );
    if (this._events[event].length === 0) {
      delete this._events[event];
    }
    return this;
  }

  removeListener(event, fn, context) {
    return this.off(event, fn, context);
  }

  removeAllListeners(event) {
    if (typeof event === 'undefined') {
      this._events = Object.create(null);
    } else {
      delete this._events[event];
    }
    return this;
  }

  emit(event, ...args) {
    const listeners = this._events[event];
    if (!listeners || listeners.length === 0) {
      return false;
    }

    this._events[event] = listeners.filter((listener) => {
      listener.fn.apply(listener.context, args);
      return !listener.once;
    });

    if (this._events[event].length === 0) {
      delete this._events[event];
    }

    return true;
  }

  listeners(event) {
    return (this._events[event] || []).map((listener) => listener.fn);
  }
}

EventEmitter.EventEmitter = EventEmitter;
EventEmitter.default = EventEmitter;
EventEmitter.prefixed = false;

console.info('[SOLINK] EventEmitter shim loaded:', import.meta.url);

export default EventEmitter;
export { EventEmitter };
export const prefixed = false;