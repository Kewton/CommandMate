/**
 * Next.js Authentication Middleware
 * Issue #331: Token authentication support
 *
 * SECURITY CONSTRAINTS:
 * - S002: AUTH_EXCLUDED_PATHS matching uses === (exact match, no startsWith)
 * - Backward compatibility: CM_AUTH_TOKEN_HASH unset -> immediate NextResponse.next()
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  isAuthEnabled,
  AUTH_EXCLUDED_PATHS,
  AUTH_COOKIE_NAME,
  verifyToken,
} from '@/lib/auth';

/**
 * Authentication middleware
 * Checks for valid auth token in cookies before allowing access
 */
export function middleware(request: NextRequest) {
  // Backward compatibility: skip auth if not enabled
  if (!isAuthEnabled()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // S002: Exact match for excluded paths (no startsWith - bypass attack prevention)
  if (AUTH_EXCLUDED_PATHS.includes(pathname as typeof AUTH_EXCLUDED_PATHS[number])) {
    return NextResponse.next();
  }

  // Check for auth cookie
  const tokenCookie = request.cookies.get(AUTH_COOKIE_NAME);
  if (tokenCookie && verifyToken(tokenCookie.value)) {
    return NextResponse.next();
  }

  // Redirect to login page
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  return NextResponse.redirect(loginUrl);
}

/**
 * Matcher configuration: exclude static assets and Next.js internals
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico (favicon)
     * - public files (images, etc.)
     */
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
