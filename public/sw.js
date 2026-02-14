// SOLink Service Worker for Push Notifications
const SW_VERSION = "1.2";
const CACHE_NAME = "solink-v2";

console.log("[SW] Service Worker version:", SW_VERSION);

// Install event
self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker...");
  self.skipWaiting();
});

// Activate event
self.addEventListener("activate", (event) => {
  console.log("[SW] Service worker activated");
  event.waitUntil(clients.claim());
});

// Push event - handle incoming push notifications
self.addEventListener("push", (event) => {
  console.log("[SW] Push received:", event);
  
  let data = {
    title: "SOLink",
    body: "New message",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    data: {}
  };
  
  try {
    if (event.data) {
      const payload = event.data.json();
      data = {
        ...data,
        ...payload
      };
    }
  } catch (e) {
    console.warn("[SW] Failed to parse push data:", e);
  }
  
  const options = {
    body: data.body,
    icon: data.icon || "/icons/icon-192.png",
    badge: data.badge || "/icons/badge-72.png",
    vibrate: [100, 50, 100],
    data: data.data || {},
    actions: [
      { action: "open", title: "Open" },
      { action: "dismiss", title: "Dismiss" }
    ],
    tag: data.tag || "solink-message",
    renotify: true,
    requireInteraction: false
  };
  
  // Check if app is already open and focused
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        console.log("[SW] Found windows:", windowClients.length);
        
        // Check if any window with the app is visible/focused
        let appIsOpen = false;
        for (const client of windowClients) {
          console.log("[SW] Window:", client.url, "visibility:", client.visibilityState, "focused:", client.focused);
          if (client.url.includes("/app") && (client.visibilityState === "visible" || client.focused)) {
            appIsOpen = true;
            break;
          }
        }
        
        if (appIsOpen) {
          console.log("[SW] App is open and visible, skipping notification");
          // Notify the app about the new message instead
          windowClients.forEach(client => {
            if (client.url.includes("/app")) {
              client.postMessage({ type: "NEW_MESSAGE", data: data.data });
            }
          });
          return; // Don't show notification if app is open
        }
        
        console.log("[SW] App is not visible, showing notification");
        return self.registration.showNotification(data.title, options);
      })
  );
});

// Notification click event
self.addEventListener("notificationclick", (event) => {
  console.log("[SW] Notification clicked:", event);
  
  event.notification.close();
  
  if (event.action === "dismiss") {
    return;
  }
  
  // Open or focus the app
  const urlToOpen = event.notification.data?.url || "/app";
  
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Check if app is already open
        for (const client of windowClients) {
          if (client.url.includes("/app") && "focus" in client) {
            // Navigate to specific chat if sender is provided
            if (event.notification.data?.sender) {
              client.postMessage({
                type: "OPEN_CHAT",
                sender: event.notification.data.sender
              });
            }
            return client.focus();
          }
        }
        // Open new window
        if (clients.openWindow) {
          let url = "/app";
          if (event.notification.data?.sender) {
            url += `?chat=${event.notification.data.sender}`;
          }
          return clients.openWindow(url);
        }
      })
  );
});

// Notification close event
self.addEventListener("notificationclose", (event) => {
  console.log("[SW] Notification closed");
});

// Message from main app
self.addEventListener("message", (event) => {
  console.log("[SW] Message from app:", event.data);
  
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

