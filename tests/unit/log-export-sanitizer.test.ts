/**
 * Unit Tests: log-export-sanitizer.ts
 * Issue #11: Log export sanitization for privacy-safe log sharing
 *
 * Tests sanitization of sensitive information including:
 * - HOME directory path masking
 * - CM_ROOT_DIR (project root) masking
 * - CM_DB_PATH masking
 * - Hostname masking via os.hostname()
 * - Bearer token masking
 * - Password/token/secret key-value masking
 * - SSH private key masking
 * - Known environment variable value masking
 * - Longest-match-first sorting
 * - Edge cases (unset vars, relative paths, error messages)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock os module for hostname
vi.mock('os', () => ({
  default: {
    hostname: vi.fn(() => 'test-hostname.local'),
  },
  hostname: vi.fn(() => 'test-hostname.local'),
}));

// Mock env module
vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({
    CM_ROOT_DIR: '/Users/testuser/projects/myproject',
    CM_DB_PATH: '/Users/testuser/projects/myproject/data/commandmate.db',
    CM_PORT: 3000,
    CM_BIND: '127.0.0.1',
  })),
}));

describe('log-export-sanitizer', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = '/Users/testuser';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  describe('sanitizeForExport', () => {
    it('should mask HOME directory path with [HOME]', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'Error at /Users/testuser/.config/some-file';
      const result = sanitizeForExport(input);
      expect(result).toContain('[HOME]');
      expect(result).not.toContain('/Users/testuser');
    });

    it('should mask CM_ROOT_DIR with [PROJECT]', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'Working in /Users/testuser/projects/myproject/src/lib';
      const result = sanitizeForExport(input);
      expect(result).toContain('[PROJECT]');
    });

    it('should mask CM_DB_PATH with [DB_PATH]', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'Database: /Users/testuser/projects/myproject/data/commandmate.db';
      const result = sanitizeForExport(input);
      expect(result).toContain('[DB_PATH]');
    });

    it('should mask hostname with [HOST]', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'Connected to test-hostname.local on port 3000';
      const result = sanitizeForExport(input);
      expect(result).toContain('[HOST]');
      expect(result).not.toContain('test-hostname.local');
    });

    it('should mask Bearer tokens with [REDACTED]', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'Authorization: Bearer sk-ant-api03-xxxx-yyyy-zzzz';
      const result = sanitizeForExport(input);
      expect(result).not.toContain('sk-ant-api03-xxxx-yyyy-zzzz');
      expect(result).toContain('[REDACTED]');
    });

    it('should mask Authorization header values', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'Header: Authorization: Basic dXNlcjpwYXNz';
      const result = sanitizeForExport(input);
      expect(result).not.toContain('Basic dXNlcjpwYXNz');
    });

    it('should mask password key-value pairs', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'Config: password=mysecretpassword123';
      const result = sanitizeForExport(input);
      expect(result).not.toContain('mysecretpassword123');
      expect(result).toContain('[REDACTED]');
    });

    it('should mask token key-value pairs', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'token=ghp_1234567890abcdef';
      const result = sanitizeForExport(input);
      expect(result).not.toContain('ghp_1234567890abcdef');
    });

    it('should mask secret/api-key key-value pairs', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'secret: super_secret_value\napi_key=sk-abc123';
      const result = sanitizeForExport(input);
      expect(result).not.toContain('super_secret_value');
      expect(result).not.toContain('sk-abc123');
    });

    it('should mask SSH private keys', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      const result = sanitizeForExport(input);
      expect(result).not.toContain('MIIEpAIBAAKCAQEA');
      expect(result).toContain('[SSH_PRIVATE_KEY_REDACTED]');
    });

    it('should mask OPENSSH private keys', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA...\n-----END OPENSSH PRIVATE KEY-----';
      const result = sanitizeForExport(input);
      expect(result).toContain('[SSH_PRIVATE_KEY_REDACTED]');
    });

    it('should mask known environment variable values (GITHUB_TOKEN, etc.)', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'GITHUB_TOKEN=ghp_abcdef123456\nOPENAI_API_KEY=sk-openai-xyz';
      const result = sanitizeForExport(input);
      expect(result).not.toContain('ghp_abcdef123456');
      expect(result).not.toContain('sk-openai-xyz');
    });

    it('should preserve relative paths and filenames', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'File: src/lib/utils.ts at line 42';
      const result = sanitizeForExport(input);
      expect(result).toBe('File: src/lib/utils.ts at line 42');
    });

    it('should preserve error messages', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'TypeError: Cannot read property "foo" of undefined';
      const result = sanitizeForExport(input);
      expect(result).toBe('TypeError: Cannot read property "foo" of undefined');
    });

    it('should apply longest match first to prevent double replacement', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      // CM_DB_PATH is longer and contains CM_ROOT_DIR prefix
      // CM_DB_PATH: /Users/testuser/projects/myproject/data/commandmate.db
      // CM_ROOT_DIR: /Users/testuser/projects/myproject
      // HOME: /Users/testuser
      const input = 'DB at: /Users/testuser/projects/myproject/data/commandmate.db';
      const result = sanitizeForExport(input);
      // DB_PATH should match first since it's longest
      expect(result).toContain('[DB_PATH]');
      // Should NOT contain a partial double replacement
      expect(result).not.toContain('[HOME]/projects/myproject/data/commandmate.db');
    });

    it('should handle safely when HOME is not set', async () => {
      // Need to reset modules to re-import with different env
      vi.resetModules();

      // Re-mock dependencies
      vi.doMock('os', () => ({
        default: { hostname: vi.fn(() => 'test-hostname.local') },
        hostname: vi.fn(() => 'test-hostname.local'),
      }));
      vi.doMock('@/lib/env', () => ({
        getEnv: vi.fn(() => ({
          CM_ROOT_DIR: '/opt/project',
          CM_DB_PATH: '/opt/project/data/db.sqlite',
          CM_PORT: 3000,
          CM_BIND: '127.0.0.1',
        })),
      }));

      const savedHome = process.env.HOME;
      delete process.env.HOME;

      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'Some log content without sensitive data';
      const result = sanitizeForExport(input);
      expect(result).toBe('Some log content without sensitive data');

      process.env.HOME = savedHome;
    });

    it('should not leave /Users/* or /home/* patterns in output for known paths', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'Path: /Users/testuser/projects/myproject/src/file.ts';
      const result = sanitizeForExport(input);
      // HOME path (/Users/testuser) should be masked
      expect(result).not.toMatch(/\/Users\/testuser/);
    });

    it('should handle multiple occurrences of the same sensitive value', async () => {
      const { sanitizeForExport } = await import('@/lib/log-export-sanitizer');
      const input = 'From /Users/testuser to /Users/testuser again';
      const result = sanitizeForExport(input);
      // Both occurrences should be masked
      expect(result).not.toContain('/Users/testuser');
      expect(result).toBe('From [HOME] to [HOME] again');
    });
  });
});
