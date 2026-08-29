/**
 * Remote Pairing API Route
 * Issue #1937 (R5): exchange a one-shot pairing code for the auth cookie
 *
 * Design: docs/design/remote-qr-pairing-1937.md §7.3
 *
 * This is the ONLY endpoint `commandmate remote` adds, and the only entry
 * `AUTH_EXCLUDED_PATHS` grows by. The pairing SCREEN is the existing `/login`
 * (already excluded) driven by a `#code=` fragment, so no second excluded path
 * is needed.
 *
 * The single-use property lives in the ORDER of the steps below, specifically
 * that the handoff file is unlinked BEFORE the cookie is built: if cookie
 * construction throws, the code is still spent (fail-closed).
 */

import { NextRequest, NextResponse } from 'next/server';

import { logSecurityEvent } from '@/cli/utils/security-logger';
import {
  AUTH_COOKIE_NAME,
  DEFAULT_COOKIE_MAX_AGE_SECONDS,
  buildAuthCookieOptions,
  getTokenMaxAge,
} from '@/lib/security/auth';
import {
  MAX_PAIRING_CODE_LENGTH,
  consumePairingHandoff,
  getPairingFilePathFromEnv,
  isPairingExpired,
  readPairingHandoff,
  verifyPairingCode,
} from '@/lib/security/pairing-code';
import { createRequestRateLimiter } from '@/lib/security/request-rate-limiter';

/** `pairing-code.ts` uses `fs` and `crypto`; this route can never run on Edge. */
export const runtime = 'nodejs';

/** The handoff file changes underneath us; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

/**
 * Fixed-key rate limit, matching `/api/auth/login`'s RATE_LIMIT_KEY = 'global'.
 *
 * X-Forwarded-For and X-Real-IP are attacker-controlled without a trusted
 * reverse proxy, and pairing is reached over a tunnel where that is exactly the
 * situation. A per-IP limit would therefore be a limit an attacker can reset at
 * will. The cost of the global key — one attacker can lock out the operator for
 * the window — is bounded here in a way it is not for login: the operator can
 * mint a fresh code by re-running `commandmate remote`.
 */
const RATE_LIMIT_KEY = 'global';

/** 5 attempts / 15 min, the same budget `RATE_LIMIT_CONFIG` gives login. */
const rateLimiter = createRequestRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });

/** Seconds reported in `Retry-After` when the limiter offers no better number. */
const FALLBACK_RETRY_AFTER_SECONDS = 900;

/**
 * Record a pairing outcome. `details` is a fixed vocabulary on purpose: neither
 * the pairing code nor the session token may ever reach a log (§7.3).
 *
 * @param action - success or failure
 * @param reason - Stable reason slug, no user-supplied content
 */
function logPairingEvent(action: 'success' | 'failure', reason: string): void {
  logSecurityEvent({
    timestamp: new Date().toISOString(),
    command: 'remote',
    action,
    details: `pair: ${reason}`,
  });
}

export async function POST(request: NextRequest) {
  // 0. `remote` is not running -> the endpoint does not exist as far as callers
  //    are concerned. Checked before the rate limiter so probing a server that
  //    never paired cannot lock out a server that later does.
  const pairingFilePath = getPairingFilePathFromEnv();
  if (!pairingFilePath) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    // 1. Rate limit.
    const limitResult = rateLimiter.check(RATE_LIMIT_KEY);
    if (!limitResult.allowed) {
      logPairingEvent('failure', 'rate-limited');
      return NextResponse.json(
        { error: 'Too many pairing attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(limitResult.retryAfter || FALLBACK_RETRY_AFTER_SECONDS),
          },
        }
      );
    }

    // 2. Input shape and length.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      logPairingEvent('failure', 'malformed-body');
      return NextResponse.json({ error: 'Pairing code is required' }, { status: 400 });
    }

    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX_PAIRING_CODE_LENGTH) {
      logPairingEvent('failure', 'invalid-request');
      return NextResponse.json({ error: 'Pairing code is required' }, { status: 400 });
    }

    // 3. Missing or unusable handoff file. An already-consumed code lands here.
    const handoff = readPairingHandoff(pairingFilePath);
    if (!handoff) {
      logPairingEvent('failure', 'handoff-unavailable');
      return NextResponse.json({ error: 'Pairing is no longer available.' }, { status: 410 });
    }

    // 4. Expired.
    if (isPairingExpired(handoff)) {
      consumePairingHandoff(pairingFilePath);
      logPairingEvent('failure', 'expired');
      return NextResponse.json({ error: 'Pairing is no longer available.' }, { status: 410 });
    }

    // 5. Timing-safe comparison.
    if (!verifyPairingCode(code, handoff.pairingHash)) {
      logPairingEvent('failure', 'code-mismatch');
      return NextResponse.json({ error: 'Invalid pairing code.' }, { status: 401 });
    }

    // Hold the plaintext token in a function-local before the file goes away.
    // It must not escape to module scope: the whole point of the file is that
    // the secret has no long-lived home in this process.
    const sessionToken = handoff.sessionToken;

    // 6. Consume BEFORE the cookie exists. If step 7 throws, the code is spent.
    consumePairingHandoff(pairingFilePath);

    // 7. Cookie. `buildAuthCookieOptions()` is used unchanged: its `secure` flag
    //    follows CM_HTTPS_CERT, which a tunnel deliberately does not set (U-6).
    const maxAge = getTokenMaxAge();
    const effectiveMaxAge = maxAge > 0 ? maxAge : DEFAULT_COOKIE_MAX_AGE_SECONDS;

    // 8. The token travels in the cookie only - never in the body.
    const response = NextResponse.json({ success: true });
    response.cookies.set(AUTH_COOKIE_NAME, sessionToken, buildAuthCookieOptions(effectiveMaxAge));

    logPairingEvent('success', 'paired');
    return response;
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
