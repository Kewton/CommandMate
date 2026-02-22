/**
 * Authentication Configuration Constants
 * Issue #331: Shared constants for auth.ts and middleware.ts
 *
 * CONSTRAINT: This module must be Edge Runtime compatible.
 * No Node.js-specific imports (crypto, fs, etc.) are allowed.
 */

/** Cookie name for authentication token */
export const AUTH_COOKIE_NAME = 'cm_auth_token' as const;

/** Valid SHA-256 hex string pattern: exactly 64 hex characters */
const VALID_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validate that a CM_AUTH_TOKEN_HASH value is a well-formed SHA-256 hex string.
 * Used by both auth.ts and middleware.ts to ensure consistent auth-enabled detection.
 * Returns a type predicate so callers can narrow the type after checking.
 *
 * @param hash - The hash string to validate
 * @returns true if the hash is a valid 64-character hex string
 */
export function isValidTokenHash(hash: string | undefined): hash is string {
  return !!hash && VALID_TOKEN_HASH_PATTERN.test(hash);
}

/**
 * Paths excluded from authentication check.
 * S002: Must use === for matching (no startsWith - bypass attack prevention)
 */
export const AUTH_EXCLUDED_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status',
] as const;

// ============================================================
// Duration Parsing (Edge Runtime compatible)
// ============================================================

/** Milliseconds in one minute */
const MS_PER_MINUTE = 60 * 1000;

/** Milliseconds in one hour */
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** Milliseconds in one day */
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Default token expiration duration (24 hours) */
export const DEFAULT_EXPIRE_DURATION_MS = 24 * MS_PER_HOUR;

/** Minimum duration: 1 hour */
const MIN_DURATION_MS = MS_PER_HOUR;

/** Maximum duration: 30 days */
const MAX_DURATION_MS = 30 * MS_PER_DAY;

/**
 * Parse a duration string into milliseconds.
 * Supported formats: Nh (hours), Nd (days), Nm (minutes)
 * Minimum: 1h, Maximum: 30d
 *
 * @param s - Duration string (e.g., "24h", "7d", "90m")
 * @returns Duration in milliseconds
 * @throws Error if format is invalid or out of range
 */
export function parseDuration(s: string): number {
  const match = s.match(/^(\d+)([hdm])$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${s}". Use Nh, Nd, or Nm (e.g., "24h", "7d", "90m")`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  /** Map of duration unit characters to their millisecond multipliers */
  const unitMultipliers: Record<string, number> = {
    h: MS_PER_HOUR,
    d: MS_PER_DAY,
    m: MS_PER_MINUTE,
  };

  const multiplier = unitMultipliers[unit];
  if (multiplier === undefined) {
    throw new Error(`Invalid duration unit: "${unit}"`);
  }

  const ms = value * multiplier;

  if (ms < MIN_DURATION_MS) {
    throw new Error(`Duration too short: minimum is 1h (60m). Got: "${s}"`);
  }

  if (ms > MAX_DURATION_MS) {
    throw new Error(`Duration too long: maximum is 30d (720h). Got: "${s}"`);
  }

  return ms;
}

/**
 * Compute token expiration timestamp from environment variables.
 * Used by both auth.ts (Node.js) and middleware.ts (Edge Runtime).
 *
 * @returns Expiration timestamp (ms since epoch), or null if auth is not enabled
 */
export function computeExpireAt(): number | null {
  const expireStr = process.env.CM_AUTH_EXPIRE;
  const now = Date.now();
  if (expireStr) {
    try {
      return now + parseDuration(expireStr);
    } catch {
      // Invalid duration format - use default
      return now + DEFAULT_EXPIRE_DURATION_MS;
    }
  }
  // Default 24h if auth is enabled
  if (process.env.CM_AUTH_TOKEN_HASH) {
    return now + DEFAULT_EXPIRE_DURATION_MS;
  }
  return null;
}
