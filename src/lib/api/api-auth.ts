/**
 * Route-level authentication guard for API handlers (Issue #1517).
 *
 * `middleware.ts` already authenticates every request, but it runs in the Edge
 * runtime and its matcher is a regex. `/api/fs/browse` reads the operator's
 * filesystem, so it re-checks in the Node runtime rather than inheriting the
 * middleware's reach as its only defence.
 */

import type { NextRequest } from 'next/server';
import { verifyToken, isAuthEnabled, AUTH_COOKIE_NAME } from '@/lib/security/auth';

/**
 * Whether the caller presented a valid token.
 *
 * Returns true when authentication is disabled (`CM_AUTH_TOKEN_HASH` unset),
 * matching the middleware's backward-compatible local-only default.
 */
export function isApiRequestAuthenticated(request: NextRequest): boolean {
  if (!isAuthEnabled()) return true;

  const cookie = request.cookies.get(AUTH_COOKIE_NAME);
  if (cookie && verifyToken(cookie.value)) return true;

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return verifyToken(authHeader.slice(7));
  }

  return false;
}
