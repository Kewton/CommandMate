/**
 * Unit tests for the Service Worker cache policy (Issue #1124).
 *
 * These prove the allowlist behaviour, and in particular that API routes, the
 * auth page, WebSocket, and the proxy are never cached.
 *
 * Issue #2504 asked for the opposite of the last clause: put GET /api/worktrees
 * and GET /api/worktrees/:id on a stale-while-revalidate path so a phone out of
 * coverage still shows the previous worktree list. It was decided wontfix, and
 * the decision is pinned at the bottom of this file rather than left to a design
 * memo alone — `src/lib/pwa/cache-policy.ts` carries the short reasoning, Issue
 * #2504 the full one.
 */
import { describe, it, expect } from 'vitest';
import {
  EXCLUDED_PATH_PREFIXES,
  STATIC_CACHE_PREFIXES,
  STATIC_CACHE_EXACT,
  OFFLINE_URL,
  isExcludedPath,
  isStaticAsset,
  selectCacheStrategy,
  shouldRegisterServiceWorker,
} from '@/lib/pwa/cache-policy';
import {
  collectApiRoutePaths,
  MIN_EXPECTED_API_ROUTES,
  MUST_NEVER_CACHE_MARKERS,
  NON_API_UNCACHEABLE_PATHS,
  NOT_EXCLUDED_PATHS,
} from './api-route-corpus';

const ORIGIN = 'https://app.example.com';
const url = (path: string) => `${ORIGIN}${path}`;

describe('isExcludedPath', () => {
  it.each([
    '/api',
    '/api/worktrees',
    '/api/auth/status',
    '/api/ws',
    '/login',
    '/login/',
    '/proxy',
    '/proxy/streamlit/',
  ])('excludes %s', (path) => {
    expect(isExcludedPath(path)).toBe(true);
  });

  it.each(['/', '/offline', '/sessions', '/apix', '/loginpage', '/proxied'])(
    'does not exclude %s (segment-boundary match, not prefix)',
    (path) => {
      expect(isExcludedPath(path)).toBe(false);
    }
  );
});

describe('isStaticAsset', () => {
  it.each(['/_next/static/chunks/main.js', '/icons/icon-192.png', '/manifest.webmanifest', '/favicon.ico'])(
    'treats %s as a cacheable static asset',
    (path) => {
      expect(isStaticAsset(path)).toBe(true);
    }
  );

  it.each(['/', '/sessions', '/api/worktrees', '/_next/data/x.json'])(
    'does not treat %s as a static asset',
    (path) => {
      expect(isStaticAsset(path)).toBe(false);
    }
  );
});

describe('selectCacheStrategy', () => {
  it('never caches API routes (network-only)', () => {
    expect(
      selectCacheStrategy({ method: 'GET', url: url('/api/worktrees'), origin: ORIGIN })
    ).toBe('network-only');
  });

  it('never caches the auth page (network-only)', () => {
    expect(
      selectCacheStrategy({ method: 'GET', url: url('/login'), origin: ORIGIN, mode: 'navigate' })
    ).toBe('network-only');
  });

  it('never caches the WebSocket endpoint (network-only)', () => {
    expect(
      selectCacheStrategy({ method: 'GET', url: url('/api/ws'), origin: ORIGIN })
    ).toBe('network-only');
  });

  it('never caches the proxy routes (network-only)', () => {
    expect(
      selectCacheStrategy({ method: 'GET', url: url('/proxy/app/'), origin: ORIGIN })
    ).toBe('network-only');
  });

  it('never caches non-GET requests', () => {
    expect(
      selectCacheStrategy({ method: 'POST', url: url('/_next/static/x.js'), origin: ORIGIN })
    ).toBe('network-only');
  });

  it('never caches cross-origin requests', () => {
    expect(
      selectCacheStrategy({ method: 'GET', url: 'https://cdn.other.com/a.js', origin: ORIGIN })
    ).toBe('network-only');
  });

  it('serves hashed static assets cache-first', () => {
    expect(
      selectCacheStrategy({ method: 'GET', url: url('/_next/static/chunks/main.js'), origin: ORIGIN })
    ).toBe('cache-first');
    expect(
      selectCacheStrategy({ method: 'GET', url: url('/icons/icon-512.png'), origin: ORIGIN })
    ).toBe('cache-first');
  });

  it('serves navigations with an offline fallback', () => {
    expect(
      selectCacheStrategy({ method: 'GET', url: url('/sessions'), origin: ORIGIN, mode: 'navigate' })
    ).toBe('offline-fallback');
  });

  it('does not cache non-navigate, non-static same-origin GETs (allowlist default)', () => {
    expect(
      selectCacheStrategy({ method: 'GET', url: url('/some/data'), origin: ORIGIN })
    ).toBe('network-only');
  });

  it('returns network-only for malformed URLs', () => {
    expect(selectCacheStrategy({ method: 'GET', url: 'not-a-url', origin: ORIGIN })).toBe(
      'network-only'
    );
  });
});

describe('shouldRegisterServiceWorker', () => {
  it('registers only in production', () => {
    expect(shouldRegisterServiceWorker('production')).toBe(true);
  });

  it.each(['development', 'test', undefined, '', 'staging'])(
    'does not register for %s',
    (env) => {
      expect(shouldRegisterServiceWorker(env)).toBe(false);
    }
  );
});

