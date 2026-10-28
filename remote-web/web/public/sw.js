// Komla Remote service worker, scoped to /remote/.
//
// It makes the phone client installable and lets it open while the desktop is unreachable, so the
// page can say so and retry instead of showing a browser error. It caches only the public app
// shell. It never touches the WebSocket, /remote/config or /remote/health, and holds no keys:
// trusted-device keys stay in IndexedDB and every session still authenticates with the desktop.

const SHELL_CACHE = 'komla-remote-shell-v1';
const SHELL_URLS = ['./', './manifest.webmanifest', './icons/icon-192.png'];
const UNCACHED_PATHS = new Set(['config', 'health', 'ws']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (UNCACHED_PATHS.has(url.pathname.slice(scope.pathname.length))) return;
  event.respondWith(networkFirst(request));
});

// The desktop is the source of truth for the app: always ask it first, so a new Komla build's
// client replaces the old one, and fall back to the copy from the last visit only when offline.
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  // Every page in scope (/remote/ and /remote/pair) is the same index.html.
  const key = request.mode === 'navigate' ? new URL('./', self.registration.scope).href : request;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(key, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
}

// ── Web Push ───────────────────────────────────────────────────────────
// The desktop encrypts each payload to this browser's subscription (RFC 8291); it carries a
// title, a body and which workspace and terminal to open. Ids are checked before use.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function pushTarget(data) {
  const workspaceId =
    typeof data?.workspaceId === 'string' && ID_PATTERN.test(data.workspaceId)
      ? data.workspaceId
      : undefined;
  const terminalId =
    workspaceId && typeof data?.terminalId === 'string' && ID_PATTERN.test(data.terminalId)
      ? data.terminalId
      : undefined;
  return { workspaceId, terminalId };
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Komla';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : 'komla';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: new URL('./icons/icon-192.png', self.registration.scope).href,
      data: pushTarget(payload),
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = pushTarget(event.notification.data);
  const scope = new URL(self.registration.scope);
  const url = new URL('./', scope);
  if (target.workspaceId) url.searchParams.set('workspace', target.workspaceId);
  if (target.terminalId) url.searchParams.set('terminal', target.terminalId);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) =>
        new URL(client.url).pathname.startsWith(scope.pathname)
      );
      if (open) {
        open.postMessage({ type: 'komla:open-workspace', ...target });
        await open.focus().catch(() => {});
        return;
      }
      await self.clients.openWindow(url.href);
    })()
  );
});
