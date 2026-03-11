// ════════════════════════════════════════════════
//  ගමට උසාවිය — Service Worker
//  Gamata Usaviya Rural Legal Aid System v1.0
// ════════════════════════════════════════════════

const CACHE_NAME = 'gamata-usaviya-v1';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Noto+Serif+Sinhala:wght@300;400;600;700&family=Noto+Sans+Tamil:wght@400;600&family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap',
];

// ── INSTALL ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(PRECACHE_ASSETS.map(url =>
        cache.add(url).catch(e => console.warn('[SW] Could not cache:', url, e))
      ))
    ).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!['http:', 'https:'].includes(url.protocol)) return;

  // AI APIs — always network, graceful offline error
  const isApi = url.hostname.includes('groq.com') ||
                url.hostname.includes('anthropic.com') ||
                url.hostname === 'localhost' ||
                url.hostname === '127.0.0.1';

  if (isApi) {
    event.respondWith(
      fetch(request).catch(() => new Response(JSON.stringify({
        error: 'offline',
        message: 'AI service unavailable offline. Switch to Offline mode in settings.'
      }), { headers: { 'Content-Type': 'application/json' }, status: 503 }))
    );
    return;
  }

  // Fonts — cache first
  if (url.hostname.includes('fonts.google') || url.hostname.includes('fonts.gstatic')) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
        return res;
      }))
    );
    return;
  }

  // App shell — cache first, network fallback
  event.respondWith(
    caches.match(request).then(hit => {
      if (hit) return hit;
      return fetch(request).then(res => {
        if (res.ok && url.origin === self.location.origin) {
          caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
        }
        return res;
      }).catch(() =>
        request.headers.get('accept')?.includes('text/html')
          ? caches.match('./index.html')
          : new Response('Offline', { status: 503 })
      );
    })
  );
});

// ── MESSAGE ──
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
