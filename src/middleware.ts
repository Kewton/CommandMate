/**
 * Next.js Authentication Middleware
 * Issue #331: Token authentication support
 *
 * SECURITY CONSTRAINTS:
 * - S001: Uses XOR constant-time comparison (crypto.timingSafeEqual is Node.js only;
 *   not available in Edge Runtime. XOR over fixed-length SHA-256 hex is equivalent.)
 *   Full timingSafeEqual is used in auth.ts (Node.js runtime) for API routes.
 * - S002: AUTH_EXCLUDED_PATHS matching uses Array.includes() exact match (no startsWith)
 * - C001 (middleware variant): No Node.js-specific modules imported here.
 *   auth.ts uses Node.js crypto, so constants/logic are duplicated inline for Edge Runtime.
 * - Backward compatibility: CM_AUTH_TOKEN_HASH unset -> immediate NextResponse.next()
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { AUTH_COOKIE_NAME, AUTH_EXCLUDED_PATHS, computeExpireAt, isValidTokenHash } from './config/auth-config';

/** Token expiration timestamp, computed once at module load time */
const expireAt: number | null = computeExpireAt();

/**
 * Check if the token has expired.
 * Uses the same expireAt logic as auth.ts (via shared computeExpireAt).
 */
function isTokenExpired(): boolean {
  return expireAt !== null && Date.now() > expireAt;
}

/**
 * Verify authentication token using Web Crypto API (Edge Runtime compatible).
 *
 * S001: Uses XOR constant-time comparison instead of crypto.timingSafeEqual.
 * For fixed-length SHA-256 hex strings, XOR over all bytes provides equivalent
 * timing-attack resistance to timingSafeEqual.
 */
async function verifyTokenEdge(token: string): Promise<boolean> {
  const storedHash = process.env.CM_AUTH_TOKEN_HASH;
  if (!isValidTokenHash(storedHash)) return false;

  // Check token expiry (C1 fix: middleware must also enforce expiry)
  if (isTokenExpired()) return false;

  // Hash the provided token using Web Crypto API (available in Edge Runtime)
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const tokenHash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // S001: Constant-time XOR comparison for fixed-length hex strings
  if (tokenHash.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < tokenHash.length; i++) {
    diff |= tokenHash.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Authentication middleware
 * Checks for valid auth token in cookies before allowing access
 */
export async function middleware(request: NextRequest) {
  // WebSocket upgrade requests: verify auth before passing through.
  // On Node.js 19+, upgrade requests can trigger middleware even when an upgrade
  // listener is registered. ws-server.ts also checks auth on upgrade, so this is
  // defense-in-depth (H1 fix: prevent Upgrade header from bypassing middleware auth).
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    // Skip auth check if auth is not enabled
    if (!isValidTokenHash(process.env.CM_AUTH_TOKEN_HASH)) {
      return NextResponse.next();
    }
    // Verify the auth cookie before allowing the upgrade to proceed
    const tokenCookie = request.cookies.get(AUTH_COOKIE_NAME);
    if (tokenCookie && !isTokenExpired() && (await verifyTokenEdge(tokenCookie.value))) {
      return NextResponse.next();
    }
    // Return 401 for unauthenticated WebSocket upgrades
    return new NextResponse(null, { status: 401 });
  }

  // Backward compatibility: skip auth if not enabled
  if (!process.env.CM_AUTH_TOKEN_HASH) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // S002: Exact match for excluded paths (no startsWith - bypass attack prevention)
  if (AUTH_EXCLUDED_PATHS.includes(pathname as typeof AUTH_EXCLUDED_PATHS[number])) {
    return NextResponse.next();
  }

  // Check for auth cookie
  const tokenCookie = request.cookies.get(AUTH_COOKIE_NAME);
  if (tokenCookie && (await verifyTokenEdge(tokenCookie.value))) {
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
     * - _next/ (all Next.js internal paths: static, image, webpack-hmr, etc.)
     * - favicon.ico (favicon)
     * - public files (images, etc.)
     *
     * Note: Excluding all _next/ paths (not just _next/static and _next/image)
     * prevents TypeError in Next.js handleRequestImpl when WebSocket upgrade
     * requests reach middleware on Node.js 19+ (Issue #331).
     */
    '/((?!_next/|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
