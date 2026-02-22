/**
 * Integration Tests: Authentication Middleware
 * Issue #331: Token authentication middleware
 *
 * Tests cover:
 * - Unauthenticated request -> redirect to /login
 * - Authenticated request -> pass through
 * - Excluded paths -> pass through
 * - CM_AUTH_TOKEN_HASH unset -> immediate pass through
 * - S002: Path matching uses exact === (no startsWith bypass)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock next/server before importing middleware
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

  return {
    NextResponse: MockNextResponse,
  };
});

describe('Auth Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.CM_AUTH_TOKEN_HASH;
    delete process.env.CM_AUTH_EXPIRE;
    // Issue #332: Clean up IP restriction env vars between tests
    delete process.env.CM_ALLOWED_IPS;
    delete process.env.CM_TRUST_PROXY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createMockRequest(
    pathname: string,
    cookies: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) {
    return {
      nextUrl: {
        pathname,
        clone: () => ({
          pathname: '/login',
          toString: () => `http://localhost:3000/login`,
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

  it('should pass through when CM_AUTH_TOKEN_HASH is not set', async () => {
    delete process.env.CM_AUTH_TOKEN_HASH;
    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/');
    const res = await middleware(req as never);
    expect(res.status).toBe(200);
  });

  it('should redirect to /login for unauthenticated requests', async () => {
    const { hashToken } = await import('@/lib/auth');
    const hash = hashToken('test-token');
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/');
    const res = await middleware(req as never);
    expect(res.status).toBe(302);
  });

  it('should pass through for authenticated requests with valid cookie', async () => {
    const { generateToken, hashToken } = await import('@/lib/auth');
    const token = generateToken();
    const hash = hashToken(token);
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/', { cm_auth_token: token });
    const res = await middleware(req as never);
    expect(res.status).toBe(200);
  });

  it('should pass through for /login path (excluded)', async () => {
    const { hashToken } = await import('@/lib/auth');
    const hash = hashToken('test-token');
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/login');
    const res = await middleware(req as never);
    expect(res.status).toBe(200);
  });

  it('should pass through for /api/auth/login path (excluded)', async () => {
    const { hashToken } = await import('@/lib/auth');
    const hash = hashToken('test-token');
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/api/auth/login');
    const res = await middleware(req as never);
    expect(res.status).toBe(200);
  });

  it('should pass through for /api/auth/status path (excluded)', async () => {
    const { hashToken } = await import('@/lib/auth');
    const hash = hashToken('test-token');
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/api/auth/status');
    const res = await middleware(req as never);
    expect(res.status).toBe(200);
  });

  it('should NOT pass through for /login-bypass path (S002: exact match only)', async () => {
    const { hashToken } = await import('@/lib/auth');
    const hash = hashToken('test-token');
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/login-bypass');
    const res = await middleware(req as never);
    expect(res.status).toBe(302);
  });

  it('should redirect to /login for invalid cookie token', async () => {
    const { hashToken } = await import('@/lib/auth');
    const hash = hashToken('real-token');
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/', { cm_auth_token: 'wrong-token' });
    const res = await middleware(req as never);
    expect(res.status).toBe(302);
  });

  it('should return 401 for unauthenticated WebSocket upgrade', async () => {
    const { hashToken } = await import('@/lib/auth');
    const hash = hashToken('test-token');
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/', {}, { upgrade: 'websocket' });
    const res = await middleware(req as never);
    expect(res.status).toBe(401);
  });

  it('should pass through for authenticated WebSocket upgrade', async () => {
    const { generateToken, hashToken } = await import('@/lib/auth');
    const token = generateToken();
    const hash = hashToken(token);
    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/', { cm_auth_token: token }, { upgrade: 'websocket' });
    const res = await middleware(req as never);
    expect(res.status).toBe(200);
  });

  it('should pass through WebSocket upgrade when auth is not enabled', async () => {
    delete process.env.CM_AUTH_TOKEN_HASH;
    const { middleware } = await import('@/middleware');
    const req = createMockRequest('/', {}, { upgrade: 'websocket' });
    const res = await middleware(req as never);
    expect(res.status).toBe(200);
  });

  // ============================================================
  // Issue #332: IP Restriction Tests
  // ============================================================

  describe('IP Restriction', () => {
    it('should pass through when CM_ALLOWED_IPS is not set', async () => {
      delete process.env.CM_ALLOWED_IPS;
      const { middleware } = await import('@/middleware');
      const req = createMockRequest('/');
      const res = await middleware(req as never);
      expect(res.status).toBe(200);
    });

    it('should pass through for allowed IP', async () => {
      process.env.CM_ALLOWED_IPS = '192.168.1.0/24';
      const { middleware } = await import('@/middleware');
      const req = createMockRequest('/', {}, { 'x-real-ip': '192.168.1.100' });
      const res = await middleware(req as never);
      expect(res.status).toBe(200);
    });

    it('should return 403 for denied IP', async () => {
      process.env.CM_ALLOWED_IPS = '192.168.1.0/24';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { middleware } = await import('@/middleware');
      const req = createMockRequest('/', {}, { 'x-real-ip': '10.0.0.1' });
      const res = await middleware(req as never);
      expect(res.status).toBe(403);
      warnSpy.mockRestore();
    });

    it('should return 403 for excluded paths when IP is denied (S4-003)', async () => {
      process.env.CM_ALLOWED_IPS = '192.168.1.0/24';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { middleware } = await import('@/middleware');
      const req = createMockRequest('/login', {}, { 'x-real-ip': '10.0.0.1' });
      const res = await middleware(req as never);
      expect(res.status).toBe(403);
      warnSpy.mockRestore();
    });

    it('should return 403 when no client IP is available', async () => {
      process.env.CM_ALLOWED_IPS = '192.168.1.0/24';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { middleware } = await import('@/middleware');
      const req = createMockRequest('/');
      const res = await middleware(req as never);
      expect(res.status).toBe(403);
      warnSpy.mockRestore();
    });

    it('should use X-Forwarded-For when CM_TRUST_PROXY=true', async () => {
      process.env.CM_ALLOWED_IPS = '192.168.1.0/24';
      process.env.CM_TRUST_PROXY = 'true';
      const { middleware } = await import('@/middleware');
      const req = createMockRequest('/', {}, { 'x-forwarded-for': '192.168.1.50, 10.0.0.1' });
      const res = await middleware(req as never);
      expect(res.status).toBe(200);
    });
  });
});
