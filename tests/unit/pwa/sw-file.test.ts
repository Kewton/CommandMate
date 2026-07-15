/**
 * Guard tests for the shipped Service Worker file (Issue #1124).
 *
 * `public/sw.js` is a hand-written vanilla worker that cannot import from the
 * bundled source, so these tests assert it stays in sync with the tested
 * policy in src/lib/pwa/cache-policy.ts and preserves the safety invariants
 * (only same-origin GET, denylist for API/auth/proxy, explicit update flow,
 * Web Push extension point).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  EXCLUDED_PATH_PREFIXES,
  STATIC_CACHE_PREFIXES,
  STATIC_CACHE_EXACT,
  OFFLINE_URL,
} from '@/lib/pwa/cache-policy';

const swSource = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8');

describe('public/sw.js integrity', () => {
  it('mirrors every excluded (never-cached) prefix from the policy', () => {
    for (const prefix of EXCLUDED_PATH_PREFIXES) {
      expect(swSource).toContain(`'${prefix}'`);
    }
  });

  it('mirrors every static cache-first prefix from the policy', () => {
    for (const prefix of STATIC_CACHE_PREFIXES) {
      expect(swSource).toContain(`'${prefix}'`);
    }
  });

  it('mirrors the exact static cache entries from the policy', () => {
    for (const path of STATIC_CACHE_EXACT) {
      expect(swSource).toContain(`'${path}'`);
    }
  });

  it('precaches the offline fallback route', () => {
    expect(swSource).toContain(`'${OFFLINE_URL}'`);
  });
});

describe('public/sw.js safety invariants', () => {
  it('only handles GET requests', () => {
    expect(swSource).toMatch(/request\.method\s*!==\s*'GET'/);
  });

  it('restricts caching to same-origin requests', () => {
    expect(swSource).toContain('self.location.origin');
  });

  it('short-circuits excluded paths before any cache read/write', () => {
    expect(swSource).toContain('isExcludedPath');
  });

  it('does not skipWaiting on install (waits for user confirmation)', () => {
    // skipWaiting must only appear inside the message handler, never at install.
    const installBlock = swSource.slice(
      swSource.indexOf("addEventListener('install'"),
      swSource.indexOf("addEventListener('activate'")
    );
    expect(installBlock).not.toContain('skipWaiting');
  });

  it('applies updates via a SKIP_WAITING message', () => {
    expect(swSource).toContain('SKIP_WAITING');
    expect(swSource).toContain('self.skipWaiting()');
  });

  it('keeps a Web Push extension point for the follow-up issue', () => {
    expect(swSource).toContain('#1125');
  });
});
