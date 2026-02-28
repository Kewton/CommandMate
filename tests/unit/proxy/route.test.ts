/**
 * Proxy Route Handler Integration Tests
 * Issue #376: Verify pathPrefix is preserved when proxying to upstream
 *
 * Tests the handleProxy() function through the exported HTTP method handlers
 * to ensure the full path including /proxy/{pathPrefix}/... is forwarded
 * to upstream applications.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing route module
vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/external-apps/cache', () => ({
  getExternalAppCache: vi.fn(() => ({
    getByPathPrefix: vi.fn(),
  })),
}));

vi.mock('@/lib/proxy/handler', () => ({
  proxyHttp: vi.fn(),
  proxyWebSocket: vi.fn(),
  isWebSocketUpgrade: vi.fn(() => false),
}));

vi.mock('@/lib/proxy/logger', () => ({
  logProxyRequest: vi.fn(),
  logProxyError: vi.fn(),
}));

/** Create a mock external app for testing */
function createMockApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-id',
    name: 'testapp',
    displayName: 'Test App',
    pathPrefix: 'testapp',
    targetPort: 3001,
    targetHost: 'localhost',
    appType: 'nextjs',
    websocketEnabled: false,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Set up mocks for a standard proxy test: cache returns the given app, proxyHttp returns 200 */
async function setupProxyMocks(mockApp: ReturnType<typeof createMockApp>) {
  const { getExternalAppCache } = await import('@/lib/external-apps/cache');
  const { proxyHttp, isWebSocketUpgrade } = await import('@/lib/proxy/handler');
  const { logProxyRequest } = await import('@/lib/proxy/logger');

  vi.mocked(getExternalAppCache).mockReturnValue({
    getByPathPrefix: vi.fn().mockResolvedValue(mockApp),
    refresh: vi.fn(),
    getAll: vi.fn(),
    invalidate: vi.fn(),
    invalidateByIssueNo: vi.fn(),
  } as never);

  vi.mocked(isWebSocketUpgrade).mockReturnValue(false);
  vi.mocked(proxyHttp).mockResolvedValue(new Response('OK', { status: 200 }));

  return { proxyHttp, logProxyRequest };
}

describe('Proxy Route Handler - pathPrefix preservation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should preserve pathPrefix when proxying to upstream', async () => {
    const mockApp = createMockApp({
      name: 'localllmtest',
      displayName: 'Local LLM Test',
      pathPrefix: 'localllmtest',
      targetPort: 3012,
    });
    const { proxyHttp, logProxyRequest } = await setupProxyMocks(mockApp);

    const { GET } = await import('@/app/proxy/[...path]/route');

    const request = new Request('http://localhost:3000/proxy/localllmtest/page');
    const response = await GET(request, {
      params: Promise.resolve({ path: ['localllmtest', 'page'] }),
    });

    expect(response.status).toBe(200);

    // Verify proxyHttp was called with full path including proxy prefix
    expect(proxyHttp).toHaveBeenCalledWith(
      request,
      mockApp,
      '/proxy/localllmtest/page'
    );

    // Verify logProxyRequest was called
    expect(logProxyRequest).toHaveBeenCalledTimes(1);
  });

  it('should handle root path with pathPrefix', async () => {
    const mockApp = createMockApp({
      name: 'myapp',
      displayName: 'My App',
      pathPrefix: 'myapp',
    });
    const { proxyHttp } = await setupProxyMocks(mockApp);

    const { GET } = await import('@/app/proxy/[...path]/route');

    const request = new Request('http://localhost:3000/proxy/myapp');
    await GET(request, {
      params: Promise.resolve({ path: ['myapp'] }),
    });

    // For root path (only pathPrefix, no additional segments),
    // the path should be /proxy/myapp
    expect(proxyHttp).toHaveBeenCalledWith(
      request,
      mockApp,
      '/proxy/myapp'
    );
  });

  it('should pass correct path to logProxyRequest', async () => {
    const mockApp = createMockApp({
      name: 'localllmtest',
      displayName: 'Local LLM Test',
      pathPrefix: 'localllmtest',
      targetPort: 3012,
    });
    const { logProxyRequest } = await setupProxyMocks(mockApp);

    const { GET } = await import('@/app/proxy/[...path]/route');

    const request = new Request('http://localhost:3000/proxy/localllmtest/page');
    await GET(request, {
      params: Promise.resolve({ path: ['localllmtest', 'page'] }),
    });

    // Verify logProxyRequest receives the correct path with proxy prefix
    expect(logProxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/proxy/localllmtest/page',
        pathPrefix: 'localllmtest',
        method: 'GET',
      })
    );
  });

  it('should handle deep nested path with pathPrefix', async () => {
    const mockApp = createMockApp({
      name: 'app',
      displayName: 'App',
      pathPrefix: 'app',
    });
    const { proxyHttp } = await setupProxyMocks(mockApp);

    const { GET } = await import('@/app/proxy/[...path]/route');

    const request = new Request('http://localhost:3000/proxy/app/a/b/c');
    await GET(request, {
      params: Promise.resolve({ path: ['app', 'a', 'b', 'c'] }),
    });

    expect(proxyHttp).toHaveBeenCalledWith(
      request,
      mockApp,
      '/proxy/app/a/b/c'
    );
  });
});
