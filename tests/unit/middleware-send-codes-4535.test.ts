/**
 * Issue #4535 PR-A2, T16 (middleware half; design `docs/design/send-outcome-4535.md`
 * §3.3 C12, §2.2 N6, INV-S9).
 *
 * A refusal the middleware makes on `/api/*` carries a stable `code`, so the CLI
 * and the screen can read it as "the request never reached a handler"
 * (`not_sent`) instead of a bare 401 / an empty 403:
 *
 *  - 401 → `{ error: 'Unauthorized', code: 'AUTH_REQUIRED' }`
 *  - IP restriction 403 → `{ error: 'Forbidden', code: 'IP_DENIED' }` (JSON)
 *
 * Only `/api/*` (INV-S9): a screen path answered as JSON (`Accept:
 * application/json`, or an `Authorization` header) and the screen's login refresh
 * stay as they are, and so does a route's own 401 (`/api/fs/browse`).
 *
 * Runs the REAL middleware with a REAL `NextRequest`. Separate file because
 * `middleware.ts` snapshots token expiry and `ip-restriction.ts` its allow list
 * at import time.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';

const TOKEN = 'middleware-send-codes-4535-token';
const ORIGIN = 'http://localhost:3000';
const ENV_KEYS = ['CM_AUTH_TOKEN_HASH', 'CM_AUTH_SCOPE', 'CM_ALLOWED_IPS', 'CM_TRUST_PROXY'] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.CM_AUTH_TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

async function callMiddleware(pathname: string, headers: Record<string, string> = {}): Promise<Response> {
  const { middleware } = await import('@/middleware');
  return (await middleware(new NextRequest(`${ORIGIN}${pathname}`, { headers }))) as Response;
}

describe('401 and 403 on /api carry a code (Issue #4535 C12)', () => {
  it('401 on /api/* without a token: AUTH_REQUIRED', async () => {
    const response = await callMiddleware('/api/worktrees/wt-1/send', { accept: '*/*' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
  });

  it('401 on /api/* with a wrong Bearer token (the CLI): AUTH_REQUIRED', async () => {
    const response = await callMiddleware('/api/worktrees/wt-1/send', { authorization: 'Bearer wrong' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
  });

  it('403 of the IP restriction on /api/*: JSON { error: Forbidden, code: IP_DENIED }', async () => {
    process.env.CM_ALLOWED_IPS = '10.0.0.0/8';
    const response = await callMiddleware('/api/worktrees/wt-1/send', { 'x-real-ip': '192.168.1.5' });
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Forbidden', code: 'IP_DENIED' });
  });

  it('403 of the IP restriction on /api/* with no client address at all: IP_DENIED', async () => {
    process.env.CM_ALLOWED_IPS = '10.0.0.0/8';
    const response = await callMiddleware('/api/worktrees/wt-1/send');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden', code: 'IP_DENIED' });
  });
});

describe('negative controls: outside /api/* nothing changes (INV-S9)', () => {
  it('a screen path asked as JSON keeps { error: Unauthorized }', async () => {
    const response = await callMiddleware('/sessions', { accept: 'application/json' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('a screen path with a wrong Bearer token keeps { error: Unauthorized }', async () => {
    const response = await callMiddleware('/sessions', { authorization: 'Bearer wrong' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('a screen request still gets the login refresh, not JSON', async () => {
    const response = await callMiddleware('/worktrees/abc', { accept: 'text/html' });
    expect(response.status).toBe(401);
    expect(response.headers.get('refresh')).not.toBeNull();
    expect(await response.text()).not.toContain('AUTH_REQUIRED');
  });

  it('the IP restriction on a screen path stays a 403 with no body', async () => {
    process.env.CM_ALLOWED_IPS = '10.0.0.0/8';
    const response = await callMiddleware('/worktrees/abc', { 'x-real-ip': '192.168.1.5' });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('');
  });

  it('an allowed address and a valid token on /api/* pass through', async () => {
    process.env.CM_ALLOWED_IPS = '10.0.0.0/8';
    const response = await callMiddleware('/api/worktrees', { 'x-real-ip': '10.1.2.3', authorization: `Bearer ${TOKEN}` });
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('a route\'s own 401 (/api/fs/browse) keeps { error: Unauthorized }', async () => {
    const { GET } = await import('@/app/api/fs/browse/route');
    const response = await GET(new NextRequest(`${ORIGIN}/api/fs/browse`));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
});
