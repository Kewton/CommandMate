/**
 * Log Configuration Tests
 * Issue #11: LOG_DIR constant centralization
 *
 * Tests for src/config/log-config.ts - getLogDir() function
 * that centralizes LOG_DIR definition previously duplicated in
 * log-manager.ts and logs/[filename]/route.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock env module before importing the module under test
vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(),
  getEnvByKey: vi.fn(),
}));

import { getLogDir } from '@/config/log-config';
import { getEnvByKey } from '@/lib/env';

describe('log-config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear CM_LOG_DIR and MCBD_LOG_DIR from process.env
    delete process.env.CM_LOG_DIR;
    delete process.env.MCBD_LOG_DIR;
  });

  afterEach(() => {
    // Restore original environment
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  describe('getLogDir', () => {
    it('should return CM_LOG_DIR when set via getEnvByKey', () => {
      const customLogDir = '/custom/log/dir';
      vi.mocked(getEnvByKey).mockReturnValue(customLogDir);

      const result = getLogDir();

      expect(result).toBe(customLogDir);
      expect(getEnvByKey).toHaveBeenCalledWith('CM_LOG_DIR');
    });

    it('should return default path based on process.cwd() when CM_LOG_DIR is not set', () => {
      vi.mocked(getEnvByKey).mockReturnValue(undefined);

      const result = getLogDir();

      const expected = `${process.cwd()}/data/logs`;
      expect(result).toBe(expected);
    });

    it('should call getEnvByKey with CM_LOG_DIR key', () => {
      vi.mocked(getEnvByKey).mockReturnValue(undefined);

      getLogDir();

      expect(getEnvByKey).toHaveBeenCalledWith('CM_LOG_DIR');
      expect(getEnvByKey).toHaveBeenCalledTimes(1);
    });

    it('should return string type', () => {
      vi.mocked(getEnvByKey).mockReturnValue(undefined);

      const result = getLogDir();

      expect(typeof result).toBe('string');
    });

    it('should return a non-empty string', () => {
      vi.mocked(getEnvByKey).mockReturnValue(undefined);

      const result = getLogDir();

      expect(result.length).toBeGreaterThan(0);
    });

    it('should return path ending with data/logs when CM_LOG_DIR is not set', () => {
      vi.mocked(getEnvByKey).mockReturnValue(undefined);

      const result = getLogDir();

      expect(result).toMatch(/data\/logs$/);
    });

    it('should return the exact custom path without appending anything when CM_LOG_DIR is set', () => {
      const customPath = '/my/custom/logs';
      vi.mocked(getEnvByKey).mockReturnValue(customPath);

      const result = getLogDir();

      expect(result).toBe(customPath);
    });
  });
});
