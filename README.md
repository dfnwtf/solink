# 🔐 SOLink — Secure Web3 Messenger on Solana

<p align="center">
  <img src="public/media/solink-12000x4000.png" alt="SOLink" width="900">
</p>

<p align="center">
  <strong>End-to-end encrypted wallet-to-wallet messaging with voice calls</strong><br>
  No registration. No phone number. Just your Phantom wallet.
</p>

<p align="center">
  <a href="https://solink.chat">🌐 Website</a> •
  <a href="https://solink.chat/app">💬 Open Messenger</a> •
  <a href="#security">🔒 Security</a>
</p>

---

## 🎉 What's New — Audio Calls!

> **We jumped ahead of our roadmap!** We're thrilled to announce that **real-time audio calls** are now live in SOLink. This is a huge milestone in the evolution of our messenger — bringing Web3 communication to a whole new level.

- ✅ **SSL Labs audit upgraded to A** - TLS configuration hardened and re-tested

### 📞 Call Features
- **1-on-1 Audio Calls** — Call any contact directly from chat
- **Cloudflare TURN** — Reliable connectivity through NAT/firewalls
- **WebRTC Powered** — Low-latency, high-quality audio with DTLS-SRTP encryption
- **Call UI** — Full-screen and minimized modes, mute toggle, call timer
- **Call History** — Incoming, outgoing, missed calls logged in chat
- **30s Ring Timeout** — Auto-disconnect if no answer
- **Responsive Design** — Works on desktop and mobile

---

## ✨ Features

- **🔑 Wallet-Native Identity** — Your Solana wallet is your identity. No signup, no passwords.
- **🔒 End-to-End Encryption** — Messages encrypted with NaCl (XSalsa20-Poly1305). Server never sees plaintext.
- **📞 Audio Calls** — Real-time voice calls powered by WebRTC and Cloudflare TURN.
- **☁️ Cloud Sync** — Automatic encrypted backup to cloud. Clear cache, switch devices — your data stays safe.
- **💸 Send SOL in Chat** — Transfer SOL directly in conversations.
- **🎤 Voice Messages** — Record and send encrypted voice messages with waveform visualization.
- **🔍 Token Scanner** — Instant security reports for any Solana token powered by DFN Patrol.
- **🔗 Token Link Preview** — Paste any token link and get instant security report card.
- **🔔 Push Notifications** — Get notified when you receive new messages.
- **📱 PWA Support** — Install as app on desktop and mobile.
- **💾 Encrypted Backups** — Export your data with AES-256 password protection.

---

## Security

SOLink takes security seriously. We've achieved top ratings across security audits:

| Service | Rating | Details |
|---------|--------|---------|
| **Security Headers** | A+ | CSP, HSTS, X-Frame-Options |
| **Mozilla Observatory** | A+ (125/100) | 10/10 tests passed |
| **SSL Labs** | A | TLS 1.2/1.3 |
| **ImmuniWeb** | A | HTTPS, CSP verified |

### Encryption Stack

```
┌─────────────────────────────────────────────────────────┐
│                      Your Browser                        │
├─────────────────────────────────────────────────────────┤
│  Phantom Wallet → Ed25519 signature for auth            │
│  TweetNaCl      → X25519 key exchange                   │
│  XSalsa20-Poly1305 → Message encryption                 │
│  WebRTC         → DTLS-SRTP for voice calls             │
│  IndexedDB      → Local cache (messages, contacts)      │
└─────────────────────────────────────────────────────────┘
                            │
                    (only ciphertext)
                            ▼
┌─────────────────────────────────────────────────────────┐
│               Cloudflare Workers                         │
├─────────────────────────────────────────────────────────┤
│  KV Storage     → Profiles, public keys, sessions       │
│  Durable Objects → Message queue + Call signaling       │
│  R2 Storage     → Encrypted backups & voice messages    │
│  TURN Server    → WebRTC relay for audio calls          │
│  No plaintext ever touches the server                   │
└─────────────────────────────────────────────────────────┘
```

### Security Features

- ✅ **CORS** restricted to `solink.chat`
- ✅ **CSP** prevents XSS attacks
- ✅ **HSTS** enforces HTTPS
- ✅ **No inline scripts** — all JS in external files
- ✅ **Encrypted backups** with AES-256-GCM
- ✅ **Cloud backups** encrypted with wallet-derived key
- ✅ **Rate limiting** — 60 messages/minute
- ✅ **Nonce-based auth** — replay attack protection

---

## 🏗️ Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Vanilla JS, TweetNaCl, IndexedDB, WebRTC, CSS3 |
| **Backend** | Cloudflare Workers, KV, Durable Objects, R2, TURN |
| **Encryption** | NaCl (X25519 + XSalsa20-Poly1305), DTLS-SRTP |
| **Blockchain** | Solana Web3.js, Phantom Wallet |
| **Voice Calls** | WebRTC, Cloudflare TURN, Durable Objects (signaling) |

---

## 📁 Project Structure

