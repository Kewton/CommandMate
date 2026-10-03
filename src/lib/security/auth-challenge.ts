/**
 * The response middleware sends to a request that failed authentication
 * (Issue #3090).
 *
 * ## Why not a 307 to an absolute `/login`
 *
 * Behind `commandmate remote` the request reaches this process through a
 * Provider (Cloudflare Quick Tunnel, Tailscale Serve) whose upstream is
 * `http://127.0.0.1:<port>`, and both Providers rewrite `Host` to that upstream
 * (`docs/qa/1937-remote-uat-record.md` D-2). Next.js builds `request.url` from
 * the server's own hostname and port, so `request.nextUrl.clone()` says
 * `https://localhost:3000` — a URL the phone cannot reach. The page then kept
 * fetching `https://localhost:3000/login` and CSP (`connect-src 'self'`)
 * blocked every attempt.
 *
 * ## Why not a relative `Location: /login`
 *
 * The Next.js 15 middleware adapter parses every `Location` a middleware
 * returns with `new NextURL(location)` and no base, which throws
 * `Invalid URL` for a relative value (the same reason `NextResponse.redirect`
 * refuses one). A relative `Location` therefore cannot leave middleware.
 *
 * ## Why not `Host` / `X-Forwarded-Host`
 *
 * The caller sets them, and the Providers rewrite `Host` anyway. Building the
 * redirect from either would be an open redirect for anyone who can send a
 * header.
 *
 * ## What is sent instead
 *
 * - **API-shaped requests** (`/api/*`, or `Accept: application/json` without
 *   `text/html`): `401` JSON, the same body the CLI already gets. `fetch()` no
 *   longer follows a redirect to an HTML page at all.
 * - **Everything else** (screen navigations): `401` with a `Refresh` header and
 *   an HTML `<meta http-equiv="refresh">` both pointing at the relative
 *   `/login`. The BROWSER resolves it against the origin it is showing, so it
 *   lands on the tunnel's `/login` behind a tunnel and on `localhost`'s on the
 *   desktop. No host name is ever written by the server, so no header a caller
 *   sends can steer it to another origin.
 *
 * Edge Runtime safe: no Node.js modules (middleware imports this file).
 */

/** The only place an unauthenticated screen request is sent. Same-origin, relative. */
export const LOGIN_PATH = '/login';

/** `Refresh` header value for {@link createLoginRefreshResponse}. */
export const LOGIN_REFRESH_HEADER = `0; url=${LOGIN_PATH}`;

const LOGIN_REFRESH_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  `<meta http-equiv="refresh" content="${LOGIN_REFRESH_HEADER}">` +
  '<title>Login required</title></head>' +
  `<body><a href="${LOGIN_PATH}">Login</a></body></html>`;

/**
 * Whether a failed request should be answered with JSON rather than sent to
 * the login screen.
 *
 * This only chooses the SHAPE of a refusal; it never grants access, so the
 * prefix match here does not interact with the exact-match rule (S002) for
 * `AUTH_EXCLUDED_PATHS`.
 */
export function isApiShapedRequest(pathname: string, accept: string | null): boolean {
  if (pathname === '/api' || pathname.startsWith('/api/')) return true;
  if (!accept) return false;
  const value = accept.toLowerCase();
  return value.includes('application/json') && !value.includes('text/html');
}

/**
 * `401` that sends a browser to the same-origin `/login`.
 *
 * Contains no host: the target is resolved by the browser against the page's
 * own origin.
 */
export function createLoginRefreshResponse(): Response {
  return new Response(LOGIN_REFRESH_HTML, {
    status: 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Refresh: LOGIN_REFRESH_HEADER,
    },
  });
}
