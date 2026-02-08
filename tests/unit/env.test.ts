/**
 * Tests for environment variable fallback functionality
 * Issue #76: Environment variable fallback implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getEnvWithFallback,
  getEnvByKey,
  getEnv,
  getLogConfig,
  resetWarnedKeys,
  resetDatabasePathWarning,
  getDatabasePathWithDeprecationWarning,
  ENV_MAPPING,
} from '@/lib/env';

describe('getEnvWithFallback', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetWarnedKeys();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should return new key value when only new key is set', () => {
    process.env.CM_ROOT_DIR = '/new/path';

    const result = getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');

    expect(result).toBe('/new/path');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('should fallback to old key value and warn when only old key is set', () => {
    process.env.MCBD_ROOT_DIR = '/old/path';

    const result = getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');

    expect(result).toBe('/old/path');
    expect(console.warn).toHaveBeenCalledWith(
      '[DEPRECATED] MCBD_ROOT_DIR is deprecated, use CM_ROOT_DIR instead'
    );
  });

  it('should prioritize new key when both are set', () => {
    process.env.CM_ROOT_DIR = '/new/path';
    process.env.MCBD_ROOT_DIR = '/old/path';

    const result = getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');

    expect(result).toBe('/new/path');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('should return undefined when neither key is set', () => {
    const result = getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');

    expect(result).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('should treat empty string as valid value', () => {
    process.env.CM_ROOT_DIR = '';

    const result = getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');

    expect(result).toBe('');
  });

  it('should only warn once for same key across multiple calls', () => {
    process.env.MCBD_ROOT_DIR = '/old/path';

    getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');
    getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');
    getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('should warn separately for different keys', () => {
    process.env.MCBD_ROOT_DIR = '/old/path';
    process.env.MCBD_PORT = '3000';

    getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');
    getEnvWithFallback('CM_PORT', 'MCBD_PORT');

    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe('getEnvByKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetWarnedKeys();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should use ENV_MAPPING for fallback correctly', () => {
    process.env.MCBD_LOG_LEVEL = 'debug';

    const result = getEnvByKey('CM_LOG_LEVEL');

    expect(result).toBe('debug');
    expect(console.warn).toHaveBeenCalledWith(
      '[DEPRECATED] MCBD_LOG_LEVEL is deprecated, use CM_LOG_LEVEL instead'
    );
  });
});

describe('resetWarnedKeys', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should allow warning again after reset', () => {
    process.env.MCBD_ROOT_DIR = '/old/path';

    getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');
    expect(console.warn).toHaveBeenCalledTimes(1);

    resetWarnedKeys();

    getEnvWithFallback('CM_ROOT_DIR', 'MCBD_ROOT_DIR');
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe('getEnv with fallback', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetWarnedKeys();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should work without warning when new names are used', () => {
    process.env.CM_ROOT_DIR = '/test/path';
    process.env.CM_PORT = '4000';
    process.env.CM_BIND = '127.0.0.1';

    const env = getEnv();

    expect(env.CM_ROOT_DIR).toBe('/test/path');
    expect(env.CM_PORT).toBe(4000);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('should work with warning when old names are used', () => {
    process.env.MCBD_ROOT_DIR = '/test/path';
    process.env.MCBD_PORT = '4000';
    process.env.MCBD_BIND = '127.0.0.1';

    const env = getEnv();

    expect(env.CM_ROOT_DIR).toBe('/test/path');
    expect(env.CM_PORT).toBe(4000);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('getLogConfig with fallback', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetWarnedKeys();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should work without warning when new names are used', () => {
    process.env.CM_LOG_LEVEL = 'debug';
    process.env.CM_LOG_FORMAT = 'json';

    const config = getLogConfig();

    expect(config.level).toBe('debug');
    expect(config.format).toBe('json');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('should work with warning when old names are used', () => {
    process.env.MCBD_LOG_LEVEL = 'error';
    process.env.MCBD_LOG_FORMAT = 'text';

    const config = getLogConfig();

    expect(config.level).toBe('error');
    expect(config.format).toBe('text');
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('ENV_MAPPING', () => {
  it('should have exactly 7 environment variable mappings', () => {
    expect(Object.keys(ENV_MAPPING)).toHaveLength(7);
  });

  it('should have correct key format', () => {
    for (const [newKey, oldKey] of Object.entries(ENV_MAPPING)) {
      expect(newKey).toMatch(/^CM_/);
      expect(oldKey).toMatch(/^MCBD_/);
    }
  });

  it('should contain all expected keys', () => {
    expect(ENV_MAPPING).toEqual({
      CM_ROOT_DIR: 'MCBD_ROOT_DIR',
      CM_PORT: 'MCBD_PORT',
      CM_BIND: 'MCBD_BIND',
      CM_LOG_LEVEL: 'MCBD_LOG_LEVEL',
      CM_LOG_FORMAT: 'MCBD_LOG_FORMAT',
      CM_LOG_DIR: 'MCBD_LOG_DIR',
      CM_DB_PATH: 'MCBD_DB_PATH',
    });
  });
});

// Issue #135: DATABASE_PATH deprecation tests
describe('getDatabasePathWithDeprecationWarning', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetDatabasePathWarning();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should return DATABASE_PATH value when set', () => {
    process.env.DATABASE_PATH = '/custom/path/db.sqlite';

    const result = getDatabasePathWithDeprecationWarning();

    expect(result).toBe('/custom/path/db.sqlite');
  });

  it('should return undefined when DATABASE_PATH is not set', () => {
    delete process.env.DATABASE_PATH;

    const result = getDatabasePathWithDeprecationWarning();

    expect(result).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('should output deprecation warning when DATABASE_PATH is set', () => {
    process.env.DATABASE_PATH = '/old/path/db.sqlite';

    getDatabasePathWithDeprecationWarning();

    expect(console.warn).toHaveBeenCalledWith(
      '[DEPRECATED] DATABASE_PATH is deprecated. Use CM_DB_PATH instead.'
    );
  });

  it('should only warn once for multiple calls', () => {
    process.env.DATABASE_PATH = '/old/path/db.sqlite';

    getDatabasePathWithDeprecationWarning();
    getDatabasePathWithDeprecationWarning();
    getDatabasePathWithDeprecationWarning();

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('should warn again after reset', () => {
    process.env.DATABASE_PATH = '/old/path/db.sqlite';

    getDatabasePathWithDeprecationWarning();
    expect(console.warn).toHaveBeenCalledTimes(1);

    resetDatabasePathWarning();

    getDatabasePathWithDeprecationWarning();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

// Issue #135: getEnv uses getDefaultDbPath tests
describe('getEnv with DB path resolution (Issue #135)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetWarnedKeys();
    resetDatabasePathWarning();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should use CM_DB_PATH when set', () => {
    process.env.CM_ROOT_DIR = '/test/path';
    process.env.CM_DB_PATH = '/custom/cm.db';

    const env = getEnv();

    expect(env.CM_DB_PATH).toBe('/custom/cm.db');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('should fallback to DATABASE_PATH with warning when CM_DB_PATH not set', () => {
    process.env.CM_ROOT_DIR = '/test/path';
    delete process.env.CM_DB_PATH;
    delete process.env.MCBD_DB_PATH;
    process.env.DATABASE_PATH = '/legacy/db.sqlite';

    const env = getEnv();

    expect(env.CM_DB_PATH).toBe('/legacy/db.sqlite');
    expect(console.warn).toHaveBeenCalledWith(
      '[DEPRECATED] DATABASE_PATH is deprecated. Use CM_DB_PATH instead.'
    );
  });

  it('should use default path when no DB path env vars set', () => {
    process.env.CM_ROOT_DIR = '/test/path';
    delete process.env.CM_DB_PATH;
    delete process.env.MCBD_DB_PATH;
    delete process.env.DATABASE_PATH;

    const env = getEnv();

    // Should be an absolute path ending with cm.db
    expect(env.CM_DB_PATH.endsWith('cm.db')).toBe(true);
    expect(env.CM_DB_PATH.startsWith('/')).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('should return absolute path for CM_DB_PATH', () => {
    process.env.CM_ROOT_DIR = '/test/path';
    delete process.env.CM_DB_PATH;
    delete process.env.MCBD_DB_PATH;
    delete process.env.DATABASE_PATH;

    const env = getEnv();

    // Path should be absolute
    expect(env.CM_DB_PATH.startsWith('/')).toBe(true);
  });
});