```
SOLink/
├── public/                     # Static frontend
│   ├── app/                    # Main app (UI shell)
│   │   ├── index.html          # App shell + import map
│   │   └── og-image.png        # Open Graph image
│   ├── dev/                    # Dev console (PWA)
│   │   ├── calls/              # WebRTC call test page
│   │   │   └── index.html
│   │   ├── index.html          # Dev console main
│   │   ├── manifest.json       # PWA manifest
│   │   └── sw.js               # Dev service worker
│   ├── css/
│   │   ├── style.css           # Main app styles
│   │   ├── dev.css             # Dev console styles
│   │   └── dev-calls.css       # Call test page styles
│   ├── js/
│   │   ├── api.js              # API client (fetch)
│   │   ├── chat.js             # Chat logic, inbox, rendering
│   │   ├── db.js               # IndexedDB helpers
│   │   ├── dev.js              # Dev console logic
│   │   ├── dev-calls.js        # WebRTC diagnostics/tests
│   │   ├── landing.js          # Landing page scripts
│   │   ├── main.js             # Auth + wallet bootstrap
│   │   ├── phantom-mobile.js   # Phantom Mobile support
│   │   ├── voice-recorder.js   # Voice message recording
│   │   ├── call/               # Audio call module (WebRTC)
│   │   │   ├── call-manager.js     # Call orchestration (UI + signaling)
│   │   │   ├── call-signaling.js   # WebSocket signaling client
│   │   │   ├── call-ui.js          # Call UI components
│   │   │   └── webrtc-client.js     # PeerConnection, ICE, media
│   │   └── vendor/             # Local vendored deps
│   │       ├── eventemitter3-wrapper.js
│   │       ├── jayson-browser.js
│   │       ├── rpc-websocket-client.js
│   │       └── rpc-websocket-factory.js
│   ├── media/                  # Assets (audio/icons)
│   │   ├── caller.mp3          # Outgoing dial tone
│   │   ├── incoming.mp3        # Incoming ringtone
│   │   ├── inbox.mp3           # Legacy message ping
│   │   └── *.svg/png           # Logos, partners
│   ├── icons/                  # PWA icons
│   ├── presentation/           # Presentation materials
│   │   ├── background-presentation.mp3
│   │   └── index.html
│   ├── manifest.json           # App PWA manifest
│   ├── sw.js                   # Main service worker
│   ├── _redirects              # Pages redirects
│   ├── favicon.* / og-image.*  # Favicons & OG images
│   ├── robots.txt / sitemap.xml
│   ├── index.html              # Landing page
│   └── help/, privacy/, terms/, disclaimer/ # Static pages
├── worker/                     # Cloudflare Worker + Durable Objects
│   ├── worker.js               # Main worker: API routing
│   ├── inbox-do.js             # Inbox/message queue DO
│   ├── call-do.js              # Call signaling DO
│   └── utils/
│       ├── crypto.js           # Crypto helpers
│       ├── nonce.js            # Nonce management
│       ├── ratelimit.js        # Rate limiting
│       └── logger.js           # Dev console logging
```

---

## 🚀 Quick Start

### Use Live Version
1. Go to [solink.chat](https://solink.chat)
2. Click "Open Messenger"
3. Connect your Phantom wallet
4. Start chatting!

### Run Locally
```bash
# Clone repository
git clone https://github.com/dfnwtf/solink.git
cd solink

# Install Wrangler CLI
npm install -g wrangler

# Configure wrangler.toml with your credentials
# (copy from wrangler.toml.example)

# Run locally
wrangler dev

# Open http://localhost:8787/app
```

---

## 🔐 How Encryption Works

1. **Key Generation**: On first launch, client generates X25519 keypair
2. **Key Exchange**: Public keys stored on server, shared secret computed via Diffie-Hellman
3. **Message Encryption**: Each message encrypted with unique nonce using XSalsa20-Poly1305
4. **Server Role**: Only sees ciphertext, never plaintext

```javascript
// Simplified encryption flow
const sharedSecret = nacl.box.before(recipientPublicKey, mySecretKey);
const nonce = nacl.randomBytes(24);
const ciphertext = nacl.box.after(messageBytes, nonce, sharedSecret);
// Only ciphertext + nonce sent to server
```

---

## 🖥️ Developer Console

SOLink includes a built-in developer console for monitoring and debugging.

### Features

| Feature | Description |
|---------|-------------|
| **📊 Real-time Dashboard** | Live stats: requests, errors, latency, unique wallets |
| **📈 Charts** | Requests over time, category distribution, status breakdown |
| **🔍 Event Logs** | Filterable table with all API events |
| **❤️ Health Check** | Test all systems: KV, R2, Durable Objects, Solana RPC |
| **🔎 Search** | Find events by ID, action, wallet, or details |
| **📱 PWA** | Install as standalone app |
| **🔄 Auto-refresh** | Updates every 10 seconds |

### Event Categories

- `auth` — Login, nonce, verify
- `message` — Send, poll, ack
- `voice` — Upload, download voice messages
- `push` — Push notification subscriptions
- `sync` — Cloud backup operations
- `profile` — Nickname updates
- `solana` — RPC proxy requests
- `system` — Health checks, dev login

### Scheduled Health Checks

Automatic health check runs every 5 minutes via Cloudflare Cron Trigger, monitoring:
- KV Storage
- R2 Storage
- Durable Objects
- Solana RPC

---

## 📋 Roadmap

- [x] End-to-end encryption
- [x] Durable Object message queue
- [x] Global @nicknames
- [x] Send SOL in chat
- [x] Security hardening (A+ rating)
- [x] Encrypted backups (local export)
- [x] Cloud sync (R2 encrypted backup)
- [x] SEO & sitemap
- [x] Token Scanner (DFN Patrol integration)
- [x] Message reactions
- [x] Push notifications
- [x] Mobile swipe gestures (reply/delete)
- [x] Voice messages with waveform visualization
- [x] Developer console with analytics
- [x] **🎉 Audio Calls** (WebRTC + Cloudflare TURN) — *Ahead of schedule!*
- [ ] Multi-wallet support (Solflare, Backpack)
- [ ] Group chats
- [ ] Video calls
- [ ] Image sharing

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built with 💜 on Solana
</p>
