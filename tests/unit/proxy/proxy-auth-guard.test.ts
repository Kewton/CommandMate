/**
 * /proxy/* must keep going through Next.js middleware (Issue #1804)
 *
 * WHY THIS TEST EXISTS
 *
 * Issue #1804 was originally filed proposing that `server.ts` intercept
 * `/proxy/` at the HTTP layer and never hand it to Next.js, so the raw request
 * target would be available. That plan is unsafe and was rejected:
 *
 *   - `src/middleware.ts` is what enforces auth and IP restriction for
 *     `/proxy/...`. `AUTH_EXCLUDED_PATHS` is matched with `Array.includes()`
 *     (exact match, see middleware.ts's S002 note), so no `/proxy/...` URL is
 *     excluded - every one of them is authenticated today.
 *   - Bypassing Next.js therefore strips auth AND IP restriction from every
 *     External App at once. Under a Cloudflare Tunnel that is direct public
 *     exposure of whatever the upstream app serves.
 *   - `next.config.js`'s `headers()` (CSP, X-Frame-Options, ...) would be lost
 *     as well.
 *
 * The shipped fix keeps `/proxy/` flowing through Next.js and only copies the
 * raw `req.url` into a header, so it does not touch auth at all. These tests
 * pin the property that made that choice necessary: if someone later moves the
 * proxy into `server.ts`, `/proxy/...` stops being authenticated and this file
 * is what should stop them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock next/server before importing middleware (same shape as
// tests/integration/auth-middleware.test.ts)
vi.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    headers: Map<string, string>;
    private _redirect: string | null;

    constructor(_body?: unknown, init?: { status?: number }) {
      this.status = init?.status ?? 200;
      this.headers = new Map();
      this._redirect = null;
    }

    static next() {
      const res = new MockNextResponse();
      res.status = 200;
      return res;
    }

    static json(_body: unknown, init?: { status?: number }) {
      return new MockNextResponse(_body, init);
    }

    static redirect(url: URL | string) {
      const res = new MockNextResponse();
      res.status = 302;
      res._redirect = typeof url === 'string' ? url : url.toString();
      return res;
    }

    get redirectUrl() {
      return this._redirect;
    }
  }

  return { NextResponse: MockNextResponse };
});

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

/** Build a NextRequest-ish object for the middleware under test */
function createMockRequest(
  pathname: string,
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {}
) {
  return {
    nextUrl: {
      pathname,
      clone: () => ({
        pathname: '/login',
        toString: () => 'http://localhost:3000/login',
      }),
    },
    url: `http://localhost:3000${pathname}`,
    cookies: {
      get: (name: string) => {
        const value = cookies[name];
        return value !== undefined ? { name, value } : undefined;
      },
    },
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

/** Every proxy URL shape this Issue touches, including the query-string cases */
const PROXY_PATHS = [
  '/proxy/testapp',
  '/proxy/testapp/',
  '/proxy/testapp/try/',
  '/proxy/testapp/search',
  '/proxy/testapp/a%2Fb/',
  '/proxy/testapp/assets/main.js',
];

describe('/proxy/* authentication and IP restriction (Issue #1804 guard)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CM_AUTH_TOKEN_HASH;
    delete process.env.CM_AUTH_EXPIRE;
    delete process.env.CM_ALLOWED_IPS;
    delete process.env.CM_TRUST_PROXY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  /** Enable auth with a known token and return it */
  async function enableAuth(): Promise<string> {
    const { generateToken, hashToken } = await import('@/lib/security/auth');
    const token = generateToken();
    const hash = hashToken(token);
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;
    return token;
  }

  it('should list no /proxy path in AUTH_EXCLUDED_PATHS', async () => {
    const { AUTH_EXCLUDED_PATHS } = await import('@/config/auth-config');

    for (const excluded of AUTH_EXCLUDED_PATHS) {
      expect(excluded.startsWith('/proxy')).toBe(false);
    }
  });

  it.each(PROXY_PATHS)(
    'should redirect an unauthenticated browser request for %s to /login',
    async (pathname) => {
      await enableAuth();

      const { middleware } = await import('@/middleware');
      const res = await middleware(createMockRequest(pathname) as never);

      expect(res.status).toBe(302);
    }
  );

  it('should 401 an unauthenticated /proxy request that carries an Authorization header', async () => {
    await enableAuth();

    const { middleware } = await import('@/middleware');
    const res = await middleware(
      createMockRequest(
        '/proxy/testapp/api',
        {},
        { authorization: 'Bearer wrong-token' }
      ) as never
    );

    expect(res.status).toBe(401);
  });

  it('should reject a /proxy request whose auth cookie is invalid', async () => {
    await enableAuth();

    const { middleware } = await import('@/middleware');
    const res = await middleware(
      createMockRequest('/proxy/testapp/', {
        cm_auth_token: 'not-the-token',
      }) as never
    );

    expect(res.status).toBe(302);
  });

  it('should let an authenticated /proxy request through', async () => {
    const token = await enableAuth();

    const { middleware } = await import('@/middleware');
    const res = await middleware(
      createMockRequest('/proxy/testapp/try/', { cm_auth_token: token }) as never
    );

    expect(res.status).toBe(200);
  });

  it('should not let a forged x-cm-raw-url header change the authentication outcome', async () => {
    await enableAuth();

    const { middleware } = await import('@/middleware');
    const res = await middleware(
      createMockRequest(
        '/proxy/testapp/',
        {},
        { 'x-cm-raw-url': '/login' }
      ) as never
    );

    // The header is not part of routing or auth: still unauthenticated.
    expect(res.status).toBe(302);
  });

  it.each(PROXY_PATHS)(
    'should deny %s from a disallowed IP even before auth runs',
    async (pathname) => {
      process.env.CM_ALLOWED_IPS = '10.0.0.0/8';
      vi.resetModules();
      process.env.CM_ALLOWED_IPS = '10.0.0.0/8';

      const { middleware } = await import('@/middleware');
      const res = await middleware(
        createMockRequest(pathname, {}, { 'x-real-ip': '203.0.113.9' }) as never
      );

      expect(res.status).toBe(403);
    }
  );

  it('should allow a /proxy request from an allowed IP when auth is off', async () => {
    process.env.CM_ALLOWED_IPS = '127.0.0.1/32';
    vi.resetModules();
    process.env.CM_ALLOWED_IPS = '127.0.0.1/32';

    const { middleware } = await import('@/middleware');
    const res = await middleware(
      createMockRequest('/proxy/testapp/', {}, { 'x-real-ip': '127.0.0.1' }) as never
    );

    expect(res.status).toBe(200);
  });

  it('should keep /proxy/ inside the middleware matcher', async () => {
    const { config } = await import('@/middleware');

    const matchers = config.matcher;
    expect(matchers.length).toBeGreaterThan(0);

    for (const pathname of PROXY_PATHS) {
      const matched = matchers.some((pattern) =>
        new RegExp(`^${pattern}$`).test(pathname)
      );
      expect(matched).toBe(true);
    }
  });
});
