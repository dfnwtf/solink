import { v4 as uuidv4 } from 'https://cdn.jsdelivr.net/npm/uuid@8.3.2/dist/esm-browser/index.js';

function generateRequest(method, params, id, options = {}) {
  if (typeof method !== 'string') {
    throw new TypeError(`${method} must be a string`);
  }

  const version = typeof options.version === 'number' ? options.version : 2;
  if (version !== 1 && version !== 2) {
    throw new TypeError(`${version} must be 1 or 2`);
  }

  const request = { method };
  if (version === 2) {
    request.jsonrpc = '2.0';
  }

  if (params) {
    const isValidParams = typeof params === 'object' || Array.isArray(params);
    if (!isValidParams) {
      throw new TypeError(`${params} must be an object, array or omitted`);
    }
    request.params = params;
  }

  if (typeof id === 'undefined') {
    const generator =
      typeof options.generator === 'function' ? options.generator : () => uuidv4();
    request.id = generator(request, options);
  } else if (version === 2 && id === null) {
    if (options.notificationIdNull) {
      request.id = null;
    }
  } else {
    request.id = id;
  }

  return request;
}

class ClientBrowser {
  constructor(callServer, options = {}) {
    this.options = {
      reviver: typeof options.reviver !== 'undefined' ? options.reviver : null,
      replacer: typeof options.replacer !== 'undefined' ? options.replacer : null,
      generator:
        typeof options.generator !== 'undefined' ? options.generator : () => uuidv4(),
      version: typeof options.version !== 'undefined' ? options.version : 2,
      notificationIdNull:
        typeof options.notificationIdNull === 'boolean'
          ? options.notificationIdNull
          : false,
    };

    this.callServer = callServer;
  }

  request(method, params, id, callback) {
    let cb = callback;
    let requestPayload = null;

    const isBatch = Array.isArray(method) && typeof params === 'function';
    if (this.options.version === 1 && isBatch) {
      throw new TypeError('JSON-RPC 1.0 does not support batching');
    }

    const isRaw =
      !isBatch && method && typeof method === 'object' && typeof params === 'function';

    if (isBatch || isRaw) {
      cb = params;
      requestPayload = method;
    } else {
      if (typeof id === 'function') {
        cb = id;
        id = undefined;
      }

      const hasCallback = typeof cb === 'function';

      try {
        requestPayload = generateRequest(method, params, id, {
          generator: this.options.generator,
          version: this.options.version,
          notificationIdNull: this.options.notificationIdNull,
        });
      } catch (err) {
        if (hasCallback) {
          cb(err);
          return undefined;
        }
        throw err;
      }

      if (!hasCallback) {
        return requestPayload;
      }
    }

    let message;
    try {
      message = JSON.stringify(requestPayload, this.options.replacer);
    } catch (err) {
      return cb(err);
    }

    this.callServer(message, (err, response) => {
      this._parseResponse(err, response, cb);
    });

    return requestPayload;
  }

  _parseResponse(err, responseText, callback) {
    if (err) {
      callback(err);
      return;
    }

    if (!responseText) {
      callback();
      return;
    }

    let response;
    try {
      response = JSON.parse(responseText, this.options.reviver);
    } catch (parseErr) {
      callback(parseErr);
      return;
    }

    if (callback.length === 3) {
      if (Array.isArray(response)) {
        const isError = (res) => typeof res.error !== 'undefined';
        return callback(null, response.filter(isError), response.filter((res) => !isError(res)));
      }
      return callback(null, response.error, response.result);
    }

    callback(null, response);
  }
}

export default ClientBrowser;

