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
vi.mock('@/lib/db/db-instance', () => ({
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

  // Issue #671: HEAD method support for proxy route
  it('should proxy HEAD request through handleProxy', async () => {
    const mockApp = createMockApp({
      name: 'headtest',
      displayName: 'HEAD Test',
      pathPrefix: 'headtest',
      targetPort: 3013,
    });
    const { proxyHttp, logProxyRequest } = await setupProxyMocks(mockApp);

    const route = await import('@/app/proxy/[...path]/route');
    expect(typeof route.HEAD).toBe('function');

    const request = new Request('http://localhost:3000/proxy/headtest/page', {
      method: 'HEAD',
    });
    const response = await route.HEAD(request, {
      params: Promise.resolve({ path: ['headtest', 'page'] }),
    });

    expect(response.status).toBe(200);
    expect(proxyHttp).toHaveBeenCalledWith(
      request,
      mockApp,
      '/proxy/headtest/page'
    );
    expect(logProxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'HEAD',
        pathPrefix: 'headtest',
        path: '/proxy/headtest/page',
      })
    );
  });
});

/**
 * Issue #1802: The upstream path must be taken from the request URL, not
 * rebuilt from `params.path`. Next.js catch-all params are percent-decoded and
 * carry neither the trailing slash nor the query string, so every case below
 * passes params in the shape Next.js would actually produce (decoded, no
 * trailing slash, no search) while the request URL holds the raw form.
 *
 * SCOPE LIMIT - do not read these green tests as proof of end-to-end byte
 * preservation of the query string. These tests build the `Request` themselves,
 * so they exercise only the route handler layer and skip the normalization
 * Next.js performs on `request.url` before the handler runs. That normalization
 * is not reproducible in a unit test and cannot be undone from inside an App
 * Router route handler. Measured end-to-end through a real CommandMate server
 * against an echo upstream:
 *
 *   PATH - preserved byte-for-byte
 *     /proxy/testapp/a%20b/              -> /proxy/testapp/a%20b/
 *     /proxy/testapp/a%2Fb/              -> /proxy/testapp/a%2Fb/
 *     /proxy/testapp/%E6%97%A5%E6%9C%AC/ -> /proxy/testapp/%E6%97%A5%E6%9C%AC/
 *     /proxy/testapp/a+b/                -> /proxy/testapp/a+b/
 *
 *   QUERY - normalized by Next.js before the handler (URLSearchParams round-trip)
 *     ?q=a%20b&n=1          -> ?q=a+b&n=1        (%20 becomes +)
 *     ?bare                 -> ?bare=            (valueless key gains =)
 *     ?q=a%2Bb              -> ?q=a%2Bb          (preserved)
 *     ?q=a%26b              -> ?q=a%26b          (preserved)
 *     ?sig=aGVsbG8%3D       -> ?sig=aGVsbG8%3D   (preserved)
 *     ?q=%E6%97%A5%E6%9C%AC -> ?q=%E6%97%A5%E6%9C%AC (preserved)
 *
 * A bare `?` also collapses (`/x?` -> `/x`), since WHATWG `URL.search` is the
 * empty string in that case. What these tests do prove is that the handler
 * forwards whatever pathname and search it was handed, without rewriting them.
 *
 * Issue #1804 later routed AROUND that normalization rather than undoing it:
 * `server.ts` copies the raw `req.url` into `x-cm-raw-url` before Next sees the
 * request, and the handler prefers it when present. This block deliberately
 * sends no such header, so it now also pins the fallback path that `next dev`
 * without the custom server takes. The #1804 block at the bottom of this file
 * covers the header path.
 */
