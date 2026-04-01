// ════════════════════════════════════════════════════════
//  JusticeLK Service Worker v3.0 — Offline + Background Sync
//  © 2026 Elmo Richard Pereira · Ace Dynamics Trading
// ════════════════════════════════════════════════════════

const CACHE_NAME    = 'justicelk-v3';
const SYNC_TAG      = 'justicelk-case-sync';
const WORKER_URL    = 'https://lexlk.acedynamicstrading.workers.dev';
const DB_NAME       = 'JusticeLK_Offline';
const DB_VERSION    = 1;
const STORE_CASES   = 'pending_cases';
const STORE_FILES   = 'pending_files';

// All pages and assets to cache for full offline use
const PRECACHE_URLS = [
  './index.html',
  './lawyer-registration.html',
  './privacy-policy.html',
  './404.html',
  './manifest.json',
  // Google Fonts — cache both font families used
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600;700&family=Noto+Serif+Sinhala:wght@400;700&family=Noto+Sans+Tamil:wght@400;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Noto+Serif+Sinhala:wght@400;700&family=Noto+Sans+Tamil:wght@400;700&display=swap',
];

// ── INSTALL — cache everything ──
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Could not cache:', url, err))
        )
      )
    )
  );
});

// ── ACTIVATE — clean old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH — serve from cache, fall back to network ──
self.addEventListener('fetch', event => {
  const req = event.request;

  // Never intercept POST requests — let them go to network
  if (req.method !== 'GET') return;

  // For navigate requests — always try network first, fall back to cached index
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(response => {
          // Update cache with fresh version
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // For everything else — cache first, network fallback
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        return response;
      }).catch(() => {
        // If fetch fails and it's HTML, return offline page
        if (req.headers.get('Accept')?.includes('text/html')) {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ══════════════════════════════════════════════
//  BACKGROUND SYNC — fires when connection returns
// ══════════════════════════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    console.log('[SW] Background sync triggered — syncing pending cases...');
    event.waitUntil(syncPendingCases());
  }
});

// ── Open IndexedDB ──
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_CASES)) {
        const store = db.createObjectStore(STORE_CASES, { keyPath: 'token' });
        store.createIndex('synced',  'synced',  { unique: false });
        store.createIndex('created', 'created', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── Get all unsynced cases ──
function getUnsyncedCases(db) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_CASES, 'readonly');
    const store = tx.objectStore(STORE_CASES);
    const index = store.index('synced');
    const req   = index.getAll(0); // 0 = not synced
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── Mark a case as synced ──
function markSynced(db, token) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_CASES, 'readwrite');
    const store = tx.objectStore(STORE_CASES);
    const req   = store.get(token);
    req.onsuccess = () => {
      const record = req.result;
      if (record) {
        record.synced    = 1;
        record.syncedAt  = new Date().toISOString();
        store.put(record);
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Sync all pending cases to Cloudflare Worker ──
async function syncPendingCases() {
  let db, cases;
  try {
    db    = await openDB();
    cases = await getUnsyncedCases(db);
  } catch (e) {
    console.error('[SW] DB error during sync:', e);
    return;
  }

  if (cases.length === 0) {
    console.log('[SW] No pending cases to sync.');
    notifyClients({ type: 'SYNC_COMPLETE', count: 0 });
    return;
  }

  console.log(`[SW] Syncing ${cases.length} pending case(s)...`);
  let synced = 0;
  let failed = 0;

  for (const caseData of cases) {
    try {
      const response = await fetch(WORKER_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action:     'saveCase',
          token:      caseData.token,
          clientName: caseData.client,
          nic:        caseData.nic,
          mobile:     caseData.mobile,
          district:   caseData.district,
          caseType:   caseData.caseType,
          status:     caseData.status || 'Pending',
          officer:    caseData.officer,
          created:    caseData.created,
          court:      caseData.court,
          route:      caseData.route,
          facts:      caseData.facts,
          brief:      caseData.brief,
          relief:     caseData.relief,
          lawyer:     caseData.lawyer ? caseData.lawyer.name + ' (' + caseData.lawyer.reg + ')' : '',
          offlineSync: true,
          savedOfflineAt: caseData.savedAt,
        })
      });

      if (response.ok) {
        await markSynced(db, caseData.token);
        synced++;
        console.log(`[SW] ✓ Synced case: ${caseData.token}`);
      } else {
        failed++;
        console.warn(`[SW] ✗ Failed to sync: ${caseData.token}`, response.status);
      }
    } catch (e) {
      failed++;
      console.warn(`[SW] ✗ Network error syncing: ${caseData.token}`, e.message);
    }
  }

  // Notify all open tabs
  notifyClients({
    type:   'SYNC_COMPLETE',
    synced,
    failed,
    total:  cases.length,
  });
}

// ── Send message to all open clients (tabs) ──
function notifyClients(msg) {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then(clients => clients.forEach(client => client.postMessage(msg)));
}

// ── Listen for messages from the page ──
self.addEventListener('message', event => {
  if (event.data?.type === 'MANUAL_SYNC') {
    console.log('[SW] Manual sync requested');
    syncPendingCases();
  }
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
