/**
 * Unit Tests: auth.ts - Token Authentication Core Module
 * Issue #331: Token authentication and HTTPS support
 *
 * Tests cover:
 * - generateToken(): Random token generation, uniqueness, 64-char hex format
 * - hashToken(): SHA-256 hashing consistency
 * - verifyToken(): Valid/invalid/expired token verification with timingSafeEqual
 * - parseDuration(): Duration string parsing (Nh/Nd/Nm), min 1h, max 30d
 * - parseCookies(): Cookie header parsing
 * - isAuthEnabled(): CM_AUTH_TOKEN_HASH environment check
 * - Cookie maxAge calculation (remaining expiry)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to control env vars before importing auth module
describe('auth module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Clear auth-related env vars
    delete process.env.CM_AUTH_TOKEN_HASH;
    delete process.env.CM_AUTH_EXPIRE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('generateToken', () => {
    it('should return a 64-character hex string', async () => {
      const { generateToken } = await import('@/lib/auth');
      const token = generateToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate unique tokens on each call', async () => {
      const { generateToken } = await import('@/lib/auth');
      const token1 = generateToken();
      const token2 = generateToken();
      expect(token1).not.toBe(token2);
    });

    it('should generate tokens with 32 bytes of entropy', async () => {
      const { generateToken } = await import('@/lib/auth');
      const token = generateToken();
      // 32 bytes = 64 hex chars
      expect(token.length).toBe(64);
    });
  });

  describe('hashToken', () => {
    it('should return a consistent SHA-256 hash for the same input', async () => {
      const { hashToken } = await import('@/lib/auth');
      const token = 'test-token-value';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
    });

    it('should return a 64-character hex string (SHA-256)', async () => {
      const { hashToken } = await import('@/lib/auth');
      const hash = hashToken('any-input');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce different hashes for different inputs', async () => {
      const { hashToken } = await import('@/lib/auth');
      const hash1 = hashToken('token-a');
      const hash2 = hashToken('token-b');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyToken', () => {
    it('should return true for a valid token with matching hash', async () => {
      const { generateToken, hashToken, verifyToken } = await import('@/lib/auth');
      const token = generateToken();
      const hash = hashToken(token);
      // Set up environment
      process.env.CM_AUTH_TOKEN_HASH = hash;
      // No expiry set = no expiration check (module-level init already happened,
      // so we re-import)
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = hash;
      const authModule = await import('@/lib/auth');
      expect(authModule.verifyToken(token)).toBe(true);
    });

    it('should return false for an invalid token', async () => {
      const { generateToken, hashToken } = await import('@/lib/auth');
      const token = generateToken();
      const hash = hashToken(token);
      process.env.CM_AUTH_TOKEN_HASH = hash;
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = hash;
      const authModule = await import('@/lib/auth');
      expect(authModule.verifyToken('wrong-token-value-that-is-not-correct')).toBe(false);
    });

    it('should return false when CM_AUTH_TOKEN_HASH is not set', async () => {
      delete process.env.CM_AUTH_TOKEN_HASH;
      vi.resetModules();
      const authModule = await import('@/lib/auth');
      expect(authModule.verifyToken('any-token')).toBe(false);
    });

    it('should return false for an expired token', async () => {
      // Step 1: Generate token and hash with real Date.now
      const { generateToken, hashToken } = await import('@/lib/auth');
      const token = generateToken();
      const hash = hashToken(token);

      // Step 2: Set up env and mock time for module init
      const baseTime = 1000000000000;
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
      process.env.CM_AUTH_TOKEN_HASH = hash;
      process.env.CM_AUTH_EXPIRE = '1h';
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = hash;
      process.env.CM_AUTH_EXPIRE = '1h';

      // Step 3: Import module - expireAt = baseTime + 1h (since Date.now() returns baseTime)
      const authModule = await import('@/lib/auth');

      // Step 4: Change mock to 2h later (past expiration)
      dateNowSpy.mockReturnValue(baseTime + 2 * 60 * 60 * 1000);

      // Step 5: Verify token is expired
      expect(authModule.verifyToken(token)).toBe(false);
      vi.restoreAllMocks();
    });

    it('should use timing-safe comparison (S001 constraint)', async () => {
      // Verify timingSafeEqual is used by checking the source code.
      // Reading the actual source file to confirm the security constraint.
      const fs = await import('fs');
      const path = await import('path');
      const authSourcePath = path.resolve(__dirname, '../../src/lib/auth.ts');
      const authSource = fs.readFileSync(authSourcePath, 'utf-8');
      expect(authSource).toContain('timingSafeEqual');
      // Also verify behavioral correctness
      const { generateToken, hashToken } = await import('@/lib/auth');
      const token = generateToken();
      const hash = hashToken(token);
      process.env.CM_AUTH_TOKEN_HASH = hash;
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = hash;
      const authModule = await import('@/lib/auth');
      expect(authModule.verifyToken(token)).toBe(true);
      expect(authModule.verifyToken('a'.repeat(64))).toBe(false);
    });
  });

  describe('parseDuration', () => {
    it('should parse hours (e.g., "24h" -> 24 * 3600 * 1000 ms)', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
    });

    it('should parse days (e.g., "7d" -> 7 * 86400 * 1000 ms)', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should parse minutes (e.g., "90m" -> 90 * 60 * 1000 ms)', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(parseDuration('90m')).toBe(90 * 60 * 1000);
    });

    it('should enforce minimum duration of 1 hour', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(() => parseDuration('30m')).toThrow();
      expect(() => parseDuration('59m')).toThrow();
    });

    it('should enforce maximum duration of 30 days', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(() => parseDuration('31d')).toThrow();
      expect(() => parseDuration('721h')).toThrow();
    });

    it('should throw on invalid format', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(() => parseDuration('abc')).toThrow();
      expect(() => parseDuration('')).toThrow();
      expect(() => parseDuration('24')).toThrow();
      expect(() => parseDuration('h24')).toThrow();
      expect(() => parseDuration('24s')).toThrow();
    });

    it('should accept edge case: 1h (minimum)', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(parseDuration('1h')).toBe(60 * 60 * 1000);
    });

    it('should accept edge case: 30d (maximum)', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(parseDuration('30d')).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('should accept edge case: 60m (equals 1h minimum)', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(parseDuration('60m')).toBe(60 * 60 * 1000);
    });
  });

  describe('parseCookies', () => {
    it('should parse a standard Cookie header', async () => {
      const { parseCookies } = await import('@/lib/auth');
      const result = parseCookies('name=value; session=abc123');
      expect(result).toEqual({ name: 'value', session: 'abc123' });
    });

    it('should handle empty string', async () => {
      const { parseCookies } = await import('@/lib/auth');
      const result = parseCookies('');
      expect(result).toEqual({});
    });

    it('should handle malformed cookies gracefully', async () => {
      const { parseCookies } = await import('@/lib/auth');
      const result = parseCookies('invalidcookie');
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('should handle cookies with special characters in values', async () => {
      const { parseCookies } = await import('@/lib/auth');
      const result = parseCookies('token=abc%3D123; path=/test');
      expect(result.token).toBe('abc%3D123');
      expect(result.path).toBe('/test');
    });

    it('should trim whitespace from names and values', async () => {
      const { parseCookies } = await import('@/lib/auth');
      const result = parseCookies('  name  =  value  ;  key  =  data  ');
      expect(result.name).toBe('value');
      expect(result.key).toBe('data');
    });
  });

  describe('isAuthEnabled', () => {
    it('should return true when CM_AUTH_TOKEN_HASH is set', async () => {
      process.env.CM_AUTH_TOKEN_HASH = 'somehash';
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = 'somehash';
      const { isAuthEnabled } = await import('@/lib/auth');
      expect(isAuthEnabled()).toBe(true);
    });

    it('should return false when CM_AUTH_TOKEN_HASH is not set', async () => {
      delete process.env.CM_AUTH_TOKEN_HASH;
      vi.resetModules();
      const { isAuthEnabled } = await import('@/lib/auth');
      expect(isAuthEnabled()).toBe(false);
    });

    it('should return false when CM_AUTH_TOKEN_HASH is empty string', async () => {
      process.env.CM_AUTH_TOKEN_HASH = '';
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = '';
      const { isAuthEnabled } = await import('@/lib/auth');
      expect(isAuthEnabled()).toBe(false);
    });
  });

  describe('AUTH_COOKIE_NAME', () => {
    it('should be "cm_auth_token"', async () => {
      const { AUTH_COOKIE_NAME } = await import('@/lib/auth');
      expect(AUTH_COOKIE_NAME).toBe('cm_auth_token');
    });
  });

  describe('AUTH_EXCLUDED_PATHS', () => {
    it('should contain login-related paths', async () => {
      const { AUTH_EXCLUDED_PATHS } = await import('@/lib/auth');
      expect(AUTH_EXCLUDED_PATHS).toContain('/login');
      expect(AUTH_EXCLUDED_PATHS).toContain('/api/auth/login');
      expect(AUTH_EXCLUDED_PATHS).toContain('/api/auth/logout');
      expect(AUTH_EXCLUDED_PATHS).toContain('/api/auth/status');
    });
  });

  describe('Cookie maxAge calculation', () => {
    it('should calculate remaining time correctly via getTokenMaxAge', async () => {
      process.env.CM_AUTH_TOKEN_HASH = 'hash';
      process.env.CM_AUTH_EXPIRE = '24h';
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = 'hash';
      process.env.CM_AUTH_EXPIRE = '24h';
      const authModule = await import('@/lib/auth');
      const maxAge = authModule.getTokenMaxAge();
      // Should be approximately 24h in seconds (with small tolerance for execution time)
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(24 * 60 * 60);
    });

    it('should return 0 when token is expired', async () => {
      const baseTime = 1000000000000; // Fixed base time
      // Mock Date.now to return baseTime during module initialization
      vi.spyOn(Date, 'now').mockReturnValue(baseTime);
      process.env.CM_AUTH_TOKEN_HASH = 'hash';
      process.env.CM_AUTH_EXPIRE = '1h';
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = 'hash';
      process.env.CM_AUTH_EXPIRE = '1h';
      // Import with Date.now() = baseTime, so expireAt = baseTime + 1h
      const authModule = await import('@/lib/auth');
      // Now change Date.now() to 2h later => expired
      vi.spyOn(Date, 'now').mockReturnValue(baseTime + 2 * 60 * 60 * 1000);
      expect(authModule.getTokenMaxAge()).toBe(0);
      vi.restoreAllMocks();
    });

    it('should return default 24h when CM_AUTH_EXPIRE is not set', async () => {
      process.env.CM_AUTH_TOKEN_HASH = 'hash';
      delete process.env.CM_AUTH_EXPIRE;
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = 'hash';
      const authModule = await import('@/lib/auth');
      const maxAge = authModule.getTokenMaxAge();
      // Default 24h = 86400 seconds
      expect(maxAge).toBeGreaterThan(86300);
      expect(maxAge).toBeLessThanOrEqual(86400);
    });
  });

  describe('RATE_LIMIT_CONFIG', () => {
    it('should have correct default values', async () => {
      const { RATE_LIMIT_CONFIG } = await import('@/lib/auth');
      expect(RATE_LIMIT_CONFIG.maxAttempts).toBe(5);
      expect(RATE_LIMIT_CONFIG.lockoutDuration).toBe(15 * 60 * 1000);
      expect(RATE_LIMIT_CONFIG.cleanupInterval).toBe(60 * 60 * 1000);
    });
  });
});
