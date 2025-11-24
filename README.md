# SOLink – Secure Wallet-to-Wallet Messenger

SOLink is a privacy-focused messenger built around Solana wallets. Both the client and the Cloudflare Worker were rewritten to deliver a modern three-column UI and full end-to-end encryption.

## Highlights

- **Wallet-first UX.** Phantom (or any compatible Solana wallet) acts as the single identity layer. Workspace and local IndexedDB are tied to the connected wallet.
- **Durable Object queue.** Messages land in a Cloudflare Durable Object and are acknowledged through `/messages/ack`, guaranteeing “at least once” delivery.
- **End-to-end encryption.**
  - The client generates an X25519 key pair (TweetNaCl) and publishes the public key in the profile.
  - A shared secret (Diffie–Hellman) is derived and cached per contact in IndexedDB.
  - `send` encrypts the payload, the worker stores ciphertext only, and decryption happens solely on the client.
- **Modern frontend.** Dark theme, navigation → chat list → conversation + info panel layout, responsive styles.
- **IndexedDB workspaces.** Each wallet gets its own namespace (`solink-db-wallet-...`). Switching wallets resets the UI and loads the corresponding data.
- **Cloudflare KV + Worker.** Profiles, nicknames, public keys and rate limiting are handled server-side.

## Tech Stack

| Layer      | Technologies |
|-----------|--------------|
| Frontend  | HTML/CSS, Vanilla JS, TweetNaCl, IndexedDB |
| Backend   | Cloudflare Workers, KV, Durable Objects |
| Delivery  | Long-poll (`/inbox/poll?wait=15000`) + ACK (`/messages/ack`) |

## Quick Start

### UI Only
1. Clone or download the repository.
2. Open `public/app.html` in your browser.
3. Connect Phantom and start chatting (messages will still be proxied through the deployed worker).

### Backend Contributors (Optional)
If you want to run the Cloudflare Worker yourself:
1. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
2. Configure KV/Durable Object bindings in `wrangler.toml`.
3. `wrangler dev --local` to emulate the worker, `wrangler deploy` to ship it.

## Security Notes

- Phantom never exposes private keys; the app operates with signatures only.
- Encryption keys live in the browser’s IndexedDB; only public keys are uploaded.
- The worker stores ciphertext + metadata, plaintext is never logged or cached server-side.

## Repository Layout

```
public/        # frontend assets
worker/        # Cloudflare Worker + Durable Object
docs/          # design notes
wrangler.toml  # deployment config
```

## Roadmap

- [x] New UI/UX
- [x] Durable Object queue + ACK
- [x] Global @nicknames
- [x] End-to-end encryption
- [ ] Design polish & onboarding animation
- [ ] Native push notifications

---

To replicate locally: clone the repo, run `wrangler dev`, and open `public/app.html?v=dev`. All secrets are tied to Phantom/IndexedDB, so the repo is safe to keep public.

