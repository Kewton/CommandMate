/**
 * Next.js Middleware for API Authentication
 * Protects API routes with Bearer token authentication when running on public interfaces
 *
 * Issue #76: Environment variable fallback support
 */

import { NextRequest, NextResponse } from 'next/server';
import { getEnvWithFallback } from './lib/env';

/**
 * Authentication middleware
 *
 * Behavior:
 * - CM_BIND=127.0.0.1 or localhost: No authentication required (development)
 * - CM_BIND=0.0.0.0: Bearer token authentication required (production)
 *
 * @param request - The incoming request
 * @returns NextResponse for rejected requests, undefined to continue
 */
export function middleware(request: NextRequest) {
  // Only check authentication for API routes
  if (!request.nextUrl.pathname.startsWith('/api/')) {
    return;
  }

  // Get bind address from environment (with fallback)
  const bind = getEnvWithFallback('CM_BIND', 'MCBD_BIND') || '127.0.0.1';

  // Localhost binding: authentication is optional
  if (bind === '127.0.0.1' || bind === 'localhost') {
    return;
  }

  // Public binding (0.0.0.0): authentication is required
  if (bind === '0.0.0.0') {
    const authToken = getEnvWithFallback('CM_AUTH_TOKEN', 'MCBD_AUTH_TOKEN');

    // Server misconfiguration: public binding without token
    if (!authToken) {
      return NextResponse.json(
        { error: 'Server authentication not configured' },
        { status: 500 }
      );
    }

    // Extract Authorization header
    const authHeader = request.headers.get('Authorization');

    if (!authHeader) {
      return NextResponse.json(
        { error: 'Authorization header required' },
        { status: 401 }
      );
    }

    // Parse Bearer token (case-insensitive)
    const match = authHeader.match(/^bearer\s+(.+)$/i);

    if (!match) {
      return NextResponse.json(
        { error: 'Invalid Authorization format. Expected: Bearer <token>' },
        { status: 401 }
      );
    }

    const token = match[1];

    // Validate token
    if (token !== authToken) {
      return NextResponse.json(
        { error: 'Invalid authentication token' },
        { status: 401 }
      );
    }

    // Token is valid, continue
    return;
  }

  // Unknown bind address, continue (let env validation handle it)
  return;
}

// Configure which routes to run middleware on
export const config = {
  matcher: '/api/:path*',
};