describe('Proxy Route Handler - trailing slash and query string preservation (Issue #1802)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Run a proxy request and return the path handed to proxyHttp */
  async function proxyAndGetPath(
    url: string,
    params: string[],
    method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET'
  ) {
    const mockApp = createMockApp();
    const { proxyHttp, logProxyRequest } = await setupProxyMocks(mockApp);

    const route = await import('@/app/proxy/[...path]/route');

    const hasBody = method !== 'GET' && method !== 'HEAD';
    const request = new Request(url, {
      method,
      ...(hasBody ? { body: 'payload' } : {}),
    });
    const response = await route[method](request, {
      params: Promise.resolve({ path: params }),
    });

    const call = vi.mocked(proxyHttp).mock.calls[0];
    return {
      response,
      mockApp,
      request,
      path: call?.[2],
      logProxyRequest,
      proxyHttp,
    };
  }

  it('should preserve the trailing slash of a sub path', async () => {
    const { path, response } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/try/',
      ['testapp', 'try']
    );

    expect(path).toBe('/proxy/testapp/try/');
    expect(response.status).toBe(200);
  });

  it('should forward a sub path without a trailing slash unchanged', async () => {
    const { path } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/try',
      ['testapp', 'try']
    );

    expect(path).toBe('/proxy/testapp/try');
  });

  it('should preserve the trailing slash of the app root path', async () => {
    const { path } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/',
      ['testapp']
    );

    expect(path).toBe('/proxy/testapp/');
  });

  it('should forward the app root path without a trailing slash unchanged', async () => {
    const { path } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp',
      ['testapp']
    );

    expect(path).toBe('/proxy/testapp');
  });

  it('should append the received search string to the forwarded path without rewriting it', async () => {
    const { path } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/search?q=a%20b&n=1',
      ['testapp', 'search']
    );

    // The handler concatenates the search it was given; it does not re-encode.
    // Note that a real request would already have arrived as ?q=a+b - Next.js
    // normalizes the query before this layer (see the SCOPE LIMIT note above),
    // so this asserts only that the handler itself adds no further rewriting.
    expect(path).toBe('/proxy/testapp/search?q=a%20b&n=1');
    expect(path).not.toContain('+');
    expect(path).not.toContain('a b');
  });

  it('should keep a trailing slash and the query string together', async () => {
    const { path } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/try/?q=a%20b&n=1',
      ['testapp', 'try']
    );

    expect(path).toBe('/proxy/testapp/try/?q=a%20b&n=1');
  });

  it('should not decode percent-encoded path segments (%2F stays encoded)', async () => {
    // Next.js would hand us the decoded segment 'a/b', which would rebuild into
    // a structurally different path (/proxy/testapp/a/b).
    const { path } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/a%2Fb/',
      ['testapp', 'a/b']
    );

    expect(path).toBe('/proxy/testapp/a%2Fb/');
  });

  it('should preserve percent-encoded multibyte (Japanese) path segments', async () => {
    const { path } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/%E6%97%A5%E6%9C%AC%E8%AA%9E/',
      ['testapp', '日本語']
    );

    expect(path).toBe('/proxy/testapp/%E6%97%A5%E6%9C%AC%E8%AA%9E/');
  });

  it('should preserve the trailing slash on a deep nested path', async () => {
    const { path } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/a/b/c/?x=1',
      ['testapp', 'a', 'b', 'c']
    );

    expect(path).toBe('/proxy/testapp/a/b/c/?x=1');
  });

  it('should preserve the trailing slash and query string for HEAD requests', async () => {
    const { path } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/assets/?v=1',
      ['testapp', 'assets'],
      'HEAD'
    );

    expect(path).toBe('/proxy/testapp/assets/?v=1');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'should preserve the trailing slash and query string for %s requests',
    async (method) => {
      const { path } = await proxyAndGetPath(
        'http://localhost:3000/proxy/testapp/items/?page=2',
        ['testapp', 'items'],
        method
      );

      expect(path).toBe('/proxy/testapp/items/?page=2');
    }
  );

  it('should log the path without the query string (Issue #395)', async () => {
    const { logProxyRequest } = await proxyAndGetPath(
      'http://localhost:3000/proxy/testapp/search?token=secret&q=a%20b',
      ['testapp', 'search']
    );

    expect(logProxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/proxy/testapp/search',
        pathPrefix: 'testapp',
        method: 'GET',
      })
    );
    const entry = vi.mocked(logProxyRequest).mock.calls[0][0];
    expect(entry.path).not.toContain('token');
  });

  it('should still return 400 for an empty path prefix without proxying', async () => {
    const mockApp = createMockApp();
    const { proxyHttp } = await setupProxyMocks(mockApp);

    const { GET } = await import('@/app/proxy/[...path]/route');

    const request = new Request('http://localhost:3000/proxy/');
    const response = await GET(request, {
      params: Promise.resolve({ path: [] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Path prefix is required',
    });
    expect(proxyHttp).not.toHaveBeenCalled();
  });

  it('should hand the same raw path to the WebSocket fallback and still return 426', async () => {
    const mockApp = createMockApp({ websocketEnabled: true });
    await setupProxyMocks(mockApp);

    const { isWebSocketUpgrade, proxyWebSocket } = await import(
      '@/lib/proxy/handler'
    );
    vi.mocked(isWebSocketUpgrade).mockReturnValue(true);
    vi.mocked(proxyWebSocket).mockResolvedValue(
      new Response('Upgrade Required', { status: 426 })
    );

    const { GET } = await import('@/app/proxy/[...path]/route');

    const request = new Request('http://localhost:3000/proxy/testapp/ws/?v=1', {
      headers: { upgrade: 'websocket' },
    });
    const response = await GET(request, {
      params: Promise.resolve({ path: ['testapp', 'ws'] }),
    });

    expect(response.status).toBe(426);
    expect(proxyWebSocket).toHaveBeenCalledWith(
      request,
      mockApp,
      '/proxy/testapp/ws/?v=1'
    );
  });
});

