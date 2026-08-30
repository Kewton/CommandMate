/**
 * AUTH_EXCLUDED_PATHS is pinned by exact array equality (Issue #1937, §9.2)
 *
 * Every entry here is a path that middleware waves through unauthenticated, so
 * the list is the app's attack surface written down. Individual `toContain`
 * assertions can only catch a removal; they are silent about an addition, which
 * is the direction that actually costs something. Equality means anyone adding
 * a path has to come here and say so — that is the point of the test, not its
 * side effect.
 *
 * #1937 (R5) adds exactly one entry: `/api/remote/pair`. The pairing SCREEN is
 * the already-excluded `/login` driven by a `#code=` fragment, which is why the
 * feature costs one entry rather than two.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { AUTH_EXCLUDED_PATHS } from '@/config/auth-config';

/** The complete, authoritative list. Update deliberately, never mechanically. */
const EXPECTED_EXCLUDED_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status',
  '/api/remote/pair',
  '/manifest.webmanifest',
  '/sw.js',
  '/offline',
];

describe('AUTH_EXCLUDED_PATHS', () => {
  it('contains exactly these paths, in this order', () => {
    expect([...AUTH_EXCLUDED_PATHS]).toEqual(EXPECTED_EXCLUDED_PATHS);
  });

  it('grew by exactly one entry for the remote pairing feature', () => {
    // 7 before #1937 (#331 auth trio + /login, #1124 PWA trio) + 1.
    expect(AUTH_EXCLUDED_PATHS).toHaveLength(8);
    expect(
      AUTH_EXCLUDED_PATHS.filter((path) => path.startsWith('/api/remote'))
    ).toEqual(['/api/remote/pair']);
  });

  it('has no duplicates', () => {
    expect(new Set(AUTH_EXCLUDED_PATHS).size).toBe(AUTH_EXCLUDED_PATHS.length);
  });
});
