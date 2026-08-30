/**
 * GET /api/capabilities — disclosure scope and shape (Issue #1925, S11 / DR4-008).
 *
 * This endpoint exists so a CLI newer than the daemon can ask before it depends
 * on something (§10.6). That makes it the one route that answers *something*
 * about the server to a caller that has not yet established anything, which is
 * why its disclosure is pinned rather than described: `CM_AUTH_TOKEN_HASH` unset
 * skips auth entirely and `CM_BIND=0.0.0.0` is a supported setting, so "no auth,
 * on the LAN" is a real deployment and this body has to be worthless to it.
 *
 * The key-for-key assertion is the guard that matters. Anything later added to
 * the response — an installed-tool list, a path, a port, a worktree count —
 * turns it red rather than shipping quietly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/version-checker', () => ({
  getServerVersion: vi.fn().mockReturnValue('9.9.9'),
}));

import { GET, dynamic } from '@/app/api/capabilities/route';
import { SERVER_CAPABILITIES } from '@/config/server-capabilities';
import { AUTH_EXCLUDED_PATHS } from '@/config/auth-config';
import { getServerVersion } from '@/lib/version-checker';

beforeEach(() => {
  vi.mocked(getServerVersion).mockReturnValue('9.9.9');
});

describe('GET /api/capabilities', () => {
  it('is force-dynamic so an upgraded server does not serve a frozen answer', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  /**
   * S11. Listing this path would put it outside middleware auth, which is the
   * one thing §10.6 item 2 forbids: it belongs under the same auth as every
   * other API route, not next to /login and the service worker.
   */
  it('is not in AUTH_EXCLUDED_PATHS', () => {
    expect(AUTH_EXCLUDED_PATHS as readonly string[]).not.toContain('/api/capabilities');
  });

  it('answers exactly serverVersion and capabilities — nothing else', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['capabilities', 'serverVersion']);
    expect(body).toEqual({
      serverVersion: '9.9.9',
      // Issue #2065 added the second token. The TOKEN is additive and allowed
      // here; the default agent list itself is NOT — it is served by
      // /api/settings/default-agents and GET /api/worktrees, both behind the
      // same auth as everything else, so this body stays a fixed compile-time
      // list. The 'does not reflect the runtime environment' case below is what
      // keeps that true.
      capabilities: ['resolve-session-target', 'default-selected-agents'],
    });
  });

  it('sends Cache-Control: no-store', async () => {
    const response = await GET();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  /**
   * The tokens are a promise about a wire contract. A client keys off one to
   * decide whether to call an endpoint at all, so removing or renaming one
   * breaks every CLI already in the field — the exact skew this endpoint exists
   * to absorb. Adding is fine and does not fail here.
   */
  it('still declares every token it has ever shipped', () => {
    expect(SERVER_CAPABILITIES).toContain('resolve-session-target');
    expect(SERVER_CAPABILITIES).toContain('default-selected-agents');
  });

  it('declares only strings, so the CLI can compare without unwrapping', async () => {
    const body = await (await GET()).json();
    expect(Array.isArray(body.capabilities)).toBe(true);
    for (const token of body.capabilities) {
      expect(typeof token).toBe('string');
    }
  });

  /**
   * DR4-015: no `createRequestRateLimiter` here, on purpose — the route reads no
   * database and spawns nothing, so flooding it costs what flooding a 404 costs.
   * `resolve-target`, which does read the database, is limited (see
   * resolve-target.test.ts). Pinned by source so the reason survives the next
   * "why is this one not rate limited?" review.
   */
  it('does not rate limit, and the source says why', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync('src/app/api/capabilities/route.ts', 'utf-8');
    expect(source).not.toContain("from '@/lib/security/request-rate-limiter'");
    expect(source).toContain('DR4-015');
  });

  /**
   * The shape of the leak this route must not grow: nothing that varies with
   * what is installed, where it lives, or how much of it there is.
   */
  it('does not reflect the runtime environment', async () => {
    const body = await (await GET()).json();
    const serialized = JSON.stringify(body);
    for (const forbidden of ['/Users', '/home', 'port', 'worktree', 'installed']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
