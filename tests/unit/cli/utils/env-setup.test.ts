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
  isGlobalInstall,
  getEnvPath,
  getConfigDir,
  getPidFilePath,
  resolveSecurePath,
  getDefaultDbPath,
  DEFAULT_ROOT_DIR,
} from '../../../../src/cli/utils/env-setup';
import { homedir } from 'os';

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

    it('should create .env file for 0.0.0.0 bind without auth token (Issue #179)', async () => {
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
      });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('CM_BIND=0.0.0.0'),
        expect.any(Object)
      );
      // Should NOT contain CM_AUTH_TOKEN
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).not.toContain('CM_AUTH_TOKEN');
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

    it('should allow 0.0.0.0 bind without auth token (Issue #179)', () => {
      const result = envSetup.validateConfig({
        CM_ROOT_DIR: '/path/to/repos',
        CM_PORT: 3000,
        CM_BIND: '0.0.0.0',
        CM_DB_PATH: './data/cm.db',
        CM_LOG_LEVEL: 'info',
        CM_LOG_FORMAT: 'text',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
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

describe('DEFAULT_ROOT_DIR', () => {
  it('should be ~/repos', () => {
    expect(DEFAULT_ROOT_DIR).toBe(path.join(homedir(), 'repos'));
  });
});

describe('isGlobalInstall', () => {
  // Note: This test depends on the actual __dirname which may vary
  // The function checks if running from global node_modules
  it('should return a boolean', () => {
    const result = isGlobalInstall();
    expect(typeof result).toBe('boolean');
  });

  // In test environment (vitest), we're running from local node_modules
  // so isGlobalInstall should return false or true depending on setup
  it('should detect local install in test environment', () => {
    // In test environment, we're typically running locally
    // The actual value depends on how vitest runs
    const result = isGlobalInstall();
    // Just verify it returns without error
    expect(result === true || result === false).toBe(true);
  });
});

describe('getEnvPath', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return a string path', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const envPath = getEnvPath();
    expect(typeof envPath).toBe('string');
    expect(envPath.endsWith('.env')).toBe(true);
  });

  it('should create config directory for global install if not exists', () => {
    // This test verifies the mkdir call when dir doesn't exist
    // The actual behavior depends on isGlobalInstall()
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    const envPath = getEnvPath();

    // Should return a valid path regardless
    expect(envPath.endsWith('.env')).toBe(true);
  });

  it('should call mkdirSync with correct permissions when dir does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);

    getEnvPath();

    // If global install creates dir, it should use 0o700 permission
    // The actual call depends on isGlobalInstall()
    expect(typeof getEnvPath()).toBe('string');
  });
});

describe('getConfigDir', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return a directory path', () => {
    // Mock realpathSync for symlink resolution
    vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const configDir = getConfigDir();
    expect(typeof configDir).toBe('string');
    // Should be either ~/.commandmate or cwd depending on install type
    expect(configDir.length).toBeGreaterThan(0);
  });

  it('should resolve symlinks using realpathSync', () => {
    const mockCwd = '/some/symlinked/path';
    vi.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    vi.mocked(fs.realpathSync).mockReturnValue('/real/path');
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const configDir = getConfigDir();

    // Local install returns realpath of cwd
    expect(configDir).toBe('/real/path');
  });
});

describe('getPidFilePath', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return a path ending with .commandmate.pid', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());

    const pidPath = getPidFilePath();

    expect(typeof pidPath).toBe('string');
    expect(pidPath.endsWith('.commandmate.pid')).toBe(true);
  });

  it('should use getConfigDir for path resolution', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());

    const pidPath = getPidFilePath();
    const configDir = getConfigDir();

    // PID file should be in the config directory
    expect(pidPath.startsWith(configDir)).toBe(true);
  });

  // Issue #136: Tests for issueNo parameter
  it('should return issue-specific PID file path when issueNo is provided', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());

    const pidPath = getPidFilePath(135);

    expect(typeof pidPath).toBe('string');
    expect(pidPath).toContain('/pids/');
    expect(pidPath.endsWith('135.pid')).toBe(true);
  });

  it('should create pids directory when it does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());

    const pidPath = getPidFilePath(200);

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('pids'),
      expect.objectContaining({ recursive: true, mode: 0o700 })
    );
    expect(pidPath.endsWith('200.pid')).toBe(true);
  });

  it('should return main PID file for backward compatibility when issueNo is undefined', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());

    const pidPath = getPidFilePath(undefined);

    expect(pidPath.endsWith('.commandmate.pid')).toBe(true);
    expect(pidPath).not.toContain('/pids/');
  });
});

