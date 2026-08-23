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

// --- Issue #1125 (Web Push) ------------------------------------------------
// Push/notification concerns are kept isolated from the fetch/cache handlers
// above. Payloads are minimal (worktree name + kind + short excerpt); the SW
// never receives full terminal output.

// --- Issue #2001 (cross-device dismissal) ----------------------------------
//
// A `resolved: true` payload says: the wait this worktree's card is about is
// over, and this device may still be showing it. Close the stale cards carrying
// that tag, then show ONE silent replacement in their place.
//
// THE ORDER IS LOAD-BEARING AND MUST NOT BE INVERTED. Every subscription in
// this app is created with `userVisibleOnly: true` — the only value browsers
// accept from a web page — and each engine enforces it by looking at what is
// *displayed* once the promise handed to `event.waitUntil` has settled, not at
// whether `showNotification` was called. Closing after showing therefore ends
// the event with an empty screen, which Chrome answers with its own generic
// "This site has been updated in the background" card, Firefox charges to a
// per-subscription silent-push quota (and unsubscribes when it runs out), and
// WebKit punishes by revoking the push subscription outright.
// See docs/design/cross-device-notification-dismissal.md for the citations.
//
// This is also why there is no "close and show nothing" branch: a resolution
// with nothing to close still shows its card. That is the contract, not an
// oversight.
function replaceStaleNotifications(title, options) {
  var registration = self.registration;
  var tag = options.tag;
  var closing;

  if (!tag || typeof registration.getNotifications !== 'function') {
    closing = Promise.resolve();
  } else {
    closing = registration
      .getNotifications({ tag: tag })
      .then(function (stale) {
        for (var i = 0; i < stale.length; i++) {
          stale[i].close();
        }
      })
      .catch(function (err) {
        // A registration that cannot enumerate its notifications still has to
        // show one. Showing the replacement below is what keeps the promise;
        // on this path the tag alone collapses the stale card on most engines.
      });
  }

  return closing.then(function () {
    return registration.showNotification(title, options);
  });
}

self.addEventListener('push', function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = {};
  }

  var resolved = payload.resolved === true;

  var title = payload.title || 'CommandMate';
  var options = {
    body: payload.body || '',
    tag: payload.tag || undefined,
    // A resolution replaces a card the reader has already been alerted about,
    // so it must not alert again — that would trade a stale notification for a
    // second buzz and undo what Issues #1999 / #2000 removed.
    renotify: !resolved,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: {
      url: payload.url || '/',
      worktreeId: payload.worktreeId,
      kind: payload.kind,
      resolved: resolved,
    },
  };

  // `silent` is set only for a resolution. The Notifications API reads an absent
  // value as "respect the device's own settings", which is what every alerting
  // notification shipped before this Issue did; `silent: false` would be a
  // different, louder instruction.
  if (resolved) options.silent = true;

  event.waitUntil(
    resolved
      ? replaceStaleNotifications(title, options)
      : self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var data = event.notification.data || {};
  var targetUrl = data.url || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        // Prefer an existing window already on the target path.
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          try {
            if (new URL(client.url).pathname === targetUrl && 'focus' in client) {
              return client.focus();
            }
          } catch (err) {
            // ignore malformed client URL
          }
        }
        // Otherwise navigate an existing window to the deep link.
        for (var j = 0; j < clientList.length; j++) {
          var existing = clientList[j];
          if ('focus' in existing && typeof existing.navigate === 'function') {
            return existing.navigate(targetUrl).then(function (navigated) {
              return navigated ? navigated.focus() : null;
            });
          }
        }
        // No window open — open a new one.
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return null;
      })
  );
});
