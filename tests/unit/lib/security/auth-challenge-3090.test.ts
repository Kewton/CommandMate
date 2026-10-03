/**
 * Where an unauthenticated request is sent behind a tunnel (Issue #3090).
 *
 * Behind `commandmate remote` the server sees `localhost:3000`, so the old
 * `NextResponse.redirect(request.nextUrl.clone())` pointed the phone at
 * `https://localhost:3000/login`. These tests run the REAL middleware with a
 * REAL `NextRequest` whose URL is what Next.js builds behind a tunnel
 * (`https://localhost:3000/...`) and whose headers are what the tunnel — or an
 * attacker — sends, and require:
 *
 *  - screens: 401 + a relative refresh to `/login`, which the browser resolves
 *    against the tunnel's own origin; no `Location`, no host anywhere;
 *  - `/api/*` and `Accept: application/json`: 401 JSON, no redirect;
 *  - a forged `Host` / `X-Forwarded-Host` never reaches the response
 *    (positive control for "no open redirect").
 *
 * Separate file because `middleware.ts` snapshots token expiry at import time.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import {
  createLoginRefreshResponse,
  isApiShapedRequest,
  LOGIN_REFRESH_HEADER,
} from '@/lib/security/auth-challenge';

const TOKEN = 'auth-challenge-3090-token';
/** The URL Next.js builds behind a tunnel: its own hostname and port. */
const SERVER_ORIGIN = 'https://localhost:3000';
const TUNNEL_ORIGIN = 'https://quiet-river-1234.trycloudflare.com';
const EVIL_HOST = 'evil.example';

let previousHash: string | undefined;
let previousScope: string | undefined;

beforeEach(() => {
  previousHash = process.env.CM_AUTH_TOKEN_HASH;
  previousScope = process.env.CM_AUTH_SCOPE;
  process.env.CM_AUTH_TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
  delete process.env.CM_AUTH_SCOPE;
  vi.resetModules();
});

afterEach(() => {
  if (previousHash === undefined) delete process.env.CM_AUTH_TOKEN_HASH;
  else process.env.CM_AUTH_TOKEN_HASH = previousHash;
  if (previousScope === undefined) delete process.env.CM_AUTH_SCOPE;
  else process.env.CM_AUTH_SCOPE = previousScope;
  vi.resetModules();
});

async function callMiddleware(pathname: string, headers: Record<string, string> = {}) {
  const { middleware } = await import('@/middleware');
  const response = await middleware(new NextRequest(`${SERVER_ORIGIN}${pathname}`, { headers }));
  return response as Response;
}

/** Every header value plus the body, to search for a host that must not be there. */
async function serialize(response: Response): Promise<string> {
  const headerText = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  const body = await response.clone().text();
  return `${headerText}\n${body}`;
}

/** Where a browser showing `pageUrl` goes when it follows the response's refresh. */
function refreshTarget(response: Response, pageUrl: string): URL {
  const refresh = response.headers.get('refresh') ?? '';
  const match = /url=(.*)$/i.exec(refresh);
  expect(match).not.toBeNull();
  return new URL(match![1].trim(), pageUrl);
}

const TUNNEL_HEADERS = {
  host: 'localhost:3000',
  'x-forwarded-host': new URL(TUNNEL_ORIGIN).host,
  'x-forwarded-proto': 'https',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

describe('auth-challenge helpers (Issue #3090)', () => {
  it.each([
    ['/api/worktrees', null, true],
    ['/api', null, true],
    ['/api/worktrees', 'text/html', true],
    ['/', 'application/json', true],
    ['/sessions', 'application/json, text/plain, */*', true],
    ['/', 'text/html,application/xhtml+xml,application/json;q=0.9', false],
    ['/', null, false],
    ['/apiary', null, false],
    ['/proxy/app/', '*/*', false],
  ] as const)('isApiShapedRequest(%s, %s) === %s', (pathname, accept, expected) => {
    expect(isApiShapedRequest(pathname, accept)).toBe(expected);
  });

  it('builds a 401 whose only target is the relative /login', async () => {
    const response = createLoginRefreshResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('refresh')).toBe(LOGIN_REFRESH_HEADER);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain('<meta http-equiv="refresh" content="0; url=/login">');
    expect(body).not.toMatch(/https?:|\/\/[a-z]/i);
  });
});

describe('middleware sends unauthenticated requests to the same-origin /login (Issue #3090)', () => {
  it('sends a tunnel screen request to the tunnel origin, never localhost', async () => {
    const response = await callMiddleware('/worktrees/abc', TUNNEL_HEADERS);

    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(await serialize(response)).not.toContain('localhost');

    const target = refreshTarget(response, `${TUNNEL_ORIGIN}/worktrees/abc`);
    expect(target.origin).toBe(TUNNEL_ORIGIN);
    expect(target.pathname).toBe('/login');
  });

  it('keeps the desktop on its own origin too', async () => {
    const response = await callMiddleware('/', { accept: 'text/html' });
    const target = refreshTarget(response, 'http://localhost:3000/');
    expect(target.href).toBe('http://localhost:3000/login');
  });

  it('never lets a forged Host / X-Forwarded-Host pick another origin (positive control)', async () => {
    const forgeries: Record<string, string>[] = [
      { host: EVIL_HOST },
      { 'x-forwarded-host': EVIL_HOST },
      { host: EVIL_HOST, 'x-forwarded-host': EVIL_HOST, 'x-forwarded-proto': 'http' },
      { 'x-forwarded-host': `${EVIL_HOST}, localhost:3000` },
    ];
    for (const forged of forgeries) {
      const response = await callMiddleware('/', { accept: 'text/html', ...forged });

      expect(response.status).toBe(401);
      expect(response.headers.get('location')).toBeNull();
      expect(await serialize(response)).not.toContain(EVIL_HOST);
      // The browser showing the tunnel page stays on the tunnel origin.
      expect(refreshTarget(response, `${TUNNEL_ORIGIN}/`).origin).toBe(TUNNEL_ORIGIN);
    }
  });

  it('answers 401 JSON to a browser fetch of /api/* instead of redirecting', async () => {
    const response = await callMiddleware('/api/worktrees', { ...TUNNEL_HEADERS, accept: '*/*' });

    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('refresh')).toBeNull();
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers 401 JSON to an Accept: application/json request on a screen path', async () => {
    const response = await callMiddleware('/sessions', { accept: 'application/json' });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('keeps the CLI 401 for an invalid Bearer token', async () => {
    const response = await callMiddleware('/api/worktrees', { authorization: 'Bearer wrong' });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('does not loosen anything: the valid cookie passes, a wrong one does not', async () => {
    const ok = await callMiddleware('/worktrees/abc', { cookie: `cm_auth_token=${TOKEN}` });
    expect(ok.headers.get('x-middleware-next')).toBe('1');

    const wrong = await callMiddleware('/worktrees/abc', { cookie: 'cm_auth_token=nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('x-middleware-next')).toBeNull();
  });

  it('still serves /login itself without a token', async () => {
    const response = await callMiddleware('/login', TUNNEL_HEADERS);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
