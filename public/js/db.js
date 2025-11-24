const DB_PREFIX = 'solink-db';
let currentDbName = `${DB_PREFIX}-guest`;
const DB_VERSION = 3;
const CONTACTS_STORE = 'contacts';
const MESSAGES_STORE = 'messages';
const PROFILE_STORE = 'profile';
const ENCRYPTION_STORE = 'encryption';
const SESSION_PREFIX = 'session:';

export function setDatabaseNamespace(namespace) {
  if (!namespace) {
    currentDbName = `${DB_PREFIX}-guest`;
    return;
  }
  const safe = String(namespace).replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'guest';
  currentDbName = `${DB_PREFIX}-${safe}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(currentDbName, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(CONTACTS_STORE)) {
        db.createObjectStore(CONTACTS_STORE, { keyPath: 'pubkey' });
      }
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const store = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
        store.createIndex('byContact', 'contactKey', { unique: false });
        store.createIndex('byTimestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(PROFILE_STORE)) {
        db.createObjectStore(PROFILE_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(ENCRYPTION_STORE)) {
        db.createObjectStore(ENCRYPTION_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeNames, mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const transaction = db.transaction(names, mode);
    const stores = names.map((name) => transaction.objectStore(name));
    const request = callback(...stores);

    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

export async function upsertContact(contact) {
  const payload = {
    pubkey: contact.pubkey,
    localName: contact.localName || '',
    pinned: Boolean(contact.pinned),
    color: contact.color || null,
    unreadCount: Number.isFinite(contact.unreadCount) ? contact.unreadCount : 0,
    createdAt: contact.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await withStore(CONTACTS_STORE, 'readwrite', (store) => store.put(payload));
  return payload;
}

export async function getContact(pubkey) {
  return withStore(CONTACTS_STORE, 'readonly', (store) => store.get(pubkey));
}

export async function getContacts() {
  return withStore(CONTACTS_STORE, 'readonly', (store) => store.getAll());
}

export async function updateContact(pubkey, changes) {
  const existing = await getContact(pubkey);
  if (!existing) return null;
  const payload = {
    ...existing,
    ...changes,
    unreadCount: Number.isFinite(changes.unreadCount)
      ? changes.unreadCount
      : existing.unreadCount || 0,
    updatedAt: Date.now(),
  };
  await withStore(CONTACTS_STORE, 'readwrite', (store) => store.put(payload));
  return payload;
}

export async function deleteContact(pubkey) {
  await withStore(CONTACTS_STORE, 'readwrite', (store) => store.delete(pubkey));
}

export async function addMessage(message) {
  const payload = {
    id: message.id,
    contactKey: message.contactKey,
    direction: message.direction,
    text: message.text,
    timestamp: message.timestamp || Date.now(),
    status: message.status || 'sent',
    meta: message.meta || {},
  };
  await withStore(MESSAGES_STORE, 'readwrite', (store) => store.put(payload));
  return payload;
}

export async function setMessageStatus(id, status) {
  return withStore(MESSAGES_STORE, 'readwrite', (store) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const message = request.result;
      if (!message) return;
      message.status = status;
      store.put(message);
    };
    return request;
  });
}

export async function getMessagesForContact(contactKey, limit = 200) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MESSAGES_STORE, 'readonly');
    const store = transaction.objectStore(MESSAGES_STORE);
    const index = store.index('byContact');
    const request = index.getAll(IDBKeyRange.only(contactKey));

    request.onsuccess = () => {
      const items = request.result || [];
      items.sort((a, b) => a.timestamp - b.timestamp);
      resolve(limit ? items.slice(-limit) : items);
    };

    request.onerror = () => reject(request.error);
  });
}

export async function clearDatabase() {
  const db = await openDb();
  const names = Array.from(db.objectStoreNames);
  await Promise.all(
    names.map(
      (name) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(name, 'readwrite');
          const store = tx.objectStore(name);
          const request = store.clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }),
    ),
  );
}

export async function migrateContactKey(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) {
    return false;
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CONTACTS_STORE, MESSAGES_STORE], 'readwrite');
    const contactsStore = transaction.objectStore(CONTACTS_STORE);
    const messagesStore = transaction.objectStore(MESSAGES_STORE);

    const contactRequest = contactsStore.get(oldKey);
    contactRequest.onerror = () => reject(contactRequest.error);
    contactRequest.onsuccess = () => {
      const contact = contactRequest.result;
      if (!contact) {
        resolve(false);
        return;
      }

      const updatedContact = {
        ...contact,
        pubkey: newKey,
        updatedAt: Date.now(),
      };

      contactsStore.put(updatedContact);
      contactsStore.delete(oldKey);

      const index = messagesStore.index('byContact');
      const messagesRequest = index.getAll(IDBKeyRange.only(oldKey));
      messagesRequest.onerror = () => reject(messagesRequest.error);
      messagesRequest.onsuccess = () => {
        const messages = messagesRequest.result || [];
        messages.forEach((message) => {
          const updatedMessage = { ...message, contactKey: newKey };
          messagesStore.put(updatedMessage);
        });
      };
    };

    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

export async function getProfile() {
  const result = await withStore(PROFILE_STORE, 'readonly', (store) => store.get('self'));
  return result || null;
}

export async function saveProfile(profile) {
  const payload = {
    id: 'self',
    nickname: profile.nickname || '',
    displayName: profile.displayName || '',
    avatarSeed: profile.avatarSeed || null,
    encryptionPublicKey: profile.encryptionPublicKey || null,
    theme: profile.theme || 'dark',
    createdAt: profile.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await withStore(PROFILE_STORE, 'readwrite', (store) => store.put(payload));
  return payload;
}

export async function updateProfile(changes) {
  const existing =
    (await getProfile()) || { id: 'self', createdAt: Date.now(), nickname: '', displayName: '', encryptionPublicKey: null };
  const payload = {
    ...existing,
    ...changes,
    updatedAt: Date.now(),
  };
  await withStore(PROFILE_STORE, 'readwrite', (store) => store.put(payload));
  return payload;
}

export async function getEncryptionKeys() {
  const record = await withStore(ENCRYPTION_STORE, 'readonly', (store) => store.get('self'));
  return record || null;
}

export async function saveEncryptionKeys(keys) {
  const payload = {
    id: 'self',
    publicKey: keys.publicKey,
    secretKey: keys.secretKey,
    createdAt: keys.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await withStore(ENCRYPTION_STORE, 'readwrite', (store) => store.put(payload));
  return payload;
}

export async function getSessionSecret(pubkey) {
  if (!pubkey) return null;
  const record = await withStore(ENCRYPTION_STORE, 'readonly', (store) => store.get(`session:${pubkey}`));
  return record?.secret || null;
}

export async function saveSessionSecret(pubkey, secret) {
  if (!pubkey || !secret) return null;
  const payload = {
    id: `session:${pubkey}`,
    secret,
    updatedAt: Date.now(),
  };
  await withStore(ENCRYPTION_STORE, 'readwrite', (store) => store.put(payload));
  return payload;
}
