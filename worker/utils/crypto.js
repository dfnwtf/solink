const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map(BASE58_ALPHABET.split('').map((char, idx) => [char, idx]));

export function decodeBase58(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Base58 value must be a non-empty string');
  }

  const bytes = [];
  for (const char of value) {
    if (!BASE58_MAP.has(char)) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
  }

  let num = BigInt(0);
  const base = BigInt(58);
  for (const char of value) {
    num = num * base + BigInt(BASE58_MAP.get(char));
  }

  while (num > 0) {
    bytes.push(Number(num % BigInt(256)));
    num >>= BigInt(8);
  }

  // Handle leading zeros
  for (const char of value) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

export async function verifyEd25519Signature(message, signatureBase58, pubkeyBase58) {
  try {
    const signature = decodeBase58(signatureBase58);
    const publicKey = decodeBase58(pubkeyBase58);
    const key = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
    const encoder = new TextEncoder();
    return crypto.subtle.verify('Ed25519', key, signature, encoder.encode(message));
  } catch {
    return false;
  }
}

function toBase64Url(bytes) {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateToken(byteLength = 32) {
  const buffer = new Uint8Array(byteLength);
  crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}
