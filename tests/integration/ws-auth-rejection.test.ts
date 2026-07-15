/**
 * Integration test: WebSocket upgrade is rejected on auth failure (Issue #1120).
 *
 * Acceptance criterion: 認証失敗時にWS接続が拒否される. Spins up the real ws-server
 * with auth enabled and drives a real `ws` client end-to-end.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';

describe('WebSocket auth rejection (Issue #1120)', () => {
  const originalEnv = process.env;
  let httpServer: Server | undefined;
  let closeWs: (() => void) | undefined;

  afterEach(async () => {
    closeWs?.();
    closeWs = undefined;
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = undefined;
    }
    process.env = originalEnv;
    vi.resetModules();
  });

  async function startServerWithAuth(): Promise<{ url: string; token: string; cookieName: string }> {
    // generateToken/hashToken are env-independent, so a first import is fine here.
    const authForHash = await import('@/lib/security/auth');
    const token = authForHash.generateToken();
    const hash = authForHash.hashToken(token);

    // Auth state is captured at module import time → set env, then re-import fresh.
    process.env = { ...originalEnv, CM_AUTH_TOKEN_HASH: hash };
    delete process.env.CM_AUTH_EXPIRE;
    vi.resetModules();

    const { setupWebSocket, closeWebSocket } = await import('@/lib/ws-server');
    const auth = await import('@/lib/security/auth');
    expect(auth.isAuthEnabled()).toBe(true);

    httpServer = createServer();
    setupWebSocket(httpServer);
    closeWs = closeWebSocket;

    const url = await new Promise<string>((resolve) => {
      httpServer!.listen(0, () => {
        const addr = httpServer!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(`ws://localhost:${port}`);
      });
    });
    return { url, token, cookieName: auth.AUTH_COOKIE_NAME };
  }

  it('rejects an upgrade with no auth cookie', async () => {
    const { url } = await startServerWithAuth();
    const ws = new WebSocket(url);

    const rejected = await new Promise<boolean>((resolve) => {
      ws.on('open', () => {
        ws.close();
        resolve(false);
      });
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode === 401);
      });
      ws.on('error', () => resolve(true));
    });

    expect(rejected).toBe(true);
  });

  it('accepts an upgrade with a valid auth cookie', async () => {
    const { url, token, cookieName } = await startServerWithAuth();
    const ws = new WebSocket(url, { headers: { Cookie: `${cookieName}=${token}` } });

    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('unexpected-response', () => resolve(false));
      ws.on('error', () => resolve(false));
    });

    expect(opened).toBe(true);
  });
});
