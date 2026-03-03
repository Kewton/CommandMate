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
 * HTTP headers that should be stripped from proxied responses
 */
export const HOP_BY_HOP_RESPONSE_HEADERS = [
  'transfer-encoding',
  'connection',
  'keep-alive',
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
