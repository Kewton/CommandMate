/**
 * HTTP Proxy Handler
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * Provides HTTP and WebSocket proxy functionality using native fetch.
 * WebSocket support is limited in Next.js Route Handlers, so we return
 * an appropriate error response for WebSocket upgrade requests.
 *
 * @module lib/proxy/handler
 */

import type { ExternalApp } from '@/types/external-apps';
import {
  PROXY_TIMEOUT,
  HOP_BY_HOP_REQUEST_HEADERS,
  HOP_BY_HOP_RESPONSE_HEADERS,
  SENSITIVE_REQUEST_HEADERS,
  SENSITIVE_RESPONSE_HEADERS,
  PROXY_STATUS_CODES,
  PROXY_ERROR_MESSAGES,
} from './config';

/**
 * Check if a request is a WebSocket upgrade request
 *
 * @param request - The incoming request
 * @returns true if the request is a WebSocket upgrade request
 */
export function isWebSocketUpgrade(request: Request): boolean {
  const upgradeHeader = request.headers.get('upgrade');
  return upgradeHeader?.toLowerCase() === 'websocket';
}

/**
 * Build the upstream URL for the proxy request
 *
 * @param app - The external app configuration
 * @param path - The request path (including query string)
 * @returns The full upstream URL
 */
export function buildUpstreamUrl(app: ExternalApp, path: string): string {
  // Forward the full path including proxy prefix to the upstream
  // Upstream apps must be configured with basePath: '/proxy/{pathPrefix}'
  return `http://${app.targetHost}:${app.targetPort}${path}`;
}

/**
 * Filter headers by removing entries that appear in any of the exclusion lists.
 * Used to strip hop-by-hop and sensitive headers from both requests and responses.
 *
 * @param source - The source Headers to filter
 * @param exclusionLists - One or more readonly string arrays of header names to exclude
 * @returns A new Headers object with excluded headers removed
 * @internal Exported for testing
 */
export function filterHeaders(
  source: Headers,
  ...exclusionLists: readonly (readonly string[])[]
): Headers {
  const filtered = new Headers();
  source.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    const excluded = exclusionLists.some(
      (list) => list.includes(lowerKey as never)
    );
    if (!excluded) {
      filtered.set(key, value);
    }
  });
  return filtered;
}

/**
 * Proxy an HTTP request to the upstream application
 *
 * @param request - The incoming request
 * @param app - The external app configuration
 * @param path - The full request path including proxy prefix (e.g., /proxy/{pathPrefix}/page)
 * @returns The proxied response
 */
export async function proxyHttp(
  request: Request,
  app: ExternalApp,
  path: string
): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(app, path);

  // Strip hop-by-hop and sensitive headers from the request (Issue #395)
  const headers = filterHeaders(
    request.headers,
    HOP_BY_HOP_REQUEST_HEADERS,
    SENSITIVE_REQUEST_HEADERS,
  );

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT.DEFAULT_MS);

    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      signal: controller.signal,
      // @ts-expect-error - duplex is needed for streaming body
      duplex: 'half',
    });

    clearTimeout(timeoutId);

    // Strip hop-by-hop and sensitive headers from the response (Issue #395)
    const responseHeaders = filterHeaders(
      response.headers,
      HOP_BY_HOP_RESPONSE_HEADERS,
      SENSITIVE_RESPONSE_HEADERS,
    );

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof Error) {
      // Check for timeout (AbortError from AbortController or TimeoutError)
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        return new Response(
          JSON.stringify({
            error: 'Gateway Timeout',
            message: PROXY_ERROR_MESSAGES.GATEWAY_TIMEOUT,
          }),
          {
            status: PROXY_STATUS_CODES.GATEWAY_TIMEOUT,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // Connection refused or other network errors
    return new Response(
      JSON.stringify({
        error: 'Bad Gateway',
        message: PROXY_ERROR_MESSAGES.BAD_GATEWAY,
      }),
      {
        status: PROXY_STATUS_CODES.BAD_GATEWAY,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle WebSocket upgrade request
 *
 * Note: Next.js Route Handlers do not support WebSocket upgrades directly.
 * This returns a 426 Upgrade Required response with a fixed error message.
 *
 * Issue #395: Removed directUrl field and internal URL from message to prevent
 * leaking upstream host/port information to the client.
 *
 * @param request - The incoming WebSocket upgrade request (unused after Issue #395)
 * @param app - The external app configuration (unused, no longer exposed in response)
 * @param path - The full request path (unused, no longer exposed in response)
 * @returns A 426 response indicating WebSocket is not supported
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function proxyWebSocket(request: Request, app: ExternalApp, path: string): Promise<Response> {
  // Next.js Route Handlers cannot handle WebSocket upgrades
  // Issue #395: Return fixed-string response only; do not expose internal URLs
  return new Response(
    JSON.stringify({
      error: 'Upgrade Required',
      message: PROXY_ERROR_MESSAGES.UPGRADE_REQUIRED,
    }),
    {
      status: PROXY_STATUS_CODES.UPGRADE_REQUIRED,
      headers: {
        'Content-Type': 'application/json',
        'Upgrade': 'websocket',
      },
    }
  );
}
