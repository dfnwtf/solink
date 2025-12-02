# 📚 Документация API SOLink

Комплексная документация всех публичных API, функций и компонентов SOLink — безопасного мессенджера на Solana.

---

## 📋 Содержание

1. [Backend API (Cloudflare Workers)](#backend-api-cloudflare-workers)
2. [Frontend API (Клиентские функции)](#frontend-api-клиентские-функции)
3. [Утилиты (Backend)](#утилиты-backend)
4. [База данных (IndexedDB)](#база-данных-indexeddb)
5. [Аутентификация и сессии](#аутентификация-и-сессии)
6. [Шифрование](#шифрование)
7. [Push-уведомления](#push-уведомления)
8. [Синхронизация и резервное копирование](#синхронизация-и-резервное-копирование)

---

## Backend API (Cloudflare Workers)

### Базовый URL
```
/api
```

Все запросы требуют заголовок `Authorization: Bearer <token>` (кроме `/api/auth/nonce`).

---

### 🔐 Аутентификация

#### `GET /api/auth/nonce`
Получить одноразовый nonce для подписи сообщения.

**Параметры запроса:**
- `pubkey` (string, обязательный) — публичный ключ Solana в формате Base58

**Пример:**
```javascript
const response = await fetch('/api/auth/nonce?pubkey=YOUR_PUBKEY');
const { nonce, expiresAt } = await response.json();
```

**Ответ:**
```json
{
  "nonce": "random-token-here",
  "expiresAt": 1234567890
}
```

**Ошибки:**
- `400` — отсутствует pubkey
- `500` — внутренняя ошибка сервера

---

#### `POST /api/auth/verify`
Проверить подпись и создать сессию.

**Тело запроса:**
```json
{
  "pubkey": "YOUR_PUBKEY",
  "nonce": "nonce-from-previous-request",
  "signature": "base58-encoded-signature",
  "sessionTtl": 3600
}
```

**Параметры:**
- `pubkey` (string, обязательный) — публичный ключ
- `nonce` (string, обязательный) — nonce из предыдущего запроса
- `signature` (string, обязательный) — Ed25519 подпись nonce в Base58
- `sessionTtl` (number, опциональный) — время жизни сессии в секундах (15 мин - 12 часов, по умолчанию 3600)

**Пример:**
```javascript
const response = await fetch('/api/auth/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pubkey: 'YOUR_PUBKEY',
    nonce: 'nonce-value',
    signature: 'signature-base58',
    sessionTtl: 7200 // 2 часа
  })
});
const { token, user } = await response.json();
```

**Ответ:**
```json
{
  "token": "session-token-here",
  "user": {
    "pubkey": "YOUR_PUBKEY"
  }
}
```

**Ошибки:**
- `400` — отсутствуют обязательные поля
- `401` — неверный или истекший nonce, неверная подпись

---

### 💬 Сообщения

#### `POST /api/messages/send`
Отправить сообщение получателю.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Тело запроса:**
```json
{
  "to": "recipient-pubkey",
  "text": "plaintext message (optional if encrypted)",
  "ciphertext": "encrypted-message-base64",
  "nonce": "encryption-nonce-base64",
  "version": 1,
  "timestamp": 1234567890,
  "tokenPreview": {
    "address": "token-address",
    "name": "Token Name",
    "symbol": "TKN"
  },
  "senderEncryptionKey": "sender-public-key-base64"
}
```

**Параметры:**
- `to` (string, обязательный) — публичный ключ получателя
- `text` (string, опциональный) — открытый текст (если сообщение не зашифровано)
- `ciphertext` (string, опциональный) — зашифрованное сообщение в Base64
- `nonce` (string, опциональный) — nonce для расшифровки (обязателен при ciphertext)
- `version` (number, опциональный) — версия шифрования (по умолчанию 1)
- `timestamp` (number, опциональный) — временная метка (по умолчанию текущее время)
- `tokenPreview` (object, опциональный) — превью токена
- `senderEncryptionKey` (string, опциональный) — публичный ключ шифрования отправителя

**Пример:**
```javascript
const response = await fetch('/api/messages/send', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    to: 'RECIPIENT_PUBKEY',
    text: 'Hello!',
    timestamp: Date.now()
  })
});
const { ok, messageId } = await response.json();
```

**Ответ:**
```json
{
  "ok": true,
  "messageId": "uuid-here"
}
```

**Ошибки:**
- `400` — отсутствуют обязательные поля, неверный получатель
- `401` — неавторизован
- `429` — превышен лимит запросов (60 сообщений/минуту)
- `500` — ошибка сохранения сообщения

**Ограничения:**
- Максимальная длина текста: 1024 символа
- Нельзя отправлять сообщения самому себе
- Rate limit: 60 сообщений в минуту

---

#### `GET /api/inbox/poll`
Получить новые сообщения из почтового ящика.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Параметры запроса:**
- `wait` (number, опциональный) — время ожидания в миллисекундах (максимум 15000)

**Пример:**
```javascript
const response = await fetch('/api/inbox/poll?wait=5000', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const { messages } = await response.json();
```

**Ответ:**
```json
{
  "messages": [
    {
      "id": "message-id",
      "from": "sender-pubkey",
      "to": "recipient-pubkey",
      "text": "message text",
      "ciphertext": "encrypted-data",
      "nonce": "encryption-nonce",
      "encryptionVersion": 1,
      "timestamp": 1234567890,
      "senderNickname": "@nickname",
      "senderDisplayName": "@nickname",
      "senderEncryptionKey": "public-key",
      "tokenPreview": { ... },
      "expiresAt": 1234567890
    }
  ]
}
```

**Особенности:**
- Если указан параметр `wait`, сервер будет ждать до появления новых сообщений (long polling)
- Максимальное время ожидания: 15 секунд
- Возвращается максимум 100 сообщений за запрос

---

#### `POST /api/messages/ack`
Подтвердить получение сообщений (удалить их из очереди).

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Тело запроса:**
```json
{
  "ids": ["message-id-1", "message-id-2"]
}
```

**Пример:**
```javascript
const response = await fetch('/api/messages/ack', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    ids: ['msg-1', 'msg-2']
  })
});
```

**Ответ:**
```json
{
  "ok": true
}
```

---

### 👤 Профили

#### `GET /api/profile/me`
Получить свой профиль.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Пример:**
```javascript
const response = await fetch('/api/profile/me', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const { profile } = await response.json();
```

**Ответ:**
```json
{
  "profile": {
    "pubkey": "your-pubkey",
    "nickname": "yournickname",
    "displayName": "@yournickname",
    "avatarSeed": "seed-string",
    "encryptionPublicKey": "public-key-base64",
    "nicknameChangedAt": 1234567890,
    "createdAt": 1234567890,
    "updatedAt": 1234567890
  }
}
```

---

#### `POST /api/profile/nickname`
Обновить никнейм.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Тело запроса:**
```json
{
  "nickname": "newnickname"
}
```

**Правила никнейма:**
- Длина: 3-16 символов
- Формат: начинается с буквы, затем буквы, цифры и подчеркивания
- Регистр: автоматически преобразуется в нижний
- Запрещенные слова: admin, solink, solana и другие (см. блоклист)
- Можно менять не чаще 1 раза в 7 дней

**Пример:**
```javascript
const response = await fetch('/api/profile/nickname', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ nickname: 'mynickname' })
});
```

**Ответ:**
```json
{
  "profile": {
    "pubkey": "your-pubkey",
    "nickname": "mynickname",
    "displayName": "@mynickname",
    ...
  }
}
```

**Ошибки:**
- `400` — неверный формат никнейма
- `409` — никнейм уже занят
- `429` — слишком рано для смены никнейма (менее 7 дней)

---

#### `POST /api/profile/encryption-key`
Обновить публичный ключ шифрования.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Тело запроса:**
```json
{
  "publicKey": "base64-encoded-public-key"
}
```

**Пример:**
```javascript
const response = await fetch('/api/profile/encryption-key', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ publicKey: 'base64-key-here' })
});
```

---

#### `GET /api/profile/lookup`
Найти профиль по никнейму.

**Параметры запроса:**
- `nickname` или `nick` (string, обязательный) — никнейм для поиска

**Пример:**
```javascript
const response = await fetch('/api/profile/lookup?nickname=username');
const { profile } = await response.json();
```

**Ответ:**
```json
{
  "profile": {
    "pubkey": "found-pubkey",
    "nickname": "username",
    "displayName": "@username",
    ...
  }
}
```

**Ошибки:**
- `400` — неверный формат никнейма
- `404` — профиль не найден

---

#### `GET /api/profile/by-key`
Получить профиль по публичному ключу.

**Параметры запроса:**
- `pubkey` или `pk` (string, обязательный) — публичный ключ в Base58

**Пример:**
```javascript
const response = await fetch('/api/profile/by-key?pubkey=YOUR_PUBKEY');
const { profile } = await response.json();
```

**Ошибки:**
- `400` — неверный формат публичного ключа
- `404` — профиль не найден

---

### 🔗 Превью контента

#### `GET /api/token/preview`
Получить превью токена Solana.

**Параметры запроса:**
- `address` (string, обязательный) — адрес токена в Base58

**Пример:**
```javascript
const response = await fetch('/api/token/preview?address=TOKEN_ADDRESS');
const { preview } = await response.json();
```

**Ответ:**
```json
{
  "preview": {
    "address": "token-address",
    "name": "Token Name",
    "symbol": "TKN",
    "imageUrl": "https://...",
    "description": "Token description",
    "priceUsd": 0.001,
    "priceChange24h": 5.5,
    "priceChange1h": 1.2,
    "priceChange5m": 0.3,
    "marketCap": 1000000,
    "liquidity": 500000,
    "volume24h": 100000,
    "volume1h": 5000,
    "txns24h": 150,
    "buys24h": 100,
    "sells24h": 50,
    "dexId": "raydium",
    "pairAddress": "pair-address",
    "bondingProgress": 0.75,
    "isComplete": false,
    "socials": [
      { "type": "twitter", "url": "https://x.com/..." },
      { "type": "telegram", "url": "https://t.me/..." }
    ],
    "createdAt": 1234567890,
    "fetchedAt": 1234567890
  }
}
```

**Источники данных:**
- Pump.fun API
- DexScreener API
- Helius Metadata API (если доступен API ключ)

---

#### `GET /api/dex/preview`
Получить превью DEX пары по адресу пары.

**Параметры запроса:**
- `pair` (string, обязательный) — адрес пары

**Пример:**
```javascript
const response = await fetch('/api/dex/preview?pair=PAIR_ADDRESS');
const { preview } = await response.json();
```

---

#### `GET /api/link-preview`
Получить превью ссылки (Open Graph метаданные).

**Параметры запроса:**
- `url` (string, обязательный) — URL для превью

**Пример:**
```javascript
const response = await fetch('/api/link-preview?url=https://example.com');
const preview = await response.json();
```

**Ответ:**
```json
{
  "url": "https://example.com",
  "title": "Page Title",
  "description": "Page description",
  "image": "https://example.com/image.png",
  "siteName": "Example Site",
  "favicon": "https://example.com/favicon.ico"
}
```

**Ограничения:**
- Таймаут: 5 секунд
- Размер ответа: первые 100KB HTML
- Запрещены внутренние URL (localhost, 127.0.0.1, etc.)

---

#### `GET /api/image-proxy`
Прокси для изображений (обход CORS).

**Параметры запроса:**
- `url` (string, обязательный) — URL изображения

**Разрешенные домены:**
- `cdn.dexscreener.com`
- `pump.mypinata.cloud`
- `ipfs.io`
- `arweave.net`
- `cf-ipfs.com`
- `nftstorage.link`
- `gateway.pinata.cloud`

**Пример:**
```javascript
const imageUrl = `/api/image-proxy?url=${encodeURIComponent('https://cdn.dexscreener.com/image.png')}`;
```

---

### 🌐 Solana RPC Proxy

#### `POST /api/solana`
Прокси для запросов к Solana RPC.

**Тело запроса:**
Стандартный JSON-RPC запрос Solana.

**Пример:**
```javascript
const response = await fetch('/api/solana', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getBalance',
    params: ['YOUR_PUBKEY']
  })
});
```

**Особенности:**
- Автоматический failover между несколькими RPC endpoints
- Поддержка WebSocket upgrade для подписок

---

### 🔔 Push-уведомления

#### `POST /api/push/subscribe`
Подписаться на push-уведомления.

**Тело запроса:**
```json
{
  "pubkey": "your-pubkey",
  "subscription": {
    "endpoint": "https://...",
    "keys": {
      "p256dh": "key-here",
      "auth": "auth-here"
    }
  }
}
```

**Пример:**
```javascript
const registration = await navigator.serviceWorker.ready;
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: VAPID_PUBLIC_KEY
});

await fetch('/api/push/subscribe', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    pubkey: 'YOUR_PUBKEY',
    subscription: subscription.toJSON()
  })
});
```

**Ограничения:**
- Максимум 5 подписок на пользователя (5 устройств)
- Подписки автоматически истекают через 30 дней

---

#### `POST /api/push/unsubscribe`
Отписаться от push-уведомлений.

**Тело запроса:**
```json
{
  "pubkey": "your-pubkey",
  "endpoint": "subscription-endpoint" // опционально, если не указан - удаляются все
}
```

---

### ☁️ Синхронизация (R2 Storage)

#### `PUT /api/sync/chat/:contactKey`
Сохранить зашифрованную историю чата в облако.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Тело запроса:**
```json
{
  "encrypted": "base64-encrypted-chat-data"
}
```

**Пример:**
```javascript
await fetch(`/api/sync/chat/${contactKey}`, {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ encrypted: encryptedData })
});
```

---

#### `GET /api/sync/chat/:contactKey`
Загрузить зашифрованную историю чата из облака.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Ответ:**
```json
{
  "found": true,
  "encrypted": "base64-encrypted-data",
  "updatedAt": 1234567890,
  "version": "1"
}
```

или

```json
{
  "found": false
}
```

---

#### `DELETE /api/sync/chat/:contactKey`
Удалить историю чата из облака.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

---

#### `GET /api/sync/chats`
Получить список всех синхронизированных чатов.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Ответ:**
```json
{
  "chats": [
    {
      "contactKey": "pubkey-here",
      "updatedAt": 1234567890,
      "size": 1024
    }
  ]
}
```

---

#### `PUT /api/sync/backup`
Сохранить полный зашифрованный бэкап в облако.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Тело запроса:**
```json
{
  "encrypted": "base64-encrypted-backup"
}
```

**Ограничения:**
- Максимальный размер: 50MB

**Ответ:**
```json
{
  "success": true,
  "size": 1024
}
```

---

#### `GET /api/sync/backup`
Загрузить полный бэкап из облака.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

**Ответ:**
```json
{
  "found": true,
  "encrypted": "base64-data",
  "updatedAt": 1234567890,
  "size": 1024
}
```

---

#### `DELETE /api/sync/backup`
Удалить бэкап из облака.

**Заголовки:**
- `Authorization: Bearer <token>` (обязательный)

---

## Frontend API (Клиентские функции)

### Модуль: `api.js`

#### `fetchNonce(pubkey)`
Получить nonce для аутентификации.

**Параметры:**
- `pubkey` (string, обязательный) — публичный ключ

**Пример:**
```javascript
import { fetchNonce } from './api.js';
const { nonce } = await fetchNonce('YOUR_PUBKEY');
```

---

#### `verifySignature({ pubkey, nonce, signature })`
Проверить подпись и создать сессию.

**Параметры:**
- `pubkey` (string) — публичный ключ
- `nonce` (string) — nonce из `fetchNonce`
- `signature` (string) — подпись в Base58

**Пример:**
```javascript
import { verifySignature } from './api.js';
const result = await verifySignature({
  pubkey: 'YOUR_PUBKEY',
  nonce: 'nonce-value',
  signature: 'signature-base58'
});
// Сессия автоматически сохраняется
```

---

#### `sendMessage({ to, text, ciphertext, nonce, version, timestamp, tokenPreview, senderEncryptionKey })`
Отправить сообщение.

**Параметры:**
- `to` (string, обязательный) — публичный ключ получателя
- `text` (string, опциональный) — открытый текст
- `ciphertext` (string, опциональный) — зашифрованное сообщение
- `nonce` (string, опциональный) — nonce для расшифровки
- `version` (number, опциональный) — версия шифрования
- `timestamp` (number, опциональный) — временная метка
- `tokenPreview` (object, опциональный) — превью токена
- `senderEncryptionKey` (string, опциональный) — публичный ключ отправителя

**Пример:**
```javascript
import { sendMessage } from './api.js';
await sendMessage({
  to: 'RECIPIENT_PUBKEY',
  text: 'Hello!',
  timestamp: Date.now()
});
```

---

#### `pollInbox({ waitMs, signal })`
Получить новые сообщения (long polling).

**Параметры:**
- `waitMs` (number, опциональный) — время ожидания в миллисекундах
- `signal` (AbortSignal, опциональный) — сигнал для отмены запроса

**Пример:**
```javascript
import { pollInbox } from './api.js';
const messages = await pollInbox({ waitMs: 5000 });

// С отменой запроса
const controller = new AbortController();
setTimeout(() => controller.abort(), 10000);
const messages = await pollInbox({ waitMs: 15000, signal: controller.signal });
```

---

#### `ackMessages(ids)`
Подтвердить получение сообщений.

**Параметры:**
- `ids` (string[]) — массив ID сообщений

**Пример:**
```javascript
import { ackMessages } from './api.js';
await ackMessages(['msg-1', 'msg-2']);
```

---

#### `lookupProfile(nickname)`
Найти профиль по никнейму.

**Параметры:**
- `nickname` (string) — никнейм (с или без @)

**Пример:**
```javascript
import { lookupProfile } from './api.js';
const { profile } = await lookupProfile('@username');
```

---

#### `fetchProfileMe()`
Получить свой профиль.

**Пример:**
```javascript
import { fetchProfileMe } from './api.js';
const { profile } = await fetchProfileMe();
```

---

#### `fetchProfileByPubkey(pubkey)`
Получить профиль по публичному ключу.

**Параметры:**
- `pubkey` (string) — публичный ключ

---

#### `updateNicknameRequest(nickname)`
Обновить никнейм.

**Параметры:**
- `nickname` (string) — новый никнейм

**Пример:**
```javascript
import { updateNicknameRequest } from './api.js';
const { profile } = await updateNicknameRequest('newnickname');
```

---

#### `updateEncryptionKey(publicKey)`
Обновить публичный ключ шифрования.

**Параметры:**
- `publicKey` (string) — публичный ключ в Base64

---

#### `fetchTokenPreview(tokenAddress)`
Получить превью токена.

**Параметры:**
- `tokenAddress` (string) — адрес токена

**Пример:**
```javascript
import { fetchTokenPreview } from './api.js';
const { preview } = await fetchTokenPreview('TOKEN_ADDRESS');
```

---

#### `fetchDexPairPreview(pairAddress)`
Получить превью DEX пары.

**Параметры:**
- `pairAddress` (string) — адрес пары

---

#### `fetchLinkPreviewApi(url)`
Получить превью ссылки.

**Параметры:**
- `url` (string) — URL

---

#### `syncChatToCloud(contactKey, encryptedData)`
Синхронизировать чат в облако.

**Параметры:**
- `contactKey` (string) — публичный ключ контакта
- `encryptedData` (string) — зашифрованные данные в Base64

---

#### `loadChatFromCloud(contactKey)`
Загрузить чат из облака.

**Параметры:**
- `contactKey` (string) — публичный ключ контакта

**Возвращает:**
```javascript
{
  found: boolean,
  encrypted?: string,
  updatedAt?: number,
  version?: string
}
```

---

#### `deleteChatFromCloud(contactKey)`
Удалить чат из облака.

---

#### `loadChatListFromCloud()`
Получить список всех синхронизированных чатов.

**Возвращает:**
```javascript
{
  chats: Array<{
    contactKey: string,
    updatedAt: number,
    size: number
  }>
}
```

---

#### `saveBackupToCloud(encryptedData)`
Сохранить полный бэкап в облако.

**Параметры:**
- `encryptedData` (string) — зашифрованные данные в Base64

---

#### `loadBackupFromCloud()`
Загрузить полный бэкап из облака.

**Возвращает:**
```javascript
{
  found: boolean,
  encrypted?: string,
  updatedAt?: number,
  size?: number
}
```

---

#### `deleteBackupFromCloud()`
Удалить бэкап из облака.

---

#### Управление сессиями

##### `getSessionToken()`
Получить текущий токен сессии.

**Возвращает:** `string | null`

---

##### `setSessionToken(token, pubkey, durationMs)`
Установить токен сессии.

**Параметры:**
- `token` (string) — токен сессии
- `pubkey` (string) — публичный ключ
- `durationMs` (number, опциональный) — длительность в миллисекундах

---

##### `clearSessionToken()`
Очистить токен сессии.

---

##### `getPersistedSession()`
Получить сохраненную сессию из localStorage.

**Возвращает:**
```javascript
{
  token: string,
  pubkey: string,
  timestamp: number,
  durationMs: number
} | null
```

---

##### `getSessionDurationMs()`
Получить текущую длительность сессии.

**Возвращает:** `number` (в миллисекундах)

---

##### `setSessionDurationMs(durationMs)`
Установить длительность сессии.

**Параметры:**
- `durationMs` (number) — длительность в миллисекундах (15 мин - 12 часов)

---

### Модуль: `main.js`

#### `onStateChange(callback)`
Подписаться на изменения состояния приложения.

**Параметры:**
- `callback` (function) — функция обратного вызова

**Возвращает:** функция для отписки

**Пример:**
```javascript
import { onStateChange } from './main.js';

const unsubscribe = onStateChange((state) => {
  console.log('Wallet:', state.walletPubkey);
  console.log('Authenticated:', state.isAuthenticated);
});

// Позже отписаться
unsubscribe();
```

**Состояние:**
```javascript
{
  provider: object | null,
  walletPubkey: string | null,
  isAuthenticated: boolean,
  route: { name: string, pubkey?: string },
  isMobile: boolean
}
```

---

#### `getCurrentRoute()`
Получить текущий маршрут.

**Возвращает:**
```javascript
{
  name: 'home' | 'dm',
  pubkey?: string
}
```

---

#### `getWalletPubkey()`
Получить публичный ключ подключенного кошелька.

**Возвращает:** `string | null`

---

#### `isAuthenticated()`
Проверить, аутентифицирован ли пользователь.

**Возвращает:** `boolean`

---

#### `getProviderInstance()`
Получить экземпляр провайдера Phantom.

**Возвращает:** `object | null`

---

#### `isMobileDevice()`
Проверить, является ли устройство мобильным.

**Возвращает:** `boolean`

---

#### `requestConnect(options)`
Запросить подключение кошелька.

**Параметры:**
- `options` (object, опциональный)
  - `forceReload` (boolean) — перезагрузить страницу после подключения

**Пример:**
```javascript
import { requestConnect } from './main.js';
try {
  await requestConnect({ forceReload: false });
} catch (error) {
  if (error.code === 'PHANTOM_NOT_FOUND') {
    console.error('Phantom wallet not installed');
  }
}
```

---

#### `initApp()`
Инициализировать приложение (вызывается при загрузке).

**Пример:**
```javascript
import { initApp } from './main.js';
await initApp();
```

---

#### `logout()`
Выйти из системы.

**Пример:**
```javascript
import { logout } from './main.js';
await logout();
```

---

#### `initiateMobileTransaction(message)`
Инициировать транзакцию на мобильном устройстве.

**Параметры:**
- `message` (string) — сообщение для подписи

---

#### `hasMobileSession()`
Проверить наличие мобильной сессии.

**Возвращает:** `boolean`

---

### Модуль: `db.js`

#### `setDatabaseNamespace(namespace)`
Установить пространство имен базы данных.

**Параметры:**
- `namespace` (string) — имя пространства (обычно публичный ключ)

---

#### Контакты

##### `upsertContact(contact)`
Создать или обновить контакт.

**Параметры:**
```javascript
{
  pubkey: string,
  localName?: string,
  pinned?: boolean,
  color?: string,
  isSaved?: boolean,
  unreadCount?: number,
  createdAt?: number,
  updatedAt?: number
}
```

**Пример:**
```javascript
import { upsertContact } from './db.js';
await upsertContact({
  pubkey: 'CONTACT_PUBKEY',
  localName: 'John Doe',
  pinned: false,
  unreadCount: 0
});
```

---

##### `getContact(pubkey)`
Получить контакт по публичному ключу.

**Возвращает:** `Promise<object | null>`

---

##### `getContacts()`
Получить все контакты.

**Возвращает:** `Promise<Array<object>>`

---

##### `updateContact(pubkey, changes)`
Обновить контакт.

**Параметры:**
- `pubkey` (string) — публичный ключ
- `changes` (object) — изменения

**Пример:**
```javascript
import { updateContact } from './db.js';
await updateContact('CONTACT_PUBKEY', {
  localName: 'New Name',
  unreadCount: 5
});
```

---

##### `deleteContact(pubkey)`
Удалить контакт.

---

#### Сообщения

##### `addMessage(message)`
Добавить сообщение.

**Параметры:**
```javascript
{
  id: string,
  contactKey: string,
  direction: 'incoming' | 'outgoing',
  text: string,
  timestamp?: number,
  status?: 'sent' | 'delivered' | 'read',
  meta?: object
}
```

**Пример:**
```javascript
import { addMessage } from './db.js';
await addMessage({
  id: 'msg-id',
  contactKey: 'CONTACT_PUBKEY',
  direction: 'outgoing',
  text: 'Hello!',
  timestamp: Date.now(),
  status: 'sent'
});
```

---

##### `deleteMessage(id)`
Удалить сообщение.

**Параметры:**
- `id` (string) — ID сообщения

---

##### `deleteMessagesForContact(contactKey)`
Удалить все сообщения контакта.

**Параметры:**
- `contactKey` (string) — публичный ключ контакта

---

##### `setMessageStatus(id, status)`
Установить статус сообщения.

**Параметры:**
- `id` (string) — ID сообщения
- `status` (string) — статус ('sent', 'delivered', 'read')

---

##### `updateMessageMeta(id, metaUpdate)`
Обновить метаданные сообщения.

**Параметры:**
- `id` (string) — ID сообщения
- `metaUpdate` (object) — обновления метаданных

---

##### `getMessagesForContact(contactKey, limit)`
Получить сообщения контакта.

**Параметры:**
- `contactKey` (string) — публичный ключ контакта
- `limit` (number, опциональный) — максимальное количество (по умолчанию 200)

**Возвращает:** `Promise<Array<object>>`

---

#### Профиль

##### `getProfile()`
Получить свой профиль.

**Возвращает:** `Promise<object | null>`

---

##### `saveProfile(profile)`
Сохранить профиль.

**Параметры:**
```javascript
{
  nickname?: string,
  displayName?: string,
  avatarSeed?: string,
  encryptionPublicKey?: string,
  theme?: string,
  createdAt?: number,
  updatedAt?: number
}
```

---

##### `updateProfile(changes)`
Обновить профиль.

---

#### Шифрование

##### `getEncryptionKeys()`
Получить ключи шифрования.

**Возвращает:**
```javascript
{
  publicKey: string,
  secretKey: string,
  createdAt: number,
  updatedAt: number
} | null
```

---

##### `saveEncryptionKeys(keys)`
Сохранить ключи шифрования.

**Параметры:**
```javascript
{
  publicKey: string,
  secretKey: string,
  createdAt?: number
}
```

---

##### `getSessionSecret(pubkey)`
Получить секрет сессии для контакта.

**Параметры:**
- `pubkey` (string) — публичный ключ контакта

**Возвращает:** `Promise<string | null>`

---

##### `saveSessionSecret(pubkey, secret)`
Сохранить секрет сессии.

**Параметры:**
- `pubkey` (string) — публичный ключ контакта
- `secret` (string) — секрет (shared secret)

---

##### `deleteSessionSecret(pubkey)`
Удалить секрет сессии.

---

#### Резервное копирование

##### `exportLocalData(ownerWallet)`
Экспортировать все локальные данные.

**Параметры:**
- `ownerWallet` (string, опциональный) — публичный ключ владельца

**Возвращает:**
```javascript
{
  version: number,
  exportedAt: number,
  ownerWallet: string | null,
  contacts: Array<object>,
  messages: Array<object>,
  profile: object | null,
  encryptionStore: Array<object>
}
```

---

##### `importLocalData(dump, currentWallet)`
Импортировать данные из бэкапа.

**Параметры:**
- `dump` (object) — данные бэкапа
- `currentWallet` (string, опциональный) — текущий публичный ключ

**Ошибки:**
- `WALLET_MISMATCH` — если ownerWallet не совпадает с currentWallet

**Возвращает:**
```javascript
{
  contacts: number,
  messages: number,
  encryption: number
}
```

---

##### `clearDatabase()`
Очистить всю базу данных.

---

##### `migrateContactKey(oldKey, newKey)`
Мигрировать контакт на новый ключ.

**Параметры:**
- `oldKey` (string) — старый публичный ключ
- `newKey` (string) — новый публичный ключ

**Возвращает:** `Promise<boolean>`

---

## Утилиты (Backend)

### Модуль: `utils/crypto.js`

#### `decodeBase58(value)`
Декодировать строку Base58 в Uint8Array.

**Параметры:**
- `value` (string) — строка в Base58

**Возвращает:** `Uint8Array`

**Ошибки:**
- `Error` — если строка пустая или содержит недопустимые символы

---

#### `verifyEd25519Signature(message, signatureBase58, pubkeyBase58)`
Проверить Ed25519 подпись.

**Параметры:**
- `message` (string) — исходное сообщение
- `signatureBase58` (string) — подпись в Base58
- `pubkeyBase58` (string) — публичный ключ в Base58

**Возвращает:** `Promise<boolean>`

**Пример:**
```javascript
import { verifyEd25519Signature } from './utils/crypto.js';
const isValid = await verifyEd25519Signature(
  'message',
  'signature-base58',
  'pubkey-base58'
);
```

---

#### `generateToken(byteLength)`
Сгенерировать случайный токен в Base64URL.

**Параметры:**
- `byteLength` (number, опциональный) — длина в байтах (по умолчанию 32)

**Возвращает:** `string`

---

### Модуль: `utils/nonce.js`

#### `issueNonce(kvNamespace, pubkey, ttlSeconds)`
Выдать одноразовый nonce.

**Параметры:**
- `kvNamespace` (KVNamespace) — пространство имен KV
- `pubkey` (string) — публичный ключ
- `ttlSeconds` (number, опциональный) — время жизни в секундах (по умолчанию 300)

**Возвращает:**
```javascript
{
  nonce: string,
  expiresAt: number
}
```

---

#### `consumeNonce(kvNamespace, pubkey)`
Использовать nonce (удалить после использования).

**Параметры:**
- `kvNamespace` (KVNamespace) — пространство имен KV
- `pubkey` (string) — публичный ключ

**Возвращает:**
```javascript
{
  nonce: string,
  expiresAt: number
} | null
```

---

#### `isNonceValid(record, nonce)`
Проверить валидность nonce.

**Параметры:**
- `record` (object | null) — запись nonce
- `nonce` (string) — nonce для проверки

**Возвращает:** `boolean`

---

### Модуль: `utils/ratelimit.js`

#### `checkAndIncrementRateLimit(kvNamespace, pubkey, limit, windowSeconds)`
Проверить и увеличить счетчик rate limit.

**Параметры:**
- `kvNamespace` (KVNamespace) — пространство имен KV
- `pubkey` (string) — публичный ключ
- `limit` (number, опциональный) — лимит запросов (по умолчанию 60)
- `windowSeconds` (number, опциональный) — окно времени в секундах (по умолчанию 60)

**Возвращает:** `Promise<boolean>` — `true` если лимит не превышен

**Пример:**
```javascript
import { checkAndIncrementRateLimit } from './utils/ratelimit.js';
const allowed = await checkAndIncrementRateLimit(kv, pubkey);
if (!allowed) {
  throw new Error('Rate limit exceeded');
}
```

---

### Модуль: `inbox-do.js`

#### Класс `InboxDurable`
Durable Object для очереди сообщений.

**Методы:**

##### `fetch(request)`
Обработать HTTP запрос.

**Действия:**
- `store` — сохранить сообщение
- `pull` — получить сообщения
- `ack` — подтвердить получение

**Пример:**
```javascript
const inbox = new InboxDurable(state);
const response = await inbox.fetch(new Request('https://inbox', {
  method: 'POST',
  body: JSON.stringify({
    action: 'store',
    message: { id: 'msg-1', ... }
  })
}));
```

---

## Шифрование

### Алгоритмы

- **Аутентификация:** Ed25519 подписи
- **Обмен ключами:** X25519 (Diffie-Hellman)
- **Шифрование сообщений:** XSalsa20-Poly1305 (NaCl box)
- **Резервное копирование:** AES-256-GCM с PBKDF2

### Процесс шифрования сообщений

1. **Генерация ключей:**
   ```javascript
   const keypair = nacl.box.keyPair();
   // publicKey и secretKey
   ```

2. **Обмен ключами:**
   ```javascript
   const sharedSecret = nacl.box.before(
     recipientPublicKey,
     mySecretKey
   );
   ```

3. **Шифрование:**
   ```javascript
   const nonce = nacl.randomBytes(24);
   const ciphertext = nacl.box.after(
     messageBytes,
     nonce,
     sharedSecret
   );
   ```

4. **Отправка:**
   ```javascript
   await sendMessage({
     to: recipientPubkey,
     ciphertext: base64Encode(ciphertext),
     nonce: base64Encode(nonce),
     version: 1
   });
   ```

---

## Push-уведомления

### VAPID ключи

- **Public Key:** `BJoy9eenwraBkfPbPYcMTRV_Rw6z2uYfIPrGgkukwJI06A8zD_tPBec6-eB8dzi13BFxayeS7wZLPgvSvVb7WMY`
- **Subject:** `mailto:support@solink.chat`

### Формат уведомления

```javascript
{
  title: string,
  body: string,
  icon: string,
  badge: string,
  tag: string,
  data: {
    sender: string,
    url: string
  }
}
```

---

## Ограничения и лимиты

### Rate Limits
- **Сообщения:** 60 сообщений в минуту на пользователя
- **Nonce:** 5 минут время жизни
- **Сессии:** 15 минут - 12 часов (по умолчанию 1 час)

### Размеры данных
- **Сообщение:** максимум 1024 символа текста
- **Бэкап:** максимум 50MB
- **Никнейм:** 3-16 символов

### Временные ограничения
- **Смена никнейма:** не чаще 1 раза в 7 дней
- **Push подписки:** автоматическое истечение через 30 дней
- **Сообщения в очереди:** TTL 5 минут

---

## Коды ошибок HTTP

- `400` — Неверный запрос (Bad Request)
- `401` — Неавторизован (Unauthorized)
- `403` — Запрещено (Forbidden)
- `404` — Не найдено (Not Found)
- `405` — Метод не разрешен (Method Not Allowed)
- `409` — Конфликт (Conflict, например, никнейм занят)
- `429` — Слишком много запросов (Rate Limit Exceeded)
- `500` — Внутренняя ошибка сервера
- `502` — Ошибка прокси (Bad Gateway)
- `504` — Таймаут (Gateway Timeout)

---

## Примеры использования

### Полный цикл аутентификации

```javascript
import { fetchNonce, verifySignature } from './api.js';
import { getProviderInstance } from './main.js';

async function authenticate() {
  const provider = getProviderInstance();
  if (!provider) {
    throw new Error('Phantom not found');
  }

  // Подключить кошелек
  const { publicKey } = await provider.connect();
  const pubkey = publicKey.toBase58();

  // Получить nonce
  const { nonce } = await fetchNonce(pubkey);

  // Подписать nonce
  const message = new TextEncoder().encode(nonce);
  const signed = await provider.signMessage(message, 'utf8');
  const signature = encodeBase58(signed.signature);

  // Проверить подпись
  const result = await verifySignature({ pubkey, nonce, signature });
  console.log('Authenticated:', result.token);
}
```

---

### Отправка зашифрованного сообщения

```javascript
import nacl from 'tweetnacl';
import { sendMessage } from './api.js';
import { getEncryptionKeys, getSessionSecret, saveSessionSecret } from './db.js';
import { fetchProfileByPubkey } from './api.js';

async function sendEncryptedMessage(recipientPubkey, text) {
  // Получить ключи получателя
  const { profile } = await fetchProfileByPubkey(recipientPubkey);
  const recipientPublicKey = base64Decode(profile.encryptionPublicKey);

  // Получить свои ключи
  const myKeys = await getEncryptionKeys();
  const mySecretKey = base64Decode(myKeys.secretKey);

  // Получить или создать shared secret
  let sharedSecret = await getSessionSecret(recipientPubkey);
  if (!sharedSecret) {
    sharedSecret = nacl.box.before(recipientPublicKey, mySecretKey);
    await saveSessionSecret(recipientPubkey, base64Encode(sharedSecret));
  } else {
    sharedSecret = base64Decode(sharedSecret);
  }

  // Зашифровать сообщение
  const messageBytes = new TextEncoder().encode(text);
  const nonce = nacl.randomBytes(24);
  const ciphertext = nacl.box.after(messageBytes, nonce, sharedSecret);

  // Отправить
  await sendMessage({
    to: recipientPubkey,
    ciphertext: base64Encode(ciphertext),
    nonce: base64Encode(nonce),
    version: 1,
    senderEncryptionKey: myKeys.publicKey
  });
}
```

---

### Long polling для новых сообщений

```javascript
import { pollInbox, ackMessages } from './api.js';

async function pollMessages() {
  const controller = new AbortController();
  
  // Отменить через 20 секунд
  setTimeout(() => controller.abort(), 20000);

  try {
    const messages = await pollInbox({
      waitMs: 15000,
      signal: controller.signal
    });

    if (messages.length > 0) {
      // Обработать сообщения
      messages.forEach(msg => {
        console.log('New message:', msg);
      });

      // Подтвердить получение
      const ids = messages.map(m => m.id);
      await ackMessages(ids);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('Polling cancelled');
    } else {
      console.error('Polling error:', error);
    }
  }
}
```

---

### Синхронизация чата в облако

```javascript
import { syncChatToCloud, loadChatFromCloud } from './api.js';
import { getMessagesForContact, exportLocalData } from './db.js';
import { encryptBackupWithPassword } from './chat.js';

async function syncChat(contactKey, password) {
  // Получить все сообщения
  const messages = await getMessagesForContact(contactKey);
  
  // Экспортировать данные
  const data = {
    messages,
    contactKey,
    syncedAt: Date.now()
  };

  // Зашифровать
  const encrypted = await encryptBackupWithPassword(data, password);

  // Загрузить в облако
  await syncChatToCloud(contactKey, encrypted);
  console.log('Chat synced to cloud');
}

async function restoreChat(contactKey, password) {
  // Загрузить из облака
  const { found, encrypted } = await loadChatFromCloud(contactKey);
  
  if (!found) {
    console.log('No cloud backup found');
    return;
  }

  // Расшифровать
  const data = await decryptBackupWithPassword(encrypted, password);

  // Восстановить сообщения
  for (const msg of data.messages) {
    await addMessage(msg);
  }
}
```

---

## Безопасность

### CORS
Разрешенные источники:
- `https://solink.chat`
- `http://localhost:*` (для разработки)
- `http://127.0.0.1:*` (для разработки)

### CSP (Content Security Policy)
- Запрещены inline скрипты
- Разрешены только внешние скрипты из доверенных источников
- Строгие правила для предотвращения XSS

### Хранение данных
- **Локально:** IndexedDB (зашифровано)
- **Облако:** R2 Storage (зашифровано)
- **Сервер:** KV Storage (только метаданные, не сообщения)

### Шифрование
- Сообщения шифруются на клиенте
- Сервер никогда не видит открытый текст
- Используется NaCl (TweetNaCl) для криптографии

---

## Версионирование

### Версия API
Текущая версия API: **v1**

### Версия шифрования сообщений
- **v1:** XSalsa20-Poly1305 (текущая)

### Версия резервного копирования
- **v1:** AES-256-GCM с PBKDF2

---

## Поддержка

Для вопросов и поддержки:
- Email: `support@solink.chat`
- GitHub: [https://github.com/dfnwtf/solink](https://github.com/dfnwtf/solink)

---

**Последнее обновление:** 2024
