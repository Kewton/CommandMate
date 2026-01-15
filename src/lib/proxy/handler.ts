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
  // Maintain the full path including /proxy/{pathPrefix}
  // This is because the upstream app is expected to be configured with basePath
  const fullPath = `/proxy/${app.pathPrefix}${path}`;
  return `http://${app.targetHost}:${app.targetPort}${fullPath}`;
}

/**
 * Proxy an HTTP request to the upstream application
 *
 * @param request - The incoming request
 * @param app - The external app configuration
 * @param path - The request path (after /proxy/{pathPrefix})
 * @returns The proxied response
 */
export async function proxyHttp(
  request: Request,
  app: ExternalApp,
  path: string
): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(app, path);

  // Clone headers, removing hop-by-hop headers
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    // Skip hop-by-hop headers (connection-specific headers that should not be forwarded)
    if (!HOP_BY_HOP_REQUEST_HEADERS.includes(lowerKey as typeof HOP_BY_HOP_REQUEST_HEADERS[number])) {
      headers.set(key, value);
    }
  });

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

    // Clone response headers, removing hop-by-hop headers
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      // Skip hop-by-hop headers (connection-specific headers that should not be forwarded)
      if (!HOP_BY_HOP_RESPONSE_HEADERS.includes(lowerKey as typeof HOP_BY_HOP_RESPONSE_HEADERS[number])) {
        responseHeaders.set(key, value);
      }
    });

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
 * This returns a 426 Upgrade Required response with instructions.
 *
 * @param request - The incoming WebSocket upgrade request
 * @param app - The external app configuration
 * @param path - The request path
 * @returns A 426 response indicating WebSocket is not supported
 */
export async function proxyWebSocket(
  request: Request,
  app: ExternalApp,
  path: string
): Promise<Response> {
  // Next.js Route Handlers cannot handle WebSocket upgrades
  // Return a 426 response with instructions for direct WebSocket connection
  const directWsUrl = `ws://${app.targetHost}:${app.targetPort}/proxy/${app.pathPrefix}${path}`;

  return new Response(
    JSON.stringify({
      error: 'Upgrade Required',
      message: `${PROXY_ERROR_MESSAGES.UPGRADE_REQUIRED}. Configure your WebSocket client to connect directly to ${directWsUrl}`,
      directUrl: directWsUrl,
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