/**
 * Issue #1804: byte-exact query forwarding via the raw request target.
 *
 * `request.url` reaches an App Router route handler only after Next.js has
 * re-serialized the query string, so `?q=a%20b` becomes `?q=a+b` and `?bare`
 * becomes `?bare=`. server.ts stashes the untouched `req.url` in `x-cm-raw-url`
 * before handing the request to Next; these tests fix the handler's half of
 * that contract by supplying the header directly.
 *
 * SCOPE LIMIT - as with the #1802 block above, these tests build their own
 * `Request`, so they prove the handler prefers and forwards the raw target
 * verbatim. They do NOT prove server.ts sets the header (see
 * tests/unit/proxy/server-raw-url.test.ts) and they do not prove end-to-end
 * byte preservation, which was measured against a live server and an echo
 * upstream on port 3805.
 */
describe('Proxy Route Handler - raw request target forwarding (Issue #1804)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Run a proxy request whose `request.url` carries the Next.js-normalized form
   * and whose `x-cm-raw-url` header carries the raw request target.
   */
  async function proxyWithRawUrl(
    normalizedUrl: string,
    params: string[],
    rawUrl?: string,
    method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET'
  ) {
    const mockApp = createMockApp();
    const { proxyHttp, logProxyRequest } = await setupProxyMocks(mockApp);

    const route = await import('@/app/proxy/[...path]/route');

    const hasBody = method !== 'GET' && method !== 'HEAD';
    const request = new Request(normalizedUrl, {
      method,
      ...(rawUrl !== undefined ? { headers: { 'x-cm-raw-url': rawUrl } } : {}),
      ...(hasBody ? { body: 'payload' } : {}),
    });
    const response = await route[method](request, {
      params: Promise.resolve({ path: params }),
    });

    const call = vi.mocked(proxyHttp).mock.calls[0];
    return { response, path: call?.[2], logProxyRequest, proxyHttp };
  }

  it('should forward %20 in the query verbatim instead of the normalized +', async () => {
    const { path, response } = await proxyWithRawUrl(
      // What Next.js hands the handler after its URLSearchParams round-trip...
      'http://localhost:3000/proxy/testapp/search?q=a+b&n=1',
      ['testapp', 'search'],
      // ...and what the client actually sent.
      '/proxy/testapp/search?q=a%20b&n=1'
    );

    expect(path).toBe('/proxy/testapp/search?q=a%20b&n=1');
    expect(path).not.toContain('a+b');
    expect(response.status).toBe(200);
  });

  it('should forward a valueless key without appending =', async () => {
    const { path } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/search?bare=',
      ['testapp', 'search'],
      '/proxy/testapp/search?bare'
    );

    expect(path).toBe('/proxy/testapp/search?bare');
    expect(path).not.toContain('bare=');
  });

  it('should preserve a bare ? with no query string', async () => {
    // `new URL('http://x/proxy/testapp/search/?').search` is '' - the WHATWG
    // parser drops the delimiter - so the raw target must be split on the first
    // '?' as a string rather than parsed.
    //
    // KNOWN LIMIT: this is as far as the `?` gets. proxyHttp hands the built
    // URL to fetch(), which serializes it as `pathname + search` and therefore
    // drops it on the wire. Measured: `/proxy/testapp/search/?` arrives
    // upstream as `/proxy/testapp/search/`. See the buildUpstreamUrl block in
    // tests/unit/proxy/handler.test.ts.
    const { path } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/search/',
      ['testapp', 'search'],
      '/proxy/testapp/search/?'
    );

    expect(path).toBe('/proxy/testapp/search/?');
  });

  it.each([
    ['?q=a%2Bb', '/proxy/testapp/s?q=a%2Bb'],
    ['?q=a%26b', '/proxy/testapp/s?q=a%26b'],
    ['?sig=aGVsbG8%3D', '/proxy/testapp/s?sig=aGVsbG8%3D'],
    ['?q=%E6%97%A5%E6%9C%AC', '/proxy/testapp/s?q=%E6%97%A5%E6%9C%AC'],
    ['?q=a+b', '/proxy/testapp/s?q=a+b'],
    ['?empty=', '/proxy/testapp/s?empty='],
    ['?a=1&a=2', '/proxy/testapp/s?a=1&a=2'],
  ])('should forward %s byte-for-byte', async (_label, rawUrl) => {
    const { path } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/s',
      ['testapp', 's'],
      rawUrl
    );

    expect(path).toBe(rawUrl);
  });

  it('should keep the trailing slash and the raw query together', async () => {
    const { path } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/try/?q=a+b',
      ['testapp', 'try'],
      '/proxy/testapp/try/?q=a%20b'
    );

    expect(path).toBe('/proxy/testapp/try/?q=a%20b');
  });

  it('should preserve percent-encoded path bytes carried by the raw target', async () => {
    const { path } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/a%2Fb/%E6%97%A5%E6%9C%AC/',
      ['testapp', 'a/b', '日本'],
      '/proxy/testapp/a%2Fb/%E6%97%A5%E6%9C%AC/'
    );

    expect(path).toBe('/proxy/testapp/a%2Fb/%E6%97%A5%E6%9C%AC/');
  });

  it('should prefer the raw target over request.url when the two disagree', async () => {
    const { path } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/normalized',
      ['testapp', 'normalized'],
      '/proxy/testapp/raw/'
    );

    expect(path).toBe('/proxy/testapp/raw/');
  });

  it('should fall back to request.url when the raw header is absent (next dev / unit test path)', async () => {
    const { path } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/try/?q=a+b',
      ['testapp', 'try']
      // no x-cm-raw-url
    );

    expect(path).toBe('/proxy/testapp/try/?q=a+b');
  });

  it('should fall back to request.url when the raw header is an empty string', async () => {
    const { path } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/try/',
      ['testapp', 'try'],
      ''
    );

    expect(path).toBe('/proxy/testapp/try/');
  });

  it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'should forward the raw query byte-for-byte for %s requests',
    async (method) => {
      const { path } = await proxyWithRawUrl(
        'http://localhost:3000/proxy/testapp/items/?page=2&q=a+b',
        ['testapp', 'items'],
        '/proxy/testapp/items/?page=2&q=a%20b',
        method
      );

      expect(path).toBe('/proxy/testapp/items/?page=2&q=a%20b');
    }
  );

  it('should log the raw path without its query string (Issue #395)', async () => {
    const { logProxyRequest } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/search?token=secret',
      ['testapp', 'search'],
      '/proxy/testapp/search?token=secret&sig=aGVsbG8%3D'
    );

    const entry = vi.mocked(logProxyRequest).mock.calls[0][0];
    expect(entry.path).toBe('/proxy/testapp/search');
    expect(entry.path).not.toContain('token');
    expect(entry.path).not.toContain('sig');
  });

  it('should log a bare ? path without the delimiter', async () => {
    const { logProxyRequest } = await proxyWithRawUrl(
      'http://localhost:3000/proxy/testapp/search/',
      ['testapp', 'search'],
      '/proxy/testapp/search/?'
    );

    const entry = vi.mocked(logProxyRequest).mock.calls[0][0];
    expect(entry.path).toBe('/proxy/testapp/search/');
  });

  it('should hand the raw target to the WebSocket fallback too', async () => {
    const mockApp = createMockApp({ websocketEnabled: true });
    await setupProxyMocks(mockApp);

    const { isWebSocketUpgrade, proxyWebSocket } = await import(
      '@/lib/proxy/handler'
    );
    vi.mocked(isWebSocketUpgrade).mockReturnValue(true);
    vi.mocked(proxyWebSocket).mockResolvedValue(
      new Response('Upgrade Required', { status: 426 })
    );

    const { GET } = await import('@/app/proxy/[...path]/route');

    const request = new Request('http://localhost:3000/proxy/testapp/ws/?v=a+b', {
      headers: {
        upgrade: 'websocket',
        'x-cm-raw-url': '/proxy/testapp/ws/?v=a%20b',
      },
    });
    const response = await GET(request, {
      params: Promise.resolve({ path: ['testapp', 'ws'] }),
    });

    expect(response.status).toBe(426);
    expect(proxyWebSocket).toHaveBeenCalledWith(
      request,
      mockApp,
      '/proxy/testapp/ws/?v=a%20b'
    );
  });
});
