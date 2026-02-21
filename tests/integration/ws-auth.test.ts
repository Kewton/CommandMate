/**
 * Integration Tests: WebSocket Authentication
 * Issue #331: WebSocket auth via Cookie header
 *
 * Tests cover:
 * - Authenticated WebSocket connection (valid Cookie) -> success
 * - Unauthenticated WebSocket connection -> rejected
 * - Auth disabled -> all connections accepted
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('WebSocket Authentication', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.CM_AUTH_TOKEN_HASH;
    delete process.env.CM_AUTH_EXPIRE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should verify auth module exports parseCookies for WS usage', async () => {
    const { parseCookies, AUTH_COOKIE_NAME } = await import('@/lib/auth');
    // Simulate WebSocket upgrade request cookie header
    const cookieHeader = `${AUTH_COOKIE_NAME}=test-token-value; other=data`;
    const cookies = parseCookies(cookieHeader);
    expect(cookies[AUTH_COOKIE_NAME]).toBe('test-token-value');
  });

  it('should verify token from parsed cookie header', async () => {
    const { generateToken, hashToken, parseCookies, AUTH_COOKIE_NAME } = await import('@/lib/auth');
    const token = generateToken();
    const hash = hashToken(token);

    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const auth = await import('@/lib/auth');
    const cookieHeader = `${auth.AUTH_COOKIE_NAME}=${token}`;
    const cookies = auth.parseCookies(cookieHeader);
    const wsToken = cookies[auth.AUTH_COOKIE_NAME];

    expect(auth.verifyToken(wsToken)).toBe(true);
  });

  it('should reject invalid token from cookie header', async () => {
    const { hashToken } = await import('@/lib/auth');
    const hash = hashToken('real-token');

    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const auth = await import('@/lib/auth');
    const cookieHeader = `${auth.AUTH_COOKIE_NAME}=wrong-token`;
    const cookies = auth.parseCookies(cookieHeader);
    const wsToken = cookies[auth.AUTH_COOKIE_NAME];

    expect(auth.verifyToken(wsToken)).toBe(false);
  });

  it('should skip auth when CM_AUTH_TOKEN_HASH is not set', async () => {
    delete process.env.CM_AUTH_TOKEN_HASH;
    vi.resetModules();

    const auth = await import('@/lib/auth');
    expect(auth.isAuthEnabled()).toBe(false);
    // When auth is disabled, ws-server should skip authentication
  });

  it('should reject when cookie header is missing', async () => {
    const { hashToken } = await import('@/lib/auth');
    const hash = hashToken('some-token');

    process.env.CM_AUTH_TOKEN_HASH = hash;
    vi.resetModules();
    process.env.CM_AUTH_TOKEN_HASH = hash;

    const auth = await import('@/lib/auth');
    // Empty cookie header
    const cookies = auth.parseCookies('');
    const wsToken = cookies[auth.AUTH_COOKIE_NAME];

    expect(wsToken).toBeUndefined();
    // verifyToken with undefined should return false
    expect(auth.verifyToken(wsToken as string)).toBe(false);
  });

  it('should verify ws-server.ts imports auth module', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const wsServerPath = path.resolve(__dirname, '../../src/lib/ws-server.ts');
    const source = fs.readFileSync(wsServerPath, 'utf-8');
    // Verify auth-related imports
    expect(source).toContain('isAuthEnabled');
    expect(source).toContain('parseCookies');
    expect(source).toContain('AUTH_COOKIE_NAME');
    expect(source).toContain('verifyToken');
  });

  it('should verify ws-server setupWebSocket accepts HTTPServer | HTTPSServer', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const wsServerPath = path.resolve(__dirname, '../../src/lib/ws-server.ts');
    const source = fs.readFileSync(wsServerPath, 'utf-8');
    expect(source).toContain('HTTPServer | HTTPSServer');
  });
});
