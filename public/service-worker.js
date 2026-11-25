const STATIC = 'turnline-static-v1';

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('turnline-static-') && name !== STATIC)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/assets/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(STATIC);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone()).catch(() => {});
      return response;
    } catch (error) {
      const saved = await cache.match(request);
      if (saved) return saved;
      throw error;
    }
  })());
});
