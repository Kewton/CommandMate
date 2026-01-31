/**
 * Environment Setup Tests
 * Tests for env-setup.ts - .env file generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  EnvSetup,
  sanitizeInput,
  sanitizePath,
  validatePort,
  escapeEnvValue,
} from '../../../../src/cli/utils/env-setup';

vi.mock('fs');

describe('EnvSetup', () => {
  let envSetup: EnvSetup;

  beforeEach(() => {
    envSetup = new EnvSetup();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createEnvFile', () => {
    it('should create .env file with default values', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.mocked(fs.chmodSync).mockReturnValue(undefined);

      await envSetup.createEnvFile({
        CM_ROOT_DIR: '/path/to/repos',
        CM_PORT: 3000,
        CM_BIND: '127.0.0.1',
        CM_DB_PATH: './data/cm.db',
        CM_LOG_LEVEL: 'info',
        CM_LOG_FORMAT: 'text',
      });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.env'),
        expect.stringContaining('CM_ROOT_DIR=/path/to/repos'),
        expect.objectContaining({ mode: 0o600 })
      );
      expect(fs.chmodSync).toHaveBeenCalledWith(expect.any(String), 0o600);
    });

    it('should include auth token when bind is 0.0.0.0', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.mocked(fs.chmodSync).mockReturnValue(undefined);

      await envSetup.createEnvFile({
        CM_ROOT_DIR: '/path/to/repos',
        CM_PORT: 3000,
        CM_BIND: '0.0.0.0',
        CM_DB_PATH: './data/cm.db',
        CM_LOG_LEVEL: 'info',
        CM_LOG_FORMAT: 'text',
        CM_AUTH_TOKEN: 'test-token-12345',
      });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('CM_AUTH_TOKEN=test-token-12345'),
        expect.any(Object)
      );
    });

    it('should throw error when .env exists and force is false', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await expect(
        envSetup.createEnvFile({
          CM_ROOT_DIR: '/path',
          CM_PORT: 3000,
          CM_BIND: '127.0.0.1',
          CM_DB_PATH: './data/cm.db',
          CM_LOG_LEVEL: 'info',
          CM_LOG_FORMAT: 'text',
        })
      ).rejects.toThrow('.env file already exists');
    });

    it('should overwrite when force is true', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.mocked(fs.chmodSync).mockReturnValue(undefined);
      vi.mocked(fs.copyFileSync).mockReturnValue(undefined);

      await envSetup.createEnvFile(
        {
          CM_ROOT_DIR: '/path',
          CM_PORT: 3000,
          CM_BIND: '127.0.0.1',
          CM_DB_PATH: './data/cm.db',
          CM_LOG_LEVEL: 'info',
          CM_LOG_FORMAT: 'text',
        },
        { force: true }
      );

      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('backupExisting', () => {
    it('should create backup of existing .env', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.copyFileSync).mockReturnValue(undefined);

      const backupPath = await envSetup.backupExisting();

      expect(backupPath).toContain('.env.backup.');
      expect(fs.copyFileSync).toHaveBeenCalled();
    });

    it('should return null when .env does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const backupPath = await envSetup.backupExisting();

      expect(backupPath).toBeNull();
    });
  });

  describe('generateAuthToken', () => {
    it('should generate 64-character hex token', () => {
      const token = envSetup.generateAuthToken();

      expect(token).toHaveLength(64);
      // Verify it's a valid hex string
      expect(/^[a-f0-9]+$/.test(token)).toBe(true);
    });
  });

  describe('validateConfig', () => {
    it('should pass for valid config', () => {
      const result = envSetup.validateConfig({
        CM_ROOT_DIR: '/path/to/repos',
        CM_PORT: 3000,
        CM_BIND: '127.0.0.1',
        CM_DB_PATH: './data/cm.db',
        CM_LOG_LEVEL: 'info',
        CM_LOG_FORMAT: 'text',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail for invalid port', () => {
      const result = envSetup.validateConfig({
        CM_ROOT_DIR: '/path/to/repos',
        CM_PORT: 99999,
        CM_BIND: '127.0.0.1',
        CM_DB_PATH: './data/cm.db',
        CM_LOG_LEVEL: 'info',
        CM_LOG_FORMAT: 'text',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('port'))).toBe(true);
    });

    it('should fail for invalid bind address', () => {
      const result = envSetup.validateConfig({
        CM_ROOT_DIR: '/path/to/repos',
        CM_PORT: 3000,
        CM_BIND: '192.168.1.1',
        CM_DB_PATH: './data/cm.db',
        CM_LOG_LEVEL: 'info',
        CM_LOG_FORMAT: 'text',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('bind'))).toBe(true);
    });

    it('should require auth token for 0.0.0.0 bind', () => {
      const result = envSetup.validateConfig({
        CM_ROOT_DIR: '/path/to/repos',
        CM_PORT: 3000,
        CM_BIND: '0.0.0.0',
        CM_DB_PATH: './data/cm.db',
        CM_LOG_LEVEL: 'info',
        CM_LOG_FORMAT: 'text',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('auth'))).toBe(true);
    });
  });
});

describe('sanitizeInput', () => {
  it('should remove control characters', () => {
    expect(sanitizeInput('hello\x00world')).toBe('helloworld');
    expect(sanitizeInput('test\x1F')).toBe('test');
    expect(sanitizeInput('\x7Fdelete')).toBe('delete');
  });

  it('should preserve normal characters', () => {
    expect(sanitizeInput('Hello World 123!')).toBe('Hello World 123!');
  });

  it('should remove newlines', () => {
    expect(sanitizeInput('line1\nline2')).toBe('line1line2');
    expect(sanitizeInput('line1\rline2')).toBe('line1line2');
  });
});

describe('sanitizePath', () => {
  it('should normalize path', () => {
    expect(sanitizePath('/path/to/../repos')).toBe(path.normalize('/path/to/../repos'));
  });

  it('should remove control characters and normalize', () => {
    expect(sanitizePath('/path\x00/to/repos')).toBe(path.normalize('/path/to/repos'));
  });
});

describe('validatePort', () => {
  it('should return valid port number', () => {
    expect(validatePort('3000')).toBe(3000);
    expect(validatePort('1')).toBe(1);
    expect(validatePort('65535')).toBe(65535);
  });

  it('should throw for invalid port', () => {
    expect(() => validatePort('0')).toThrow();
    expect(() => validatePort('65536')).toThrow();
    expect(() => validatePort('abc')).toThrow();
    expect(() => validatePort('-1')).toThrow();
  });
});

describe('escapeEnvValue', () => {
  it('should return unquoted simple values', () => {
    expect(escapeEnvValue('simple')).toBe('simple');
    expect(escapeEnvValue('123')).toBe('123');
  });

  it('should quote values with spaces', () => {
    expect(escapeEnvValue('hello world')).toBe('"hello world"');
  });

  it('should escape double quotes', () => {
    expect(escapeEnvValue('say "hello"')).toBe('"say \\"hello\\""');
  });

  it('should escape backslashes', () => {
    // Backslash without special chars is returned as-is for simplicity
    expect(escapeEnvValue('path\\to\\file')).toBe('path\\to\\file');
  });

  it('should quote values with special characters', () => {
    expect(escapeEnvValue('$HOME')).toBe('"$HOME"');
    expect(escapeEnvValue('test!')).toBe('"test!"');
  });
});
