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
} from '@/lib/auth';

// Module-level rate limiter instance
const rateLimiter = createRateLimiter();

/**
 * Extract client IP from request
 */
function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1'
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

    // Determine if HTTPS (for Secure flag)
    const isHttps = !!process.env.CM_HTTPS_CERT;

    // Set HttpOnly cookie with the token
    const response = NextResponse.json({ success: true });
    response.cookies.set(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isHttps,
      maxAge: maxAge > 0 ? maxAge : 86400, // fallback 24h
      path: '/',
    });

    return response;
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
