/* global self, caches */
// TicketManager service worker: lets the installed app open quickly and show its screens when
// the network drops. It never stores API answers, so no claim, bill or personal data is kept
// on the phone; those always come fresh from the server.
const SHELL = 'tm-shell-v1';
const ASSETS = 'tm-assets-v1';
const KEEP_ASSETS = 80;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/favicon.svg']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(
    keys.slice(0, Math.max(0, keys.length - KEEP_ASSETS)).map((k) => cache.delete(k)),
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // API calls, sign-in and downloads always go to the network.
  if (url.pathname.startsWith('/api/')) return;

  // Pages: the network first (so updates show at once), the saved app when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(SHELL).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    );
    return;
  }

  // Built files have a hash in their name and never change: keep them.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
          void trim(cache);
        }
        return response;
      }),
    );
    return;
  }

  // Icons, fonts and the manifest: the saved copy at once, refreshed in the background.
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(request);
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) void cache.put(request, response.clone());
          return response;
        })
        .catch(() => hit ?? Response.error());
      return hit ?? fresh;
    }),
  );
});
