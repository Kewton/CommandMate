/**
 * Login API Route
 * Issue #331: Token authentication
 *
 * POST: Verify token, set HttpOnly cookie, rate limit check
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  verifyToken,
  AUTH_COOKIE_NAME,
  getTokenMaxAge,
  createRateLimiter,
  buildAuthCookieOptions,
  DEFAULT_COOKIE_MAX_AGE_SECONDS,
} from '@/lib/auth';

// Module-level rate limiter instance
const rateLimiter = createRateLimiter();

/** Fallback IP address when no forwarding headers are present */
const LOOPBACK_IP = '127.0.0.1';

/**
 * Extract client IP from request headers.
 * Checks X-Forwarded-For (first entry) and X-Real-IP before falling back to loopback.
 *
 * @param request - Incoming Next.js request
 * @returns Client IP address string
 */
function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    LOOPBACK_IP
  );
}

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request);

    // Rate limit check
    const limitResult = rateLimiter.checkLimit(ip);
    if (!limitResult.allowed) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(limitResult.retryAfter || 900),
          },
        }
      );
    }

    const body = await request.json();
    const { token } = body;

    if (!token || typeof token !== 'string') {
      rateLimiter.recordFailure(ip);
      return NextResponse.json(
        { error: 'Token is required' },
        { status: 400 }
      );
    }

    if (!verifyToken(token)) {
      rateLimiter.recordFailure(ip);
      return NextResponse.json(
        { error: 'Invalid token' },
        { status: 401 }
      );
    }

    // Token is valid - reset rate limit counter
    rateLimiter.recordSuccess(ip);

    // Calculate cookie maxAge (remaining token lifetime in seconds)
    const maxAge = getTokenMaxAge();
    const effectiveMaxAge = maxAge > 0 ? maxAge : DEFAULT_COOKIE_MAX_AGE_SECONDS;

    // Set HttpOnly cookie with the token
    const response = NextResponse.json({ success: true });
    response.cookies.set(AUTH_COOKIE_NAME, token, buildAuthCookieOptions(effectiveMaxAge));

    return response;
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
