// SkyLab service worker — offline support for remote launches with no signal.
// Strategy:
//   • App shell (this page) → network-first, fall back to cache, so updates land
//     when online but the map still opens offline.
//   • Everything else (map tiles, CDN libs, weather) → cache-first with a capped
//     runtime cache, so the last-seen terrain/weather is available offline.
const VERSION = 'skylab-v1';
const SHELL = VERSION + '-shell';
const RUNTIME = VERSION + '-runtime';
const SHELL_URLS = ['./', 'index.html', 'manifest.json'];
const RUNTIME_MAX = 400; // cap cached tile/asset entries so storage doesn't grow forever

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Keep the runtime cache from growing unbounded (rough FIFO trim).
async function trimCache(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Navigation / app shell → network-first.
  if (req.mode === 'navigate' || (req.destination === 'document')) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put('index.html', copy));
        return res;
      }).catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Everything else → cache-first, then network (and stash a copy).
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        // Cache successful (and opaque cross-origin tile) responses.
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(RUNTIME).then(c => { c.put(req, copy); trimCache(RUNTIME, RUNTIME_MAX); });
        }
        return res;
      }).catch(() => cached); // offline and uncached → let it fail naturally
    })
  );
});
