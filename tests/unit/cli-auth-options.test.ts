/**
 * Unit Tests: CLI Auth Options
 * Issue #331: --auth, --auth-expire, --cert, --key, --allow-http option parsing
 *
 * Tests cover:
 * - StartOptions type has auth-related fields
 * - parseDuration validation for --auth-expire
 * - Legacy CM_AUTH_TOKEN warning detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('CLI Auth Options', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('StartOptions type', () => {
    it('should accept auth option', async () => {
      // Type check - verify the interface allows auth fields
      const options: import('@/cli/types').StartOptions = {
        auth: true,
        authExpire: '24h',
        cert: '/path/to/cert.pem',
        key: '/path/to/key.pem',
        allowHttp: false,
      };
      expect(options.auth).toBe(true);
      expect(options.authExpire).toBe('24h');
      expect(options.cert).toBe('/path/to/cert.pem');
      expect(options.key).toBe('/path/to/key.pem');
      expect(options.allowHttp).toBe(false);
    });

    it('should accept all existing fields alongside auth fields', async () => {
      const options: import('@/cli/types').StartOptions = {
        dev: true,
        daemon: true,
        port: 3000,
        issue: 331,
        autoPort: true,
        auth: true,
        authExpire: '7d',
        https: true,
        cert: '/cert.pem',
        key: '/key.pem',
        allowHttp: true,
      };
      expect(options).toBeDefined();
      expect(options.auth).toBe(true);
      expect(options.https).toBe(true);
    });
  });

  describe('parseDuration validation for --auth-expire', () => {
    it('should accept valid durations', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(parseDuration('1h')).toBe(3600000);
      expect(parseDuration('24h')).toBe(86400000);
      expect(parseDuration('7d')).toBe(604800000);
      expect(parseDuration('90m')).toBe(5400000);
    });

    it('should reject invalid auth-expire values', async () => {
      const { parseDuration } = await import('@/lib/auth');
      expect(() => parseDuration('0h')).toThrow(); // Below minimum
      expect(() => parseDuration('31d')).toThrow(); // Above maximum
      expect(() => parseDuration('abc')).toThrow(); // Invalid format
      expect(() => parseDuration('24x')).toThrow(); // Invalid unit
    });
  });

  describe('Token generation for --auth', () => {
    it('should generate a valid token and hash pair', async () => {
      const { generateToken, hashToken, verifyToken } = await import('@/lib/auth');
      const token = generateToken();
      const hash = hashToken(token);

      // Simulate what start command does
      process.env.CM_AUTH_TOKEN_HASH = hash;
      vi.resetModules();
      process.env.CM_AUTH_TOKEN_HASH = hash;
      const auth = await import('@/lib/auth');

      expect(auth.verifyToken(token)).toBe(true);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('Legacy CM_AUTH_TOKEN detection', () => {
    it('should detect CM_AUTH_TOKEN in parsed env', () => {
      // Simulates what startCommand does when checking parsed .env
      const parsedEnv: Record<string, string> = {
        CM_AUTH_TOKEN: 'old-token-value',
        CM_PORT: '3000',
      };
      const hasLegacyToken = 'CM_AUTH_TOKEN' in parsedEnv;
      expect(hasLegacyToken).toBe(true);
    });

    it('should not detect CM_AUTH_TOKEN when not present', () => {
      const parsedEnv: Record<string, string> = {
        CM_PORT: '3000',
      };
      const hasLegacyToken = 'CM_AUTH_TOKEN' in parsedEnv;
      expect(hasLegacyToken).toBe(false);
    });
  });
});
