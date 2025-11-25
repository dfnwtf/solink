export default function createRpc(address, options = {}) {
  const protocols = options?.protocols;
  const socket = new WebSocket(address, protocols);
  console.info('[SOLINK] RPC WebSocket factory created socket:', address);
  return socket;
}
