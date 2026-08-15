/**
 * Proxy configuration constants
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * Centralizes all proxy-related configuration values for easy adjustment
 * and consistency across the proxy module.
 */

/**
 * HTTP request timeout configuration
 */
export const PROXY_TIMEOUT = {
  /** Default request timeout in milliseconds (30 seconds) */
  DEFAULT_MS: 30000,
  /** Maximum allowed timeout in milliseconds (5 minutes) */
  MAX_MS: 300000,
} as const;

/**
 * HTTP headers that should be stripped from proxied requests
 * These are "hop-by-hop" headers that are connection-specific
 */
export const HOP_BY_HOP_REQUEST_HEADERS = [
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
] as const;

/**
 * Issue #395: Sensitive request headers that must not be forwarded to upstream
 * Prevents credential leakage (cookies, auth tokens) and client identity exposure
 * through the same-origin proxy
 */
export const SENSITIVE_REQUEST_HEADERS = [
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
] as const;

/**
 * Issue #1804: Internal header carrying the raw request target.
 *
 * Next.js re-serializes the query string before an App Router route handler
 * ever runs (`?q=a%20b` -> `?q=a+b`, `?bare` -> `?bare=`, a lone `?` collapses),
 * so `request.url` is not what the client sent. `server.ts` stashes the raw
 * `req.url` from the Node `IncomingMessage` into this header before handing the
 * request to Next, and the proxy route handler reads it back.
 *
 * `server.ts` deletes this header unconditionally on every request before
 * setting it, so a client cannot forge it. It is CommandMate-internal and must
 * never reach the upstream app - see {@link INTERNAL_REQUEST_HEADERS}.
 */
export const PROXY_RAW_URL_HEADER = 'x-cm-raw-url';

/**
 * Issue #1804: CommandMate-internal request headers that must not be forwarded
 * to upstream. These are set by our own HTTP layer for our own consumption and
 * carry no meaning outside the process.
 */
export const INTERNAL_REQUEST_HEADERS = [PROXY_RAW_URL_HEADER] as const;

/**
 * HTTP headers that should be stripped from proxied responses.
 *
 * content-encoding / content-length are stripped because Node's fetch
 * transparently decompresses the response body (Node 18+ undici default),
 * so forwarding the upstream Content-Encoding: gzip alongside an
 * already-decompressed body causes the browser to fail with
 * ERR_CONTENT_DECODING_FAILED. Length likewise no longer matches the
 * decoded body, so we let the platform recompute it.
 */
export const HOP_BY_HOP_RESPONSE_HEADERS = [
  'transfer-encoding',
  'connection',
  'keep-alive',
  'content-encoding',
  'content-length',
] as const;

/**
 * Issue #395: Sensitive response headers that must not be forwarded from upstream
 * Prevents upstream apps from setting cookies on the CommandMate origin,
 * overriding security policies (CSP, HSTS, X-Frame-Options), or
 * manipulating CORS settings
 */
export const SENSITIVE_RESPONSE_HEADERS = [
  'set-cookie',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
] as const;

/**
 * HTTP status codes used by the proxy
 */
export const PROXY_STATUS_CODES = {
  /** Bad Gateway - upstream connection failed */
  BAD_GATEWAY: 502,
  /** Service Unavailable - app is disabled */
  SERVICE_UNAVAILABLE: 503,
  /** Gateway Timeout - upstream request timed out */
  GATEWAY_TIMEOUT: 504,
  /** Upgrade Required - WebSocket not supported */
  UPGRADE_REQUIRED: 426,
} as const;

/**
 * Error messages for proxy responses
 */
export const PROXY_ERROR_MESSAGES = {
  GATEWAY_TIMEOUT: 'The upstream server did not respond in time',
  BAD_GATEWAY: 'Unable to connect to upstream server',
  UPGRADE_REQUIRED: 'WebSocket connections are not supported through the proxy Route Handler',
} as const;
