/**
 * HTTP Proxy Handler Tests
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 * Issue #42: Proxy routing for multiple frontend applications
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExternalApp } from '@/types/external-apps';

// Mock http-proxy
vi.mock('http-proxy', () => ({
  default: {
    createProxyServer: vi.fn(() => ({
      web: vi.fn(),
      ws: vi.fn(),
      on: vi.fn(),
    })),
  },
}));

describe('HTTP Proxy Handler', () => {
  const createMockApp = (overrides?: Partial<ExternalApp>): ExternalApp => ({
    id: 'test-app-id',
    name: 'test-app',
    displayName: 'Test App',
    pathPrefix: 'test',
    targetPort: 3000,
    targetHost: 'localhost',
    appType: 'nextjs',
    websocketEnabled: false,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('proxyHttp', () => {
    it('should proxy GET request to upstream', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({ targetPort: 5173 });
      const request = new Request('http://localhost:3000/proxy/test/page', {
        method: 'GET',
      });

      // Mock fetch for testing
      global.fetch = vi.fn().mockResolvedValue(
        new Response('Hello from upstream', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const response = await proxyHttp(request, mockApp, '/page');

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
    });

    it('should proxy POST request with body', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({ targetPort: 8501 });
      const request = new Request('http://localhost:3000/proxy/test/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' }),
      });

      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const response = await proxyHttp(request, mockApp, '/api/data');

      expect(response.status).toBe(201);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:8501'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should forward request headers', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp();
      const request = new Request('http://localhost:3000/proxy/test/api', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'custom-value',
        },
      });

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      await proxyHttp(request, mockApp, '/api');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.any(Headers),
        })
      );
    });

    it('should return 502 on upstream connection failure', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({ targetPort: 9999 });
      const request = new Request('http://localhost:3000/proxy/test/page');

      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const response = await proxyHttp(request, mockApp, '/page');

      expect(response.status).toBe(502);
    });

    it('should return 504 on timeout', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp();
      const request = new Request('http://localhost:3000/proxy/test/page');

      global.fetch = vi.fn().mockRejectedValue(
        Object.assign(new Error('timeout'), { name: 'TimeoutError' })
      );

      const response = await proxyHttp(request, mockApp, '/page');

      expect(response.status).toBe(504);
    });

    it('should construct correct upstream URL', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({
        targetHost: '127.0.0.1',
        targetPort: 5173,
        pathPrefix: 'app-svelte',
      });
      const request = new Request('http://localhost:3000/proxy/app-svelte/nested/page?query=1');

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      await proxyHttp(request, mockApp, '/nested/page?query=1');

      // buildUpstreamUrl strips the proxy prefix and forwards to upstream's root
      // This allows upstream apps to work without special basePath configuration
      expect(global.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5173/nested/page?query=1',
        expect.any(Object)
      );
    });
  });

  describe('proxyWebSocket', () => {
    it('should return 426 Upgrade Required (WebSocket not supported in Route Handlers)', async () => {
      const { proxyWebSocket } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({ websocketEnabled: true });
      const request = new Request('http://localhost:3000/proxy/test/_stcore/stream', {
        headers: { Upgrade: 'websocket' },
      });

      const response = await proxyWebSocket(request, mockApp, '/_stcore/stream');

      // Next.js Route Handlers do not support WebSocket upgrade
      // Return 426 to indicate upgrade is required but not supported
      expect(response.status).toBe(426);
    });

    it('should include WebSocket upgrade instructions in error response', async () => {
      const { proxyWebSocket } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({
        websocketEnabled: true,
        websocketPathPattern: '/_stcore/stream',
      });
      const request = new Request('http://localhost:3000/proxy/test/_stcore/stream', {
        headers: { Upgrade: 'websocket' },
      });

      const response = await proxyWebSocket(request, mockApp, '/_stcore/stream');
      const body = await response.json();

      expect(body).toHaveProperty('error');
      expect(body.message).toContain('WebSocket');
    });
  });

  describe('isWebSocketUpgrade', () => {
    it('should detect WebSocket upgrade request', async () => {
      const { isWebSocketUpgrade } = await import('@/lib/proxy/handler');

      const request = new Request('http://localhost:3000/proxy/test/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
        },
      });

      expect(isWebSocketUpgrade(request)).toBe(true);
    });

    it('should return false for regular HTTP request', async () => {
      const { isWebSocketUpgrade } = await import('@/lib/proxy/handler');

      const request = new Request('http://localhost:3000/proxy/test/page', {
        headers: { 'Content-Type': 'text/html' },
      });

      expect(isWebSocketUpgrade(request)).toBe(false);
    });
  });

  describe('buildUpstreamUrl', () => {
    // buildUpstreamUrl strips the proxy prefix and forwards to upstream's root
    // This allows upstream apps to work without special basePath configuration

    it('should build URL with host and port', async () => {
      const { buildUpstreamUrl } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({
        targetHost: 'localhost',
        targetPort: 5173,
        pathPrefix: 'app-svelte',
      });

      const url = buildUpstreamUrl(mockApp, '/page');

      // Path is forwarded directly to upstream without proxy prefix
      expect(url).toBe('http://localhost:5173/page');
    });

    it('should handle paths with query strings', async () => {
      const { buildUpstreamUrl } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({
        targetHost: '127.0.0.1',
        targetPort: 8501,
        pathPrefix: 'streamlit',
      });

      const url = buildUpstreamUrl(mockApp, '/api?key=value&other=123');

      // Query strings are preserved, proxy prefix is stripped
      expect(url).toBe('http://127.0.0.1:8501/api?key=value&other=123');
    });

    it('should handle root path', async () => {
      const { buildUpstreamUrl } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({
        targetHost: 'localhost',
        targetPort: 3001,
        pathPrefix: 'app-next2',
      });

      const url = buildUpstreamUrl(mockApp, '/');

      // Root path is forwarded as-is
      expect(url).toBe('http://localhost:3001/');
    });
  });
});