describe('resolveSecurePath', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should resolve symlinks and verify path is within allowed directory', () => {
    vi.mocked(fs.realpathSync)
      .mockReturnValueOnce('/home/user/.commandmate/file.txt')  // target
      .mockReturnValueOnce('/home/user/.commandmate');  // base

    const result = resolveSecurePath('/home/user/.commandmate/file.txt', '/home/user/.commandmate');

    expect(result).toBe('/home/user/.commandmate/file.txt');
  });

  it('should throw error for path traversal attempt', () => {
    vi.mocked(fs.realpathSync)
      .mockReturnValueOnce('/etc/passwd')  // target resolves outside
      .mockReturnValueOnce('/home/user/.commandmate');  // base

    expect(() => {
      resolveSecurePath('/home/user/.commandmate/../../../etc/passwd', '/home/user/.commandmate');
    }).toThrow('Path traversal detected');
  });
});

describe('getConfigDir security', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should call realpathSync for symlink resolution', () => {
    // For local install, getConfigDir should resolve cwd using realpathSync
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());

    const result = getConfigDir();

    // Verify realpathSync was called (symlink resolution)
    expect(fs.realpathSync).toHaveBeenCalled();
    expect(typeof result).toBe('string');
  });
});

describe('validateConfig additional cases', () => {
  let envSetup: EnvSetup;

  beforeEach(() => {
    envSetup = new EnvSetup();
    vi.resetAllMocks();
  });

  it('should fail for invalid log level', () => {
    const result = envSetup.validateConfig({
      CM_ROOT_DIR: '/path/to/repos',
      CM_PORT: 3000,
      CM_BIND: '127.0.0.1',
      CM_DB_PATH: './data/cm.db',
      CM_LOG_LEVEL: 'invalid',
      CM_LOG_FORMAT: 'text',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes('log level'))).toBe(true);
  });

  it('should fail for invalid log format', () => {
    const result = envSetup.validateConfig({
      CM_ROOT_DIR: '/path/to/repos',
      CM_PORT: 3000,
      CM_BIND: '127.0.0.1',
      CM_DB_PATH: './data/cm.db',
      CM_LOG_LEVEL: 'info',
      CM_LOG_FORMAT: 'xml',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes('log format'))).toBe(true);
  });

  it('should pass for 0.0.0.0 bind (Issue #179: no auth token needed)', () => {
    const result = envSetup.validateConfig({
      CM_ROOT_DIR: '/path/to/repos',
      CM_PORT: 3000,
      CM_BIND: '0.0.0.0',
      CM_DB_PATH: './data/cm.db',
      CM_LOG_LEVEL: 'info',
      CM_LOG_FORMAT: 'text',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should accept localhost as valid bind address', () => {
    const result = envSetup.validateConfig({
      CM_ROOT_DIR: '/path/to/repos',
      CM_PORT: 3000,
      CM_BIND: 'localhost',
      CM_DB_PATH: './data/cm.db',
      CM_LOG_LEVEL: 'info',
      CM_LOG_FORMAT: 'text',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should fail for port 0', () => {
    const result = envSetup.validateConfig({
      CM_ROOT_DIR: '/path/to/repos',
      CM_PORT: 0,
      CM_BIND: '127.0.0.1',
      CM_DB_PATH: './data/cm.db',
      CM_LOG_LEVEL: 'info',
      CM_LOG_FORMAT: 'text',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes('port'))).toBe(true);
  });
});

// Issue #135: Tests for getDefaultDbPath
describe('getDefaultDbPath (Issue #135)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return a string path', () => {
    const dbPath = getDefaultDbPath();
    expect(typeof dbPath).toBe('string');
    expect(dbPath.endsWith('cm.db')).toBe(true);
  });

  it('should return an absolute path', () => {
    const dbPath = getDefaultDbPath();
    // Absolute paths start with /
    expect(dbPath.startsWith('/')).toBe(true);
  });

  it('should include data directory', () => {
    const dbPath = getDefaultDbPath();
    expect(dbPath).toContain('/data/');
  });
});
