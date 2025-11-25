import RpcWebSocketClient from './rpc-websocket-client.js';

export default function createRpc(url, options = {}, generateRequestId) {
  return new RpcWebSocketClient(url, options, generateRequestId);
}

