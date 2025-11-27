# SOLink – Secure Wallet-to-Wallet Messenger

SOLink is a privacy-first messenger built around Solana wallets. The UI, queueing layer, and encryption pipeline are engineered so that only wallet owners can read their conversations—no centralized server ever sees plaintext.

## Highlights

- **Wallet-native UX.** Phantom (or any Solana wallet) doubles as identity and authentication. Internal IndexedDB namespaces (`solink-db-wallet-...`) isolate conversations per wallet.
- **Durable Object queue.** Every outgoing message lands in a Cloudflare DO, waits for `/messages/ack`, and is removed atomically. Even if a reader reloads mid-session, the queue replays undeciphered ciphertext until it’s acknowledged.
- **End-to-end encryption.**
  - Clients generate X25519 pairs (TweetNaCl) and publish only the public key.
  - For each contact we compute a shared secret (Diffie–Hellman) and cache it in IndexedDB.
  - Payloads are encrypted with XSalsa20-Poly1305 before they ever touch the worker. Decryption happens purely in the browser.
- **Modern frontend.** Dark three-column layout (nav → chats → conversation & info panel), responsive CSS, and stateful search/favorites.
- **Cloudflare Worker + KV.** Profiles, nicknames, encryption keys, and rate limits live in KV; the worker simply brokers ciphertext between wallets.

## Tech Stack

| Layer      | Technologies |
|-----------|--------------|
| Frontend  | HTML/CSS, Vanilla JS, TweetNaCl, IndexedDB |
| Backend   | Cloudflare Workers, KV, Durable Objects |
| Delivery  | Long-poll (`/inbox/poll?wait=15000`) + ACK (`/messages/ack`) |

## Quick Start

1. Clone or download the repository.
2. Open `public/app.html` in your browser.
3. Connect Phantom — encryption keys are generated on the fly and messages are routed through the secure queue automatically.

## Security Notes

- Phantom never exposes private keys; the dApp requests only signatures.
- Encryption keys are generated client-side and stored in IndexedDB (`solink-db-wallet-*`).
- Only public keys are uploaded. Worker receives ciphertext + nonce + metadata.
- Durable Object acts as a sealed queue: messages persist until `/messages/ack` confirms delivery.
- Long-poll prevents replay attacks: each poll clears the queue atomically, so ciphertext can’t reappear once acked.

```js
// simplified send flow (client-side)
const secret = await ensureSessionSecret(contactPubkey);
const encrypted = secret && encryptWithSecret(secret, plaintext);
await sendMessage({
  to: contactPubkey,
  text: encrypted ? encrypted.ciphertext : plaintext,
  nonce: encrypted?.nonce,
  version: encrypted?.version,
  timestamp: Date.now(),
});
```

```js
// worker/worker.js (store snippet)
const message = {
  id: crypto.randomUUID(),
  from: senderPubkey,
  to: recipientPubkey,
  text: sanitizedText,          // optional fallback
  ciphertext: sanitizedCiphertext,
  nonce: sanitizedNonce,
  encryptionVersion,
  timestamp: Date.now(),
};
await inboxStore(env, recipientPubkey, message);
```

## Repository Layout

| Path   | Description                              |
|--------|------------------------------------------|
| `public/` | Frontend assets (HTML/CSS/JS, UI)         |
| `worker/` | Cloudflare Worker & Durable Object queue |
| `docs/`   | Design notes & UX drafts                 |
| `wrangler.toml` | Deployment config (bindings, routes)    |

## Roadmap

- [x] New UI/UX
- [x] Durable Object queue + ACK
- [x] Global @nicknames
- [x] End-to-end encryption
- [ ] Design polish & onboarding animation
- [ ] Native push notifications

---

To replicate locally: clone the repo, run `wrangler dev`, and open `public/app.html?v=dev`. All secrets are tied to Phantom/IndexedDB, so the repo is safe to keep public.

