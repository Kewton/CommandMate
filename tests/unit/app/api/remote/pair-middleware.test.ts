/**
 * Middleware treatment of /api/remote/pair (Issue #1937, R5)
 *
 * The route authenticates the pairing code itself, so it has to be reachable
 * without a cookie — but only it. This runs the REAL middleware against the
 * REAL excluded-path list (no `auth-config` stub) so the exclusion and its
 * narrowness are asserted together: `/api/remote/pair` passes, and a sibling
 * under the same prefix does not. S002's exact-match rule is what makes the
 * second half true, and this is the test that would notice it becoming a
 * `startsWith`.
 *
 * Separate file because `middleware.ts` snapshots token expiry at import time,
 * so the hash has to exist before the module is first evaluated.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';

const TOKEN = 'remote-pairing-middleware-token';

let previousHash: string | undefined;

beforeEach(() => {
  previousHash = process.env.CM_AUTH_TOKEN_HASH;
  process.env.CM_AUTH_TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
  vi.resetModules();
});

afterEach(() => {
  if (previousHash === undefined) delete process.env.CM_AUTH_TOKEN_HASH;
  else process.env.CM_AUTH_TOKEN_HASH = previousHash;
  vi.resetModules();
});

async function callMiddleware(url: string) {
  const { middleware } = await import('@/middleware');
  return middleware(new NextRequest(url, { method: 'POST' }));
}

describe('/api/remote/pair under middleware', () => {
  it('is reachable without credentials', async () => {
    const response = await callMiddleware('http://localhost/api/remote/pair');

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('does not exempt anything else under /api/remote', async () => {
    const response = await callMiddleware('http://localhost/api/remote/pair/extra');

    expect(response.status).not.toBe(200);
  });
});
