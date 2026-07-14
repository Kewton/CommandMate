/*
 * CommandMate Service Worker — Issue #1124.
 *
 * Hand-written vanilla Service Worker (no next-pwa / Workbox). Rationale:
 *   - The app runs behind a custom Node server (server.ts) that owns the HTTP
 *     upgrade path for WebSockets; next-pwa/Serwist assume the default Next
 *     server and inject a full precache manifest of the build output.
 *   - This Issue mandates an *allowlist* cache strategy (explicitly enumerate
 *     what is cached). A hand-written SW expresses that directly and keeps the
 *     file small, auditable, and trivial to extend for Web Push (Issue #1125).
 *
 * The cache rules below MIRROR src/lib/pwa/cache-policy.ts, which is unit
 * tested. tests/unit/pwa/sw-file.test.ts asserts this file stays in sync.
 *
 * Update strategy: install does NOT skipWaiting. A new worker stays "waiting"
 * until the client posts { type: 'SKIP_WAITING' } (triggered by the in-app
 * "update available" toast), then activates and the page reloads on
 * controllerchange. This gives the user an explicit, non-destructive update.
 */

// Bump CACHE_VERSION on any change to precached assets or cache shape.
const CACHE_VERSION = 'v1';
const CACHE_NAME = 'commandmate-' + CACHE_VERSION;

const OFFLINE_URL = '/offline';
const PRECACHE_URLS = [OFFLINE_URL];

// Denylist — never cached (mirror of EXCLUDED_PATH_PREFIXES).
const EXCLUDED_PATH_PREFIXES = ['/api', '/login', '/proxy'];
// Allowlist — cache-first (mirror of STATIC_CACHE_PREFIXES / STATIC_CACHE_EXACT).
const STATIC_CACHE_PREFIXES = ['/_next/static/', '/icons/'];
const STATIC_CACHE_EXACT = ['/manifest.webmanifest', '/favicon.ico'];

function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

function isExcludedPath(pathname) {
  return EXCLUDED_PATH_PREFIXES.some(function (prefix) {
    return matchesPrefix(pathname, prefix);
  });
}

function isStaticAsset(pathname) {
  return (
    STATIC_CACHE_PREFIXES.some(function (prefix) {
      return pathname.startsWith(prefix);
    }) || STATIC_CACHE_EXACT.indexOf(pathname) !== -1
  );
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  // Intentionally NOT activating immediately here: the new worker stays waiting
  // until the client confirms the update (see the update strategy above).
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== CACHE_NAME;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.status === 200 && response.type === 'basic') {
    cache.put(request, response.clone());
  }
  return response;
}

async function offlineFallback(request) {
  try {
    // Navigation responses are intentionally NOT cached: they may contain
    // authenticated content. Only the offline fallback page is served on error.
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(CACHE_NAME);
    const offline = await cache.match(OFFLINE_URL);
    return offline || Response.error();
  }
}

self.addEventListener('fetch', function (event) {
  const request = event.request;

  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // Only same-origin GETs are ever eligible.
  if (url.origin !== self.location.origin) return;
  // Denylist: API, auth page, proxy — passthrough, never cached.
  if (isExcludedPath(url.pathname)) return;

  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(offlineFallback(request));
    return;
  }

  // Allowlist default: not matched → passthrough (never cached).
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// --- Issue #1125 (Web Push) extension point -------------------------------
// Web Push support will attach handlers here without touching the cache logic
// above, e.g.:
//   self.addEventListener('push', function (event) { /* show notification */ });
//   self.addEventListener('notificationclick', function (event) { /* focus */ });
// Keep push/notification concerns isolated from the fetch/cache handlers.
