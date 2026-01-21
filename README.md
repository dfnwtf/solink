# 🔐 SOLink — Secure Web3 Messenger on Solana

<p align="center">
  <img src="public/media/branding/solink-banner-1500x500-v2.svg" alt="SOLink" width="900">
</p>

<p align="center">
  <strong>End-to-end encrypted wallet-to-wallet messaging</strong><br>
  No registration. No phone number. Just your Phantom wallet.
</p>

<p align="center">
  <a href="https://solink.chat">🌐 Live Demo</a> •
  <a href="https://solink.chat/app">💬 Open Messenger</a> •
  <a href="#security">🔒 Security</a>
</p>

---

## ✨ Features

- **🔑 Wallet-Native Identity** — Your Solana wallet is your identity. No signup, no passwords.
- **🔒 End-to-End Encryption** — Messages encrypted with NaCl (XSalsa20-Poly1305). Server never sees plaintext.
- **💸 Send SOL in Chat** — Transfer SOL directly in conversations.
- **🔍 Token Scanner** — Instant security reports for any Solana token powered by DFN Patrol.
- **🔗 Token Link Preview** — Paste any token link and get instant security report card.
- **📱 PWA Support** — Install as app on desktop.
- **💾 Encrypted Backups** — Export your data with AES-256 password protection.

---

## Security

SOLink takes security seriously. We've achieved top ratings across security audits:

| Service | Rating | Details |
|---------|--------|---------|
| **Security Headers** | A+ | CSP, HSTS, X-Frame-Options |
| **Mozilla Observatory** | A+ (125/100) | 10/10 tests passed |
| **SSL Labs** | B | TLS 1.2/1.3 |
| **ImmuniWeb** | A | HTTPS, CSP verified |

### Encryption Stack

```
┌─────────────────────────────────────────────────────────┐
│                      Your Browser                        │
├─────────────────────────────────────────────────────────┤
│  Phantom Wallet → Ed25519 signature for auth            │
│  TweetNaCl      → X25519 key exchange                   │
│  XSalsa20-Poly1305 → Message encryption                 │
│  IndexedDB      → Local encrypted storage               │
└─────────────────────────────────────────────────────────┘
                            │
                    (only ciphertext)
                            ▼
┌─────────────────────────────────────────────────────────┐
│               Cloudflare Workers                         │
├─────────────────────────────────────────────────────────┤
│  KV Storage     → Profiles, public keys                 │
│  Durable Objects → Message queue (encrypted)            │
│  No plaintext ever touches the server                   │
└─────────────────────────────────────────────────────────┘
```

### Security Features

- ✅ **CORS** restricted to `solink.chat`
- ✅ **CSP** prevents XSS attacks
- ✅ **HSTS** enforces HTTPS
- ✅ **No inline scripts** — all JS in external files
- ✅ **Encrypted backups** with AES-256-GCM
- ✅ **Rate limiting** — 60 messages/minute
- ✅ **Nonce-based auth** — replay attack protection

---

## 🏗️ Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Vanilla JS, TweetNaCl, IndexedDB, CSS3 |
| **Backend** | Cloudflare Workers, KV, Durable Objects |
| **Encryption** | NaCl (X25519 + XSalsa20-Poly1305) |
| **Blockchain** | Solana Web3.js, Phantom Wallet |

---

## 📁 Project Structure

```
SOLink/
├── public/
│   ├── app/           # Main messenger app
│   ├── css/           # Stylesheets
│   ├── js/            # Frontend JavaScript
│   │   ├── chat.js    # Main chat logic
│   │   ├── api.js     # API client
│   │   ├── db.js      # IndexedDB operations
│   │   └── main.js    # Auth & wallet connection
│   ├── icons/         # App icons for notifications
│   ├── sw.js          # Service Worker
│   └── index.html     # Landing page
└── worker/
    ├── worker.js      # Cloudflare Worker
    ├── inbox-do.js    # Durable Object queue
    └── utils/         # Crypto, nonce, rate limiting
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

## 📋 Roadmap

- [x] End-to-end encryption
- [x] Durable Object message queue
- [x] Global @nicknames
- [x] Send SOL in chat
- [x] Security hardening (A+ rating)
- [x] Encrypted backups
- [x] SEO & sitemap
- [x] Token Scanner (DFN Patrol integration)
- [x] Message reactions
- [x] Push notifications
- [x] Mobile swipe gestures (reply/delete)
- [ ] Group chats
- [ ] Voice calls
- [ ] File sharing

---

## 🤝 Contributing

Contributions welcome! Please read our security guidelines before submitting PRs.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built with 💜 on Solana
</p>
