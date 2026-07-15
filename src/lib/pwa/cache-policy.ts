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
