/**
 * Middleware authentication over POST /api/hooks/agent-event (Issue #1549).
 *
 * The route has no auth code of its own — it is protected only by not appearing
 * in `AUTH_EXCLUDED_PATHS` — so the only way to show it is actually protected is
 * to run the real middleware against the real config. `middleware-bearer.test.ts`
 * stubs `auth-config` to fix the excluded-path list; this file deliberately does
 * not, because the list itself is the thing under test.
 *
 * Separate file because it reloads modules: `middleware.ts` computes token
 * expiry once at import time, so the hash has to be in the environment before
 * the module is first evaluated.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';

const TOKEN = 'agent-event-hook-token';
const HOOK_PATH = 'http://localhost/api/hooks/agent-event';

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

async function callMiddleware(url: string, authorization?: string) {
  const { middleware } = await import('@/middleware');
  return middleware(
    new NextRequest(url, {
      method: 'POST',
      headers: authorization ? { authorization } : {},
    })
  );
}

describe('POST /api/hooks/agent-event authentication', () => {
  it('rejects a wrong bearer token with 401', async () => {
    const response = await callMiddleware(HOOK_PATH, 'Bearer not-the-token');
    expect(response.status).toBe(401);
  });

  it('rejects a request with no credentials at all', async () => {
    // Browsers get redirected to /login rather than a 401; either way the
    // request never reaches the route handler.
    const response = await callMiddleware(HOOK_PATH);
    expect(response.status).not.toBe(200);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('lets the correct bearer token through', async () => {
    // The control that makes the two rejections above mean something: with a
    // valid token the same request is passed on untouched.
    const response = await callMiddleware(HOOK_PATH, `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('is enforced for the legacy claude-done receiver too', async () => {
    const rejected = await callMiddleware('http://localhost/api/hooks/claude-done', 'Bearer nope');
    expect(rejected.status).toBe(401);
  });

  it('is enforced for the Auto-Yes v2 receiver (Issue #1724)', async () => {
    // This one carries a decision the agent executes, so an unauthenticated
    // caller reaching it could approve commands in somebody's worktree.
    const path = 'http://localhost/api/hooks/permission-request';

    expect((await callMiddleware(path, 'Bearer nope')).status).toBe(401);
    expect((await callMiddleware(path, `Bearer ${TOKEN}`)).status).toBe(200);
  });

  it('passes everything through when no token hash is configured', async () => {
    // Backwards compatibility: an installation that never enabled auth must not
    // start failing hook posts because this endpoint was added.
    delete process.env.CM_AUTH_TOKEN_HASH;
    vi.resetModules();

    const response = await callMiddleware(HOOK_PATH);
    expect(response.status).toBe(200);
  });
});
