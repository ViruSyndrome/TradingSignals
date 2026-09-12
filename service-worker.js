const CACHE_NAME = 'trendrunner-cache-v72';

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
const urlsToCache = [
  './',
  './index.html',
  './icon-192.png',
  './icon-512.png'
];

// Install event - cache core assets
self.addEventListener('install', event => {
  self.skipWaiting(); // Force the new service worker to take over immediately
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim(); // Take control of all open pages immediately
});

function isAuthCallback(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('code') || u.searchParams.has('error') || u.searchParams.has('error_description')) {
      return true;
    }
    // Supabase sometimes returns tokens in the hash (not visible here), but
    // also hits /auth/v1/* — never cache those.
    if (u.hostname.includes('supabase.co')) return true;
    return false;
  } catch {
    return false;
  }
}

// Fetch event - NETWORK FIRST strategy
// This solves the 'stale app' problem. It always tries the internet first,
// and only uses the cache if the user is completely offline.
self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Never intercept OAuth / Supabase auth callbacks — caching these breaks Chrome + PWA login
  if (isAuthCallback(event.request.url)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // If the network fetch is successful, clone it and update the cache
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // If the network fails (offline), fall back to the cache
        return caches.match(event.request);
      })
  );
});
