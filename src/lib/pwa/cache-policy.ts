/**
 * Service Worker cache policy (Issue #1124).
 *
 * Single source of truth for the PWA caching rules. The runtime Service Worker
 * (`public/sw.js`) mirrors these exact constants and decision rules; a guard
 * test (`tests/unit/pwa/sw-file.test.ts`) asserts the shipped file stays in
 * sync with this module so the two can never silently drift.
 *
 * Design: **allowlist**. Only requests that match an explicit rule are cached.
 * Everything else is passed straight through to the network and never touched,
 * so API responses, the auth page, and dynamic proxy routes can never be
 * served from a stale cache.
 *
 * Issue #2504 proposed relaxing exactly that last clause — serve
 * `GET /api/worktrees` and `GET /api/worktrees/:id` from cache while revalidating,
 * so a phone out of coverage still shows the previous worktree list — and was
 * closed **wontfix**. Three findings, kept here because they are the reasons this
 * rule is not merely conservative:
 *
 *  1. **A cache read in a Service Worker cannot be authenticated.** The auth
 *     cookie is `httpOnly`, so no script sees it — not `document.cookie` in the
 *     page, not `cookieStore` in the worker — and an intercepted
 *     `event.request` carries no `Cookie` header either, because cookies are
 *     attached downstream of the fetch handler. On top of that the server sends
 *     no `Vary: Cookie`, so `cache.match()` would not key on one, and the token
 *     is a single server-wide secret, so there is no identity to key on at all.
 *     Anything written to the Cache API is readable by whoever can open the
 *     origin in that browser profile, with no token.
 *  2. **The revocation path needs the connectivity the cache exists to survive.**
 *     `commandmate remote stop` and `--expires` close the tunnel and tell the
 *     device nothing, so the cache outlives the session by construction.
 *  3. **`Cache-Control: no-store` does not protect this.** `next.config.js` sets
 *     it on `/api/:path*`, but the Cache API has no HTTP-cache semantics and
 *     `cache.put()` stores a `no-store` response as happily as any other. This
 *     denylist is the only thing standing between an API response and the disk.
 *
 * `GET /api/worktrees` also carries `lastUserMessage` / `lastMessagesByCli` /
 * `sessionNotes`, so "it is only metadata" was not true either.
 *
 * The full argument, including the four conditions that would make this worth
 * revisiting, is in the design policy filed on Issue #2504. The decision is
 * enforced by `tests/unit/pwa/cache-policy.test.ts` (every API route that exists
 * is asserted never-cacheable) and by `tests/unit/pwa/sw-file.test.ts` (the
 * shipped worker is evaluated and required to agree). Do not relax one of those
 * to land a change here.
 */

/**
 * Paths that must NEVER be cached, checked before any allowlist rule.
 * - `/api`   : dynamic API responses (also `Cache-Control: no-store`).
 * - `/login` : auth page — caching it could serve a stale/authless shell.
 * - `/proxy` : external-app proxy (Issue #42) — fully dynamic upstreams.
 *
 * WebSocket (`/api/ws` upgrades) is covered by `/api` and, in any case, upgrade
 * requests never surface as `fetch` events.
 */
export const EXCLUDED_PATH_PREFIXES = ['/api', '/login', '/proxy'] as const;

/** Path prefixes served cache-first (immutable, content-hashed assets). */
export const STATIC_CACHE_PREFIXES = ['/_next/static/', '/icons/'] as const;

/** Exact paths served cache-first (stable, safe-to-cache static resources). */
export const STATIC_CACHE_EXACT = [
  '/manifest.webmanifest',
  '/favicon.ico',
] as const;

/** Precached offline fallback route, served when a navigation cannot reach the network. */
export const OFFLINE_URL = '/offline';

/** Cache strategy selected for a given request. */
export type CacheStrategy =
  /** Passthrough — never read from or written to the cache. */
  | 'network-only'
  /** Serve from cache, fall back to network and populate the cache. */
  | 'cache-first'
  /** Try network; on failure serve the precached offline page (response not cached). */
  | 'offline-fallback';

/** Match a pathname against a prefix as a path segment (`/api` matches `/api` and `/api/x`, not `/apix`). */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/** True when the path must never be cached (denylist). */
export function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PATH_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/** True when the path is an immutable static asset eligible for cache-first. */
export function isStaticAsset(pathname: string): boolean {
  return (
    STATIC_CACHE_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    STATIC_CACHE_EXACT.includes(pathname as (typeof STATIC_CACHE_EXACT)[number])
  );
}

/** Minimal shape of the request attributes the policy needs to decide a strategy. */
export interface CachePolicyInput {
  /** HTTP method (only GET is ever cacheable). */
  method: string;
  /** Absolute request URL. */
  url: string;
  /** The Service Worker's own origin (`self.location.origin`). */
  origin: string;
  /** Request mode; `'navigate'` marks a document navigation. */
  mode?: string;
}

/**
 * Decide the cache strategy for a request. Order matters: the denylist and the
 * method/origin guards are evaluated before any allowlist rule.
 */
export function selectCacheStrategy(input: CachePolicyInput): CacheStrategy {
  const { method, url, origin, mode } = input;

  if (method !== 'GET') return 'network-only';

  let pathname: string;
  let requestOrigin: string;
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    requestOrigin = parsed.origin;
  } catch {
    return 'network-only';
  }

  if (requestOrigin !== origin) return 'network-only';
  if (isExcludedPath(pathname)) return 'network-only';
  if (isStaticAsset(pathname)) return 'cache-first';
  if (mode === 'navigate') return 'offline-fallback';

  return 'network-only';
}

/**
 * Registration guard: the Service Worker is registered only in production
 * builds, never in `development` or `test` (avoids dev cache accidents).
 */
export function shouldRegisterServiceWorker(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'production';
}
