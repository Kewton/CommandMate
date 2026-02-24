/**
 * Tests for env-sanitizer.ts
 * Issue #294: Environment variable sanitization for child processes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SENSITIVE_ENV_KEYS,
  sanitizeEnvForChildProcess,
} from '../../../src/lib/env-sanitizer';

describe('env-sanitizer', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set all sensitive keys to test values
    for (const key of SENSITIVE_ENV_KEYS) {
      process.env[key] = `test-value-${key}`;
    }
    // Set some non-sensitive keys
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/testuser';
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('SENSITIVE_ENV_KEYS', () => {
    it('should contain all expected sensitive keys', () => {
      expect(SENSITIVE_ENV_KEYS).toContain('CLAUDECODE');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_AUTH_TOKEN_HASH');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_AUTH_EXPIRE');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_HTTPS_KEY');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_HTTPS_CERT');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_ALLOWED_IPS');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_TRUST_PROXY');
      expect(SENSITIVE_ENV_KEYS).toContain('CM_DB_PATH');
    });

    it('should have exactly 8 entries', () => {
      expect(SENSITIVE_ENV_KEYS).toHaveLength(8);
    });
  });

  describe('sanitizeEnvForChildProcess', () => {
    it('should remove all sensitive environment variables', () => {
      const sanitized = sanitizeEnvForChildProcess();

      for (const key of SENSITIVE_ENV_KEYS) {
        expect(sanitized[key]).toBeUndefined();
      }
    });

    it('should preserve non-sensitive environment variables', () => {
      const sanitized = sanitizeEnvForChildProcess();

      expect(sanitized.PATH).toBe('/usr/bin');
      expect(sanitized.HOME).toBe('/home/testuser');
      expect(sanitized.NODE_ENV).toBe('test');
    });

    it('should not modify the original process.env', () => {
      sanitizeEnvForChildProcess();

      for (const key of SENSITIVE_ENV_KEYS) {
        expect(process.env[key]).toBe(`test-value-${key}`);
      }
    });

    it('should return a new object (not a reference to process.env)', () => {
      const sanitized = sanitizeEnvForChildProcess();

      expect(sanitized).not.toBe(process.env);
    });

    it('should handle when sensitive keys are not set', () => {
      // Clear all sensitive keys
      for (const key of SENSITIVE_ENV_KEYS) {
        delete process.env[key];
      }

      const sanitized = sanitizeEnvForChildProcess();

      for (const key of SENSITIVE_ENV_KEYS) {
        expect(sanitized[key]).toBeUndefined();
      }
      // Non-sensitive keys should still be present
      expect(sanitized.PATH).toBe('/usr/bin');
    });

    it('should remove CLAUDECODE specifically (session isolation)', () => {
      process.env.CLAUDECODE = '1';
      const sanitized = sanitizeEnvForChildProcess();
      expect(sanitized.CLAUDECODE).toBeUndefined();
    });

    it('should remove CM_DB_PATH (database isolation)', () => {
      process.env.CM_DB_PATH = '/path/to/db.sqlite';
      const sanitized = sanitizeEnvForChildProcess();
      expect(sanitized.CM_DB_PATH).toBeUndefined();
    });
  });
});
