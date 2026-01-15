/**
 * Proxy Route Handler
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * Handles all proxy requests to external apps:
 * GET|POST|PUT|PATCH|DELETE /proxy/{pathPrefix}/*
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getExternalAppCache } from '@/lib/external-apps/cache';
import { proxyHttp, proxyWebSocket, isWebSocketUpgrade } from '@/lib/proxy/handler';
import { logProxyRequest, logProxyError } from '@/lib/proxy/logger';
import type { ProxyLogEntry } from '@/lib/proxy/logger';

// Force dynamic rendering
export const dynamic = 'force-dynamic';

/**
 * Handle proxy request for any HTTP method
 */
async function handleProxy(
  request: Request,
  pathSegments: string[]
): Promise<Response> {
  const startTime = Date.now();
  const method = request.method;

  // Extract path prefix and remaining path
  const [pathPrefix, ...rest] = pathSegments;
  const path = '/' + rest.join('/');

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
      return NextResponse.json(
        { error: `No external app found for path prefix: ${pathPrefix}` },
        { status: 404 }
      );
    }

    if (!app.enabled) {
      return NextResponse.json(
        { error: `External app "${app.displayName}" is currently disabled` },
        { status: 503 }
      );
    }

    // Check for WebSocket upgrade
    if (isWebSocketUpgrade(request)) {
      const response = await proxyWebSocket(request, app, path);

      // Log the WebSocket request
      const logEntry: ProxyLogEntry = {
        timestamp: Date.now(),
        pathPrefix,
        method,
        path,
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
      path,
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
    logProxyError(pathPrefix, method, path, error as Error);

    return NextResponse.json(
      { error: 'Proxy error', message: (error as Error).message },
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
