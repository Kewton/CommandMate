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

/**
 * Rate limit key for login attempts.
 * H2 fix: Do NOT trust X-Forwarded-For or X-Real-IP headers for rate limiting.
 * These headers are attacker-controlled when there is no trusted reverse proxy.
 * CommandMate typically serves direct connections, so we use a fixed key
 * to enforce a global rate limit regardless of source IP.
 *
 * Trade-off: A global key means an attacker who exhausts the limit locks out all
 * users for the lockout duration (default 15 min). This is accepted because:
 * - IP-based limiting is spoofable without a trusted reverse proxy
 * - CommandMate targets local/trusted networks, not public internet
 * - The in-memory rate limiter resets on server restart
 * - A future CM_TRUST_PROXY option could enable per-IP limiting behind a proxy
 */
const RATE_LIMIT_KEY = 'global';

export async function POST(request: NextRequest) {
  try {
    const ip = RATE_LIMIT_KEY;

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

    // M3 fix: Validate token type and length to prevent DoS via oversized input.
    // Valid tokens are 64-char hex strings (32 bytes), so 256 chars is generous.
    if (!token || typeof token !== 'string' || token.length > 256) {
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
