/**
 * HTTP Proxy Handler Tests
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 * Issue #42: Proxy routing for multiple frontend applications
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExternalApp } from '@/types/external-apps';
import {
  SENSITIVE_REQUEST_HEADERS,
  SENSITIVE_RESPONSE_HEADERS,
  PROXY_ERROR_MESSAGES,
} from '@/lib/proxy/config';

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

  /** Extract the Headers object passed to the mocked global.fetch call */
  function getForwardedRequestHeaders(): Headers {
    return (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Headers;
  }

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

    it('should forward request headers (safe headers only, stripping sensitive ones)', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp();
      const request = new Request('http://localhost:3000/proxy/test/api', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'custom-value',
          'Content-Type': 'application/json',
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

      // Verify sensitive headers are NOT forwarded
      const calledHeaders = getForwardedRequestHeaders();
      expect(calledHeaders.has('authorization')).toBe(false);
      // Verify safe headers ARE forwarded
      expect(calledHeaders.get('x-custom-header')).toBe('custom-value');
      expect(calledHeaders.get('content-type')).toBe('application/json');
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

      // buildUpstreamUrl forwards the full path including proxy prefix to upstream
      // Upstream apps must be configured with basePath: '/proxy/{pathPrefix}'
      expect(global.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5173/nested/page?query=1',
        expect.any(Object)
      );
    });

    it('should correctly forward path with proxy prefix to upstream', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({
        targetHost: '127.0.0.1',
        targetPort: 5173,
        pathPrefix: 'app-svelte',
      });
      const request = new Request('http://localhost:3000/proxy/app-svelte/nested/page?query=1');

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      await proxyHttp(request, mockApp, '/proxy/app-svelte/nested/page?query=1');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5173/proxy/app-svelte/nested/page?query=1',
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

    it('should include WebSocket upgrade instructions in error response without internal URL', async () => {
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
      // Issue #395: message should be the fixed constant only, no internal URL info
      expect(body.message).toBe(PROXY_ERROR_MESSAGES.UPGRADE_REQUIRED);
      // Issue #395: directUrl field must NOT be present (prevents internal URL leakage)
      expect(body).not.toHaveProperty('directUrl');
      // Ensure no internal host/port info in message
      expect(body.message).not.toContain('localhost');
      expect(body.message).not.toContain('3000');
      expect(body.message).not.toContain('ws://');
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
    // buildUpstreamUrl forwards the full path including proxy prefix to upstream
    // Upstream apps must be configured with basePath: '/proxy/{pathPrefix}'

    it('should build URL with host and port', async () => {
      const { buildUpstreamUrl } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({
        targetHost: 'localhost',
        targetPort: 5173,
        pathPrefix: 'app-svelte',
      });

      const url = buildUpstreamUrl(mockApp, '/page');

      // Path is forwarded directly to upstream including proxy prefix
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

      // Query strings are preserved with full proxy path
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

  // Issue #395: Security hardening tests
  describe('sensitive request header stripping', () => {
    const SENSITIVE_HEADERS_WITH_VALUES: Record<string, string> = {
      'cookie': 'session=abc123; token=xyz',
      'authorization': 'Bearer secret-token',
      'proxy-authorization': 'Basic cHJveHk6cGFzcw==',
      'x-forwarded-for': '192.168.1.1',
      'x-forwarded-host': 'internal.example.com',
      'x-forwarded-proto': 'https',
      'x-real-ip': '10.0.0.1',
    };

    it('should strip all 7 sensitive request headers before forwarding to upstream', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp();
      const request = new Request('http://localhost:3000/proxy/test/api', {
        method: 'GET',
        headers: {
          ...SENSITIVE_HEADERS_WITH_VALUES,
          'Accept': 'application/json',
        },
      });

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      await proxyHttp(request, mockApp, '/api');

      const calledHeaders = getForwardedRequestHeaders();

      // All 7 sensitive headers must be stripped
      for (const header of SENSITIVE_REQUEST_HEADERS) {
        expect(calledHeaders.has(header)).toBe(false);
      }
    });

    it.each([
      ['cookie', 'session=abc123'],
      ['authorization', 'Bearer token'],
      ['proxy-authorization', 'Basic cHJveHk6cGFzcw=='],
      ['x-forwarded-for', '192.168.1.1'],
      ['x-forwarded-host', 'internal.example.com'],
      ['x-forwarded-proto', 'https'],
      ['x-real-ip', '10.0.0.1'],
    ])('should strip %s header individually', async (headerName, headerValue) => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp();
      const request = new Request('http://localhost:3000/proxy/test/api', {
        method: 'GET',
        headers: { [headerName]: headerValue },
      });

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      await proxyHttp(request, mockApp, '/api');

      const calledHeaders = getForwardedRequestHeaders();
      expect(calledHeaders.has(headerName)).toBe(false);
    });
  });

  describe('safe request header forwarding (regression)', () => {
    it('should forward Content-Type, Accept, and User-Agent headers', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp();
      const request = new Request('http://localhost:3000/proxy/test/api', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({ data: 'test' }),
      });

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      await proxyHttp(request, mockApp, '/api');

      const calledHeaders = getForwardedRequestHeaders();
      expect(calledHeaders.get('content-type')).toBe('application/json');
      expect(calledHeaders.get('accept')).toBe('application/json');
      expect(calledHeaders.get('user-agent')).toBe('Mozilla/5.0');
    });

    it('should forward custom X- headers that are not in the sensitive list', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp();
      const request = new Request('http://localhost:3000/proxy/test/api', {
        method: 'GET',
        headers: {
          'X-Request-Id': 'req-123',
          'X-Custom-Header': 'my-value',
        },
      });

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      await proxyHttp(request, mockApp, '/api');

      const calledHeaders = getForwardedRequestHeaders();
      expect(calledHeaders.get('x-request-id')).toBe('req-123');
      expect(calledHeaders.get('x-custom-header')).toBe('my-value');
    });
  });

  describe('sensitive response header stripping', () => {
    it('should strip all 11 sensitive response headers from upstream response', async () => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp();
      const request = new Request('http://localhost:3000/proxy/test/api', {
        method: 'GET',
      });

      const upstreamHeaders = new Headers({
        'Content-Type': 'text/html',
        'set-cookie': 'tracking=xyz; Path=/',
        'content-security-policy': "default-src 'self'",
        'content-security-policy-report-only': "default-src 'self'",
        'x-frame-options': 'DENY',
        'strict-transport-security': 'max-age=31536000',
        'access-control-allow-origin': '*',
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'Content-Type',
        'access-control-expose-headers': 'X-Custom',
        'access-control-max-age': '86400',
      });

      global.fetch = vi.fn().mockResolvedValue(
        new Response('OK', { status: 200, headers: upstreamHeaders })
      );

      const response = await proxyHttp(request, mockApp, '/api');

      // All 11 sensitive response headers must be stripped
      for (const header of SENSITIVE_RESPONSE_HEADERS) {
        expect(response.headers.has(header)).toBe(false);
      }
      // Safe response headers should be preserved
      expect(response.headers.get('content-type')).toBe('text/html');
    });

    it.each([
      'set-cookie',
      'content-security-policy',
      'content-security-policy-report-only',
      'x-frame-options',
      'strict-transport-security',
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-expose-headers',
      'access-control-max-age',
    ])('should strip %s response header individually', async (headerName) => {
      const { proxyHttp } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp();
      const request = new Request('http://localhost:3000/proxy/test/api', {
        method: 'GET',
      });

      const upstreamHeaders = new Headers({
        'Content-Type': 'text/html',
        [headerName]: 'some-value',
      });

      global.fetch = vi.fn().mockResolvedValue(
        new Response('OK', { status: 200, headers: upstreamHeaders })
      );

      const response = await proxyHttp(request, mockApp, '/api');

      expect(response.headers.has(headerName)).toBe(false);
      expect(response.headers.get('content-type')).toBe('text/html');
    });
  });

  describe('proxyWebSocket security (Issue #395)', () => {
    it('should not include directUrl field in 426 response', async () => {
      const { proxyWebSocket } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({ websocketEnabled: true });
      const request = new Request('http://localhost:3000/proxy/test/ws', {
        headers: { Upgrade: 'websocket' },
      });

      const response = await proxyWebSocket(request, mockApp, '/ws');
      const body = await response.json();

      expect(response.status).toBe(426);
      expect(body).not.toHaveProperty('directUrl');
    });

    it('should use fixed error message without internal URL information', async () => {
      const { proxyWebSocket } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({
        websocketEnabled: true,
        targetHost: 'internal-host',
        targetPort: 9999,
      });
      const request = new Request('http://localhost:3000/proxy/test/ws', {
        headers: { Upgrade: 'websocket' },
      });

      const response = await proxyWebSocket(request, mockApp, '/ws');
      const body = await response.json();

      // Message should be the constant only
      expect(body.message).toBe(PROXY_ERROR_MESSAGES.UPGRADE_REQUIRED);
      // No internal host/port info leaked
      expect(body.message).not.toContain('internal-host');
      expect(body.message).not.toContain('9999');
      expect(body.message).not.toContain('ws://');
    });

    it('should not leak upstream app details in any field', async () => {
      const { proxyWebSocket } = await import('@/lib/proxy/handler');

      const mockApp = createMockApp({
        websocketEnabled: true,
        targetHost: 'secret-internal-host',
        targetPort: 8080,
      });
      const request = new Request('http://localhost:3000/proxy/test/ws', {
        headers: { Upgrade: 'websocket' },
      });

      const response = await proxyWebSocket(request, mockApp, '/ws');
      const bodyText = await response.text();

      expect(bodyText).not.toContain('secret-internal-host');
      expect(bodyText).not.toContain('8080');
    });
  });

  describe('config constants (Issue #395)', () => {
    it('should define SENSITIVE_REQUEST_HEADERS with all 7 headers', () => {
      expect(SENSITIVE_REQUEST_HEADERS).toHaveLength(7);
      expect(SENSITIVE_REQUEST_HEADERS).toContain('cookie');
      expect(SENSITIVE_REQUEST_HEADERS).toContain('authorization');
      expect(SENSITIVE_REQUEST_HEADERS).toContain('proxy-authorization');
      expect(SENSITIVE_REQUEST_HEADERS).toContain('x-forwarded-for');
      expect(SENSITIVE_REQUEST_HEADERS).toContain('x-forwarded-host');
      expect(SENSITIVE_REQUEST_HEADERS).toContain('x-forwarded-proto');
      expect(SENSITIVE_REQUEST_HEADERS).toContain('x-real-ip');
    });

    it('should define SENSITIVE_RESPONSE_HEADERS with all 11 headers', () => {
      expect(SENSITIVE_RESPONSE_HEADERS).toHaveLength(11);
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('set-cookie');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('content-security-policy');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('content-security-policy-report-only');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('x-frame-options');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('strict-transport-security');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('access-control-allow-origin');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('access-control-allow-credentials');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('access-control-allow-methods');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('access-control-allow-headers');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('access-control-expose-headers');
      expect(SENSITIVE_RESPONSE_HEADERS).toContain('access-control-max-age');
    });
  });
});
