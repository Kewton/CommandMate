/**
 * Unit tests for the Service Worker cache policy (Issue #1124).
 *
 * These prove the allowlist behaviour, and in particular that API routes, the
 * auth page, WebSocket, and the proxy are never cached.
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
