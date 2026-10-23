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
//
// `/api` is load-bearing and is not a default anyone forgot to revisit: Issue
// #2504 asked for two of its GETs to be served from cache while revalidating,
// and was closed wontfix. The short reason is that a cache read in this file
// cannot be authenticated — the auth cookie is httpOnly and invisible here, the
// server sends no `Vary: Cookie`, and the token is one server-wide secret, so
// there is no identity to key a cache on. Whatever lands in the Cache API is
// readable by anyone who can open this origin in this browser profile.
// Note also that `matchesPrefix` below is a PREFIX match: `/api/worktrees` is
// 36 routes, among them current-output, files, env, messages and terminal.
// The rest of the reasoning is in src/lib/pwa/cache-policy.ts; the full argument
// is the design policy filed on Issue #2504.
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
  } catch {
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
  } catch {
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
// Issue #2155 widened the caller: EVERY tagged payload comes through here now,
// not only resolutions. The replacement is silent only for a resolution — a
// waiting card is still allowed to alert — but the close-then-show sequence
// below is identical for both, so nothing in this function had to change.
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
//
// --- Issue #3798 (the resolution names its episode) -------------------------
// A resolution may carry `resolvedEpisodeId`: the waiting episode whose card it
// clears. It can arrive after the card of a NEWER wait in the same worktree
// (same tag) — the next prompt's push overtook it — and closing that card would
// hide a wait that is still open.
//
// A different id alone does NOT make a card newer. Delivery fails per device,
// and the server sends a resolution only once nothing in the worktree is still
// waiting, so a device that missed wait B's card can still be showing wait A's
// when B's resolution arrives — A is over too, and nothing would ever close it
// again (the server's mark is spent). Nor does the wait's start (`since`): a
// structured since is reused by the next wait and can be older than the
// observation, and two waits can start and end in one millisecond.
//
// Newer is proved by `order`: a per-worktree counter the server advances, in
// one database statement, for every episode-named card it sends and for every
// resolution it decides (`nextPromptOrder`). A wait open when the resolution
// was decided would have stopped it, so a card whose order is greater than the
// resolution's can only be a wait that opened later.
//
// So: a card of another episode with a greater order is closed and shown again
// with the same content, silently (`silent: true`, `renotify: false`), INSTEAD
// of the resolution; every other card — the resolved episode's, one naming no
// episode or carrying no order, one sent before the resolution — is closed and
// the resolution shown in its place, as before. Every branch still calls
// `showNotification` exactly once, so the `userVisibleOnly` contract above
// holds. A resolution without the id or the order (a server before #3798)
// clears the tag as it always has.
function isNewerThanResolution(card, resolvedEpisodeId, resolvedOrder) {
  var data = card.data || {};
  return (
    typeof resolvedEpisodeId === 'string' &&
    typeof resolvedOrder === 'number' &&
    typeof data.episodeId === 'string' &&
    data.episodeId !== resolvedEpisodeId &&
    typeof data.order === 'number' &&
    data.order > resolvedOrder
  );
}

function replaceStaleNotifications(title, options, resolvedEpisodeId, resolvedOrder) {
  var registration = self.registration;
  var tag = options.tag;
  var closing;

  if (!tag || typeof registration.getNotifications !== 'function') {
    closing = Promise.resolve(null);
  } else {
    closing = registration
      // Correct either way: whether an engine hands back every card carrying the tag or only the newest one, the loop closes exactly what it was handed (iOS is still unmeasured on this point — Issue #2155).
      .getNotifications({ tag: tag })
      .then(function (stale) {
        var newer = null;
        for (var i = 0; i < stale.length; i++) {
          if (
            isNewerThanResolution(stale[i], resolvedEpisodeId, resolvedOrder) &&
            // Of several, the card the server sent last.
            (newer === null || stale[i].data.order > newer.data.order)
          ) {
            newer = stale[i];
          }
          stale[i].close();
        }
        return newer;
      })
      .catch(function (_err) {
        // A registration that cannot enumerate its notifications still has to
        // show one. Showing the replacement below is what keeps the promise;
        // on this path the tag alone collapses the stale card on most engines.
        return null;
      });
  }

  return closing.then(function (newer) {
    if (newer) {
      return registration.showNotification(newer.title, {
        body: newer.body,
        tag: tag,
        renotify: false,
        silent: true,
        icon: newer.icon || options.icon,
        badge: newer.badge || options.badge,
        data: newer.data,
      });
    }
    return registration.showNotification(title, options);
  });
}

self.addEventListener('push', function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
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

  // Issue #3798: a waiting card remembers its episode, so a later resolution
  // can tell it from the card it is clearing. Absent from older payloads.
  if (typeof payload.episodeId === 'string') options.data.episodeId = payload.episodeId;
  // ...and its place in the worktree's order, so a later resolution can tell
  // whether the card was sent after the resolution was decided.
  if (typeof payload.order === 'number') options.data.order = payload.order;
  var resolvedEpisodeId =
    resolved && typeof payload.resolvedEpisodeId === 'string' ? payload.resolvedEpisodeId : null;
  var resolvedOrder = resolved && typeof payload.order === 'number' ? payload.order : null;

  // --- Issue #2155 ---------------------------------------------------------
  // Every TAGGED push takes the close-then-show path, not just resolutions.
  // Safari/iOS does not collapse same-tag cards on a plain `showNotification`,
  // so waiting notifications — and every escalation re-notification behind them
  // — stacked up there while Chrome folded them into one (measured 2026-08-30,
  // iPad iOS 18.7 / Safari 26.5.2 vs Android 10 / Chrome 151). Closing the
  // stale cards explicitly is the part iOS does honour. An untagged push has
  // nothing to replace and goes straight to `showNotification`.
  event.waitUntil(
    options.tag
      ? replaceStaleNotifications(title, options, resolvedEpisodeId, resolvedOrder)
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
          } catch {
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