describe('policy constants', () => {
  it('excludes the auth and API and proxy roots', () => {
    expect(EXCLUDED_PATH_PREFIXES).toEqual(['/api', '/login', '/proxy']);
  });

  it('caches the immutable static prefixes', () => {
    expect(STATIC_CACHE_PREFIXES).toContain('/_next/static/');
    expect(STATIC_CACHE_PREFIXES).toContain('/icons/');
  });

  it('caches manifest and favicon exactly', () => {
    expect(STATIC_CACHE_EXACT).toContain('/manifest.webmanifest');
    expect(STATIC_CACHE_EXACT).toContain('/favicon.ico');
  });

  it('exposes the offline fallback route', () => {
    expect(OFFLINE_URL).toBe('/offline');
  });
});

// ---------------------------------------------------------------------------
// Issue #2504 — the decision NOT to cache API responses, as a test.
// ---------------------------------------------------------------------------
//
// The Issue proposed caching `GET /api/worktrees` and `GET /api/worktrees/:id`
// on the grounds that they are low-sensitivity metadata. Two findings closed it:
//
//  1. They are not low-sensitivity. `/api/worktrees` carries `lastUserMessage`
//     (the prompt text sent to the agent, 200 chars), `lastMessagesByCli`,
//     `sessionNotes` and absolute repository paths.
//  2. A cache read in a Service Worker cannot be authenticated. The auth cookie
//     is `httpOnly`, so the worker cannot see it, the server sends no
//     `Vary: Cookie`, and there is no per-user identity to key a cache on —
//     anything in the Cache API is readable by whoever can open the origin in
//     that browser profile, with no token.
//
// So the corpus below is not a list of "paths we happened to think of". It is
// every API route that exists, walked from disk, asserted never-cacheable. A
// future stale-while-revalidate patch has to come through here on purpose.
describe('Issue #2504: no API response is ever served from cache', () => {
  const apiPaths = collectApiRoutePaths();

  // A directory walk's one real failure mode is finding nothing and passing
  // everything. The two guards that follow — a count floor and a reachability
  // check on the named-sensitive routes — are what make the rest of this block
  // mean anything; do not weaken them to fix a red walk.
  it('walked the API route tree at all', () => {
    expect(apiPaths.length).toBeGreaterThanOrEqual(MIN_EXPECTED_API_ROUTES);
  });

  it.each(MUST_NEVER_CACHE_MARKERS)('corpus reaches %s', (marker) => {
    expect(apiPaths.some((path) => path.includes(marker))).toBe(true);
  });

  it('treats every API route as excluded', () => {
    expect(apiPaths.filter((path) => !isExcludedPath(path))).toEqual([]);
  });

  // Independent of the denylist: even if the order in selectCacheStrategy were
  // inverted so the allowlist ran first, no API path may match it.
  it('treats no API route as a static asset', () => {
    expect(apiPaths.filter((path) => isStaticAsset(path))).toEqual([]);
  });

  it('selects network-only for every API route, as a GET, a navigation and with a query', () => {
    const offenders: string[] = [];
    for (const path of apiPaths) {
      const variants: { label: string; strategy: string }[] = [
        {
          label: `GET ${path}`,
          strategy: selectCacheStrategy({ method: 'GET', url: url(path), origin: ORIGIN }),
        },
        {
          // A direct address-bar hit on an API path arrives as a navigation.
          // That is the branch an API path could plausibly fall into, since it
          // is evaluated after the static allowlist and matches on `mode`
          // alone rather than on the path.
          label: `NAVIGATE ${path}`,
          strategy: selectCacheStrategy({
            method: 'GET',
            url: url(path),
            origin: ORIGIN,
            mode: 'navigate',
          }),
        },
        {
          // The real callers pass query strings (`?includeStatus=0`,
          // `?include=review`); the policy must not key on a bare pathname.
          label: `QUERY ${path}`,
          strategy: selectCacheStrategy({
            method: 'GET',
            url: `${url(path)}?includeStatus=0&include=review`,
            origin: ORIGIN,
          }),
        },
      ];
      for (const variant of variants) {
        if (variant.strategy !== 'network-only') {
          offenders.push(`${variant.label} -> ${variant.strategy}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Named explicitly, on top of the corpus above, so the two endpoints this
  // Issue is actually about fail by name if somebody implements it.
  it.each([
    ['/api/worktrees', 'the list — carries lastUserMessage / sessionNotes'],
    ['/api/worktrees/some-worktree', 'the detail — carries the same free text plus gitStatus'],
  ])('keeps %s uncached (%s)', (path) => {
    expect(selectCacheStrategy({ method: 'GET', url: url(path), origin: ORIGIN })).toBe(
      'network-only'
    );
  });

  it.each(NON_API_UNCACHEABLE_PATHS)('keeps the non-API denylist entry %s uncached', (path) => {
    expect(isExcludedPath(path)).toBe(true);
    expect(selectCacheStrategy({ method: 'GET', url: url(path), origin: ORIGIN })).toBe(
      'network-only'
    );
    expect(
      selectCacheStrategy({ method: 'GET', url: url(path), origin: ORIGIN, mode: 'navigate' })
    ).toBe('network-only');
  });

  it.each(NOT_EXCLUDED_PATHS)('still does not over-exclude %s', (path) => {
    expect(isExcludedPath(path)).toBe(false);
  });
});
