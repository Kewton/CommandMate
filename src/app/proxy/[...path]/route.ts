/**
 * Proxy Route Handler
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * Handles all proxy requests to external apps:
 * GET|POST|PUT|PATCH|DELETE /proxy/{pathPrefix}/*
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getExternalAppCache } from '@/lib/external-apps/cache';
import { proxyHttp, proxyWebSocket, isWebSocketUpgrade } from '@/lib/proxy/handler';
import { logProxyRequest, logProxyError } from '@/lib/proxy/logger';
import { PROXY_ERROR_MESSAGES, PROXY_RAW_URL_HEADER } from '@/lib/proxy/config';
import type { ProxyLogEntry } from '@/lib/proxy/logger';

// Force dynamic rendering
export const dynamic = 'force-dynamic';

/**
 * Resolve the paths used for upstream forwarding and for logging.
 *
 * Issue #1802: Next.js catch-all params (`params.path`) are percent-decoded and
 * carry neither the trailing slash nor the query string, so rebuilding the path
 * with `pathSegments.join('/')` structurally drops all three. The path must come
 * from the request URL instead.
 *
 * Issue #1804: `request.url` is good enough for the pathname (preserved
 * byte-for-byte) but NOT for the query string. Next.js re-serializes the query
 * before an App Router route handler ever runs, so `?q=a%20b` arrives here as
 * `?q=a+b` and `?bare` as `?bare=` - the signature of a URLSearchParams
 * round-trip - which breaks any upstream that verifies a signature over the
 * query bytes (HMAC-signed URLs, presigned URLs, OAuth 1.0a). That
 * normalization happens in a layer this handler cannot reach.
 *
 * So the raw request target is captured one layer earlier instead: `server.ts`
 * copies the Node `IncomingMessage.req.url` - the untouched request target -
 * into {@link PROXY_RAW_URL_HEADER} before handing the request to Next. When
 * that header is present it is authoritative; the header is safe to trust
 * because `server.ts` deletes it unconditionally on every request before
 * setting it, so a client-supplied value never survives.
 *
 * The raw target is split on the FIRST `?` rather than parsed with `new URL()`:
 * WHATWG parsing drops a bare trailing `?` (`/x?` -> `/x`, since `search` is
 * the empty string in that case), and string splitting also guarantees the
 * query bytes are passed through with no interpretation at all.
 *
 * KNOWN LIMIT (measured, Issue #1804): a bare trailing `?` still does not reach
 * the upstream, but no longer because of anything in this file - it survives to
 * `proxyHttp`, and Node's `fetch()` drops it when it serializes the URL back to
 * a request target (undici uses `pathname + search`, and `search` is `''` for
 * `http://x/a?` even though `href` keeps the `?`). Verified against an echo
 * upstream: `fetch('http://127.0.0.1:PORT/a/?')` is received as `/a/`. Every
 * other query form measured is byte-exact. Fixing this last case would mean
 * replacing the proxy transport with `http.request`, which also gives up
 * undici's transparent gzip handling - not worth it for a delimiter that
 * denotes an empty query either way.
 *
 * Without the header (running under `next dev` with no custom server, or in a
 * unit test that builds its own `Request`) this falls back to `request.url`,
 * preserving the Issue #1802 behavior.
 *
 * The forwarded path carries the query string; the logged path deliberately
 * does not, because query strings may carry tokens and Issue #395 requires
 * that such internals stay out of logs.
 *
 * @param request - The incoming request
 * @returns The upstream path (pathname + search) and the log-safe path
 */
function resolveProxyPaths(request: Request): {
  upstreamPath: string;
  logPath: string;
} {
  const rawUrl = request.headers.get(PROXY_RAW_URL_HEADER);
  if (rawUrl) {
    const queryStart = rawUrl.indexOf('?');
    const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
    return { upstreamPath: rawUrl, logPath: pathname };
  }

  const { pathname, search } = new URL(request.url);
  return { upstreamPath: pathname + search, logPath: pathname };
}

/**
 * Handle proxy request for any HTTP method
 */
async function handleProxy(
  request: Request,
  pathSegments: string[]
): Promise<Response> {
  const startTime = Date.now();
  const method = request.method;

  // Extract path prefix for app lookup from the decoded segments; the DB stores
  // pathPrefix as a plain decoded string, so segment[0] is the right key here.
  const [pathPrefix] = pathSegments;

  // Issue #1802/#1804: forward the raw request target (trailing slash, percent-
  // encoding and query bytes intact); log without the query string.
  const { upstreamPath: path, logPath } = resolveProxyPaths(request);

  // Handle empty path prefix
  if (!pathPrefix) {
    return NextResponse.json(
      { error: 'Path prefix is required' },
      { status: 400 }
    );
  }

  try {
    // Get database and cache
    const db = getDbInstance();
    const cache = getExternalAppCache(db);

    // Look up the external app by path prefix
    const app = await cache.getByPathPrefix(pathPrefix);

    if (!app) {
      // Issue #395: Fixed-string error message; do not expose pathPrefix
      return NextResponse.json(
        { error: 'No external app found for the requested path' },
        { status: 404 }
      );
    }

    if (!app.enabled) {
      // Issue #395: Fixed-string error message; do not expose app.displayName
      return NextResponse.json(
        { error: 'The requested external app is currently disabled' },
        { status: 503 }
      );
    }

    // Issue #671: WebSocket upgrades are handled in src/lib/ws-server.ts's
    // HTTP 'upgrade' event listener before Next.js sees them. This branch is a
    // defense-in-depth fallback that returns 426 in the unexpected case where a
    // WebSocket upgrade bypasses the upgrade listener and arrives here.
    if (isWebSocketUpgrade(request)) {
      const response = await proxyWebSocket(request, app, path);

      // Log the WebSocket request
      const logEntry: ProxyLogEntry = {
        timestamp: Date.now(),
        pathPrefix,
        method,
        path: logPath,
        statusCode: response.status,
        responseTime: Date.now() - startTime,
        isWebSocket: true,
      };
      logProxyRequest(logEntry);

      return response;
    }

    // Proxy HTTP request
    const response = await proxyHttp(request, app, path);

    // Log the request
    const logEntry: ProxyLogEntry = {
      timestamp: Date.now(),
      pathPrefix,
      method,
      path: logPath,
      statusCode: response.status,
      responseTime: Date.now() - startTime,
      isWebSocket: false,
    };

    if (response.status >= 400) {
      logEntry.error = `HTTP ${response.status}`;
    }

    logProxyRequest(logEntry);

    return response;
  } catch (error) {
    logProxyError(pathPrefix, method, logPath, error as Error);

    // Issue #395: Fixed-string error message; do not expose internal error details
    return NextResponse.json(
      { error: 'Proxy error', message: PROXY_ERROR_MESSAGES.BAD_GATEWAY },
      { status: 502 }
    );
  }
}

/**
 * GET /proxy/[...path]
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return handleProxy(request, path);
}

/**
 * HEAD /proxy/[...path]
 *
 * Issue #671: Mirror of GET so upstream apps (e.g. Streamlit) that issue HEAD
 * probes against their own static assets succeed. proxyHttp already skips the
 * body for GET and HEAD requests.
 */
export async function HEAD(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return handleProxy(request, path);
}

/**
 * POST /proxy/[...path]
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return handleProxy(request, path);
}

/**
 * PUT /proxy/[...path]
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return handleProxy(request, path);
}

/**
 * PATCH /proxy/[...path]
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return handleProxy(request, path);
}

/**
 * DELETE /proxy/[...path]
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return handleProxy(request, path);
}
