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
import { getAllowedRanges, isIpAllowed, isIpRestrictionEnabled, getClientIp, normalizeIp } from './lib/security/ip-restriction';

/** Token expiration timestamp, computed once at module load time */
const expireAt: number | null = computeExpireAt();

/**
 * Issue #2489: the header `server.ts` overwrites on every request and upgrade,
 * naming the listener the request arrived on.
 *
 * Spelled out here rather than imported from `src/lib/ws-server.ts`, where the
 * same constant and the same predicate live for the Node-runtime side. That
 * module imports `http`, `net`, `ws` and the database; this file runs on the
 * Edge runtime, where none of it can be loaded. It is the same C001 constraint
 * that already duplicates the auth constants and the token comparison — see the
 * file header — and the agreement between the two copies is measured rather than
 * assumed (`tests/integration/remote-ingress-auth-2489.test.ts` runs the same
 * matrix through both).
 */
const CM_INGRESS_HEADER = 'x-cm-ingress';

/**
 * Issue #2489: `CM_AUTH_SCOPE` value that exempts the local listener.
 *
 * Any other value — absent, `all`, a typo — authenticates every listener, which
 * is both the pre-#2489 behaviour and the fail-closed answer.
 */
const REMOTE_ONLY_AUTH_SCOPE = 'remote-only';

/**
 * Whether this request may skip authentication because of where it arrived.
 *
 * ## Why the listener, and not the address
 *
 * Tailscale Serve and the Cloudflare Quick Tunnel both connect to
 * `http://127.0.0.1:<port>` as their upstream, so a request from the phone on
 * the other side of the world reaches this process from 127.0.0.1 exactly like
 * one from the browser on the same machine. Exempting loopback — via
 * `getClientIp()`, `X-Real-IP` or `req.socket.remoteAddress` — would therefore
 * publish an unauthenticated CommandMate to whoever has the tunnel URL. `Host`
 * and `X-Forwarded-*` are worse still: the caller sets them, and a Provider was
 * measured rewriting `Host` to the upstream's own
 * (`docs/qa/1937-remote-uat-record.md` D-2).
 *
 * So the question is answered by the socket instead. `remote --auth remote-only`
 * runs a second loopback listener that the Provider alone is pointed at, and
 * `server.ts` stamps {@link CM_INGRESS_HEADER} on both listeners, discarding
 * whatever the client sent under that name. This function reads the stamp and
 * nothing else.
 *
 * Fail-closed on both halves: the scope must be exactly `remote-only`, and the
 * stamp exactly `local`. An unstamped request — one that reached middleware
 * without passing a listener this process built — authenticates.
 */
function isIngressAuthExempt(request: NextRequest): boolean {
  if (process.env.CM_AUTH_SCOPE !== REMOTE_ONLY_AUTH_SCOPE) return false;
  return request.headers.get(CM_INGRESS_HEADER) === 'local';
}

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
  // Step 1: IP restriction check (all requests)
  // [S4-003] Executed before AUTH_EXCLUDED_PATHS evaluation. Excluded paths are also subject to IP restriction.
  // [S2-005] Defense-in-depth: WebSocket upgrade requests are checked here AND in ws-server.ts.
  if (isIpRestrictionEnabled()) {
    const clientIp = getClientIp(request.headers);
    if (!clientIp || !isIpAllowed(clientIp, getAllowedRanges())) {
      // [S4-004] Log injection prevention: normalizeIp() + substring(0, 45)
      const safeIp = clientIp ? normalizeIp(clientIp).substring(0, 45) : 'unknown';
      console.warn(`[IP-RESTRICTION] Denied: ${safeIp}`);
      return new NextResponse(null, { status: 403 });
    }
  }

  // Issue #2489: computed once, after the IP restriction above and before every
  // auth branch below. IP restriction is NOT part of this exemption — a
  // `CM_ALLOWED_IPS` the operator set still applies to the local listener.
  const ingressExempt = isIngressAuthExempt(request);

  // WebSocket upgrade requests: verify auth before passing through.
  // On Node.js 19+, upgrade requests can trigger middleware even when an upgrade
  // listener is registered. ws-server.ts also checks auth on upgrade, so this is
  // defense-in-depth (H1 fix: prevent Upgrade header from bypassing middleware auth).
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    // Skip auth check if auth is not enabled, or if this upgrade arrived on the
    // local listener of a `remote-only` server (#2489). ws-server.ts applies the
    // same two conditions to the same header, so the two cannot drift apart.
    if (!isValidTokenHash(process.env.CM_AUTH_TOKEN_HASH) || ingressExempt) {
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

  // Issue #2489: auth IS enabled, and this request came in on the local listener
  // of a server started with `remote --auth remote-only`. The phone's requests
  // arrive on the other listener and fall through to the checks below.
  if (ingressExempt) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // S002: Exact match for excluded paths (no startsWith - bypass attack prevention)
  if (AUTH_EXCLUDED_PATHS.includes(pathname as typeof AUTH_EXCLUDED_PATHS[number])) {
    return NextResponse.next();
  }

  // [IA3-01] Cookie-first verification order: Cookie check MUST come first
  // to preserve existing browser auth. Bearer is fallback only.

  // Step A: Cookie check (existing browser flow)
  const tokenCookie = request.cookies.get(AUTH_COOKIE_NAME);
  if (tokenCookie && (await verifyTokenEdge(tokenCookie.value))) {
    return NextResponse.next();
  }

  // Step B: Bearer token check (CLI fallback) [Issue #518]
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7);
    if (bearerToken && (await verifyTokenEdge(bearerToken))) {
      return NextResponse.next();
    }
    // [SEC4-07] Log Bearer auth failure with IP
    const clientIp = getClientIp(request.headers);
    const safeIp = clientIp ? normalizeIp(clientIp).substring(0, 45) : 'unknown';
    console.warn(`[AUTH] Bearer token auth failed from IP: ${safeIp}`);
  }

  // Step C: Auth failure response branching [DR1-10]
  // CLI requests (with Authorization header) get 401 JSON
  // Browser requests (no Authorization header) get /login redirect
  if (authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Redirect to login page (browser flow)
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
