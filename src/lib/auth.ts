/**
 * Token Authentication Core Module
 * Issue #331: Token authentication and HTTPS support
 *
 * CONSTRAINTS:
 * - C001: No Next.js module dependencies (next/headers, next/server, etc.)
 *   This module must be compatible with CLI build (tsconfig.cli.json)
 * - S001: Token verification uses crypto.timingSafeEqual() (timing-safe comparison)
 * - S002: AUTH_EXCLUDED_PATHS matching uses === (exact match, no startsWith)
 */

import crypto from 'crypto';

// ============================================================
// Constants
// ============================================================

/** Cookie name for authentication token */
export const AUTH_COOKIE_NAME = 'cm_auth_token' as const;

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

/** Rate limiting configuration for brute-force protection */
export const RATE_LIMIT_CONFIG = {
  /** Maximum failed attempts before lockout */
  maxAttempts: 5,
  /** Lockout duration in ms (15 minutes) */
  lockoutDuration: 15 * 60 * 1000,
  /** Cleanup interval in ms (1 hour) */
  cleanupInterval: 60 * 60 * 1000,
} as const;

/** Default token expiration duration (24 hours) */
const DEFAULT_EXPIRE_DURATION = 24 * 60 * 60 * 1000;

/** Minimum duration: 1 hour */
const MIN_DURATION_MS = 60 * 60 * 1000;

/** Maximum duration: 30 days */
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================
// Module-level state (initialized from env at import time)
// ============================================================

/** The stored hash of the authentication token */
const storedTokenHash: string | undefined = process.env.CM_AUTH_TOKEN_HASH || undefined;

/** Token expiration timestamp (ms since epoch) */
const expireAt: number | null = (() => {
  const expireStr = process.env.CM_AUTH_EXPIRE;
  const now = Date.now();
  if (expireStr) {
    try {
      return now + parseDuration(expireStr);
    } catch {
      // Invalid duration format - use default
      return now + DEFAULT_EXPIRE_DURATION;
    }
  }
  // Default 24h if auth is enabled
  if (process.env.CM_AUTH_TOKEN_HASH) {
    return now + DEFAULT_EXPIRE_DURATION;
  }
  return null;
})();

// ============================================================
// Token Functions
// ============================================================

/**
 * Generate a cryptographically secure random token
 * @returns 64-character hex string (32 bytes of entropy)
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a token using SHA-256
 * @param token - The plain text token to hash
 * @returns 64-character hex string (SHA-256 hash)
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Verify a token against the stored hash
 * S001: Uses crypto.timingSafeEqual() for timing-safe comparison
 *
 * @param token - The plain text token to verify
 * @returns true if the token is valid and not expired
 */
export function verifyToken(token: string): boolean {
  if (!storedTokenHash) {
    return false;
  }

  // Guard against undefined/null/empty token
  if (!token || typeof token !== 'string') {
    return false;
  }

  // Check expiration
  if (expireAt !== null && Date.now() > expireAt) {
    return false;
  }

  const tokenHash = hashToken(token);

  // S001: timing-safe comparison to prevent timing attacks
  const hashBuffer = Buffer.from(tokenHash, 'hex');
  const storedBuffer = Buffer.from(storedTokenHash, 'hex');

  if (hashBuffer.length !== storedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(hashBuffer, storedBuffer);
}

// ============================================================
// Duration Parsing
// ============================================================

/**
 * Parse a duration string into milliseconds
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

  let ms: number;
  switch (unit) {
    case 'h':
      ms = value * 60 * 60 * 1000;
      break;
    case 'd':
      ms = value * 24 * 60 * 60 * 1000;
      break;
    case 'm':
      ms = value * 60 * 1000;
      break;
    default:
      throw new Error(`Invalid duration unit: "${unit}"`);
  }

  if (ms < MIN_DURATION_MS) {
    throw new Error(`Duration too short: minimum is 1h (60m). Got: "${s}"`);
  }

  if (ms > MAX_DURATION_MS) {
    throw new Error(`Duration too long: maximum is 30d (720h). Got: "${s}"`);
  }

  return ms;
}

// ============================================================
// Cookie Parsing (for WebSocket authentication)
// ============================================================

/**
 * Parse a Cookie header string into key-value pairs
 * Used by WebSocket upgrade handler where next/headers is not available
 *
 * @param cookieHeader - Raw Cookie header string
 * @returns Parsed cookies as Record<string, string>
 */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) {
    return cookies;
  }

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const name = pair.substring(0, eqIndex).trim();
    const value = pair.substring(eqIndex + 1).trim();
    if (name) {
      cookies[name] = value;
    }
  }

  return cookies;
}

// ============================================================
// Auth State Functions
// ============================================================

/**
 * Check if authentication is enabled
 * @returns true if CM_AUTH_TOKEN_HASH is set and non-empty
 */
export function isAuthEnabled(): boolean {
  return !!process.env.CM_AUTH_TOKEN_HASH;
}

/**
 * Calculate the Cookie maxAge in seconds (remaining token lifetime)
 * @returns maxAge in seconds, or 0 if expired/no expiry
 */
export function getTokenMaxAge(): number {
  if (expireAt === null) {
    return 0;
  }

  const remaining = expireAt - Date.now();
  if (remaining <= 0) {
    return 0;
  }

  return Math.floor(remaining / 1000);
}

// ============================================================
// Rate Limiter
// ============================================================

interface RateLimitEntry {
  attempts: number;
  lockedUntil: number | null;
  lastAttempt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export interface RateLimiter {
  checkLimit(ip: string): RateLimitResult;
  recordFailure(ip: string): void;
  recordSuccess(ip: string): void;
  destroy(): void;
}

/**
 * Create a rate limiter for brute-force protection
 * Uses in-memory Map with periodic cleanup
 *
 * @returns RateLimiter instance with checkLimit, recordFailure, recordSuccess, destroy
 */
export function createRateLimiter(): RateLimiter {
  const entries = new Map<string, RateLimitEntry>();

  // Periodic cleanup of expired entries
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of entries) {
      // Remove entries that are unlocked and older than lockout duration
      if (
        entry.lockedUntil === null ||
        (entry.lockedUntil !== null && now > entry.lockedUntil)
      ) {
        if (now - entry.lastAttempt > RATE_LIMIT_CONFIG.lockoutDuration) {
          entries.delete(ip);
        }
      }
    }
  }, RATE_LIMIT_CONFIG.cleanupInterval);

  // Ensure timer doesn't prevent process exit
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  return {
    checkLimit(ip: string): RateLimitResult {
      const entry = entries.get(ip);
      if (!entry) {
        return { allowed: true };
      }

      // Check if lockout has expired
      if (entry.lockedUntil !== null) {
        const now = Date.now();
        if (now < entry.lockedUntil) {
          const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000);
          return { allowed: false, retryAfter };
        }
        // Lockout expired - reset entry
        entry.attempts = 0;
        entry.lockedUntil = null;
      }

      return { allowed: true };
    },

    recordFailure(ip: string): void {
      const now = Date.now();
      const entry = entries.get(ip) || { attempts: 0, lockedUntil: null, lastAttempt: now };

      entry.attempts++;
      entry.lastAttempt = now;

      if (entry.attempts >= RATE_LIMIT_CONFIG.maxAttempts) {
        entry.lockedUntil = now + RATE_LIMIT_CONFIG.lockoutDuration;
      }

      entries.set(ip, entry);
    },

    recordSuccess(ip: string): void {
      entries.delete(ip);
    },

    destroy(): void {
      clearInterval(cleanupTimer);
      entries.clear();
    },
  };
}
