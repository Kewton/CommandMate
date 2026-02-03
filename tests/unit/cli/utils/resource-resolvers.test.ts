/**
 * Resource Resolvers Tests
 * Issue #136: Phase 1 - Task 1.2
 * Tests for DbPathResolver, PidPathResolver, LogPathResolver
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

// Mock fs and install-context
vi.mock('fs');
vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: vi.fn(() => path.join(homedir(), '.commandmate')),
}));

import {
  ResourcePathResolver,
  DbPathResolver,
  PidPathResolver,
  LogPathResolver,
  createDbPathResolver,
  createPidPathResolver,
  createLogPathResolver,
} from '../../../../src/cli/utils/resource-resolvers';
import { getConfigDir } from '../../../../src/cli/utils/install-context';

describe('resource-resolvers', () => {
  const mockGetConfigDir = vi.mocked(getConfigDir);
  const mockConfigDir = path.join(homedir(), '.commandmate');

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetConfigDir.mockReturnValue(mockConfigDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ResourcePathResolver interface', () => {
    it('should define resolve and validate methods', () => {
      const resolver: ResourcePathResolver = new DbPathResolver();
      expect(typeof resolver.resolve).toBe('function');
      expect(typeof resolver.validate).toBe('function');
    });
  });

  describe('DbPathResolver', () => {
    describe('resolve', () => {
      it('should return default db path when no issueNo provided', () => {
        const resolver = new DbPathResolver();
        const result = resolver.resolve();

        expect(result).toBe(path.join(mockConfigDir, 'data', 'cm.db'));
      });

      it('should return issue-specific db path when issueNo provided', () => {
        const resolver = new DbPathResolver();
        const result = resolver.resolve(135);

        expect(result).toBe(path.join(mockConfigDir, 'data', 'cm-135.db'));
      });

      it('should handle various issue numbers', () => {
        const resolver = new DbPathResolver();

        expect(resolver.resolve(1)).toContain('cm-1.db');
        expect(resolver.resolve(999)).toContain('cm-999.db');
        expect(resolver.resolve(123456)).toContain('cm-123456.db');
      });
    });

    describe('validate', () => {
      it('should return true for valid path within config directory', () => {
        const validPath = path.join(mockConfigDir, 'data', 'cm.db');
        vi.mocked(fs.realpathSync).mockReturnValue(validPath);

        const resolver = new DbPathResolver();
        const result = resolver.validate(validPath);

        expect(result).toBe(true);
      });

      it('should return false for path outside config directory (path traversal)', () => {
        const maliciousPath = '/etc/passwd';
        vi.mocked(fs.realpathSync).mockReturnValue('/etc/passwd');

        const resolver = new DbPathResolver();
        const result = resolver.validate(maliciousPath);

        expect(result).toBe(false);
      });

      it('should handle ENOENT for new files by checking parent directory', () => {
        const newFilePath = path.join(mockConfigDir, 'data', 'cm-new.db');
        const parentDir = path.join(mockConfigDir, 'data');

        // First call for file throws ENOENT, second call for parent succeeds
        vi.mocked(fs.realpathSync)
          .mockImplementationOnce(() => {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          })
          .mockReturnValueOnce(parentDir);

        const resolver = new DbPathResolver();
        const result = resolver.validate(newFilePath);

        expect(result).toBe(true);
      });

      it('should return false when parent directory is also outside config', () => {
        const maliciousPath = '/tmp/cm.db';

        vi.mocked(fs.realpathSync)
          .mockImplementationOnce(() => {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          })
          .mockReturnValueOnce('/tmp');

        const resolver = new DbPathResolver();
        const result = resolver.validate(maliciousPath);

        expect(result).toBe(false);
      });

      it('should return false for other filesystem errors', () => {
        vi.mocked(fs.realpathSync).mockImplementation(() => {
          const error = new Error('EACCES') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        });

        const resolver = new DbPathResolver();
        const result = resolver.validate('/some/path');

        expect(result).toBe(false);
      });
    });
  });

  describe('PidPathResolver', () => {
    describe('resolve', () => {
      it('should return main PID path when no issueNo provided (backward compatibility)', () => {
        const resolver = new PidPathResolver();
        const result = resolver.resolve();

        expect(result).toBe(path.join(mockConfigDir, '.commandmate.pid'));
      });

      it('should return issue-specific PID path in pids/ directory', () => {
        const resolver = new PidPathResolver();
        const result = resolver.resolve(135);

        expect(result).toBe(path.join(mockConfigDir, 'pids', '135.pid'));
      });

      it('should handle various issue numbers', () => {
        const resolver = new PidPathResolver();

        expect(resolver.resolve(1)).toContain(path.join('pids', '1.pid'));
        expect(resolver.resolve(999)).toContain(path.join('pids', '999.pid'));
      });
    });

    describe('validate', () => {
      it('should return true for valid PID path within config directory', () => {
        const validPath = path.join(mockConfigDir, '.commandmate.pid');
        vi.mocked(fs.realpathSync).mockReturnValue(validPath);

        const resolver = new PidPathResolver();
        const result = resolver.validate(validPath);

        expect(result).toBe(true);
      });

      it('should return true for valid PID path in pids/ directory', () => {
        const validPath = path.join(mockConfigDir, 'pids', '135.pid');
        vi.mocked(fs.realpathSync).mockReturnValue(validPath);

        const resolver = new PidPathResolver();
        const result = resolver.validate(validPath);

        expect(result).toBe(true);
      });

      it('should return false for path outside config directory', () => {
        vi.mocked(fs.realpathSync).mockReturnValue('/var/run/evil.pid');

        const resolver = new PidPathResolver();
        const result = resolver.validate('/var/run/evil.pid');

        expect(result).toBe(false);
      });
    });
  });

  describe('LogPathResolver', () => {
    describe('resolve', () => {
      it('should return main log path when no issueNo provided', () => {
        const resolver = new LogPathResolver();
        const result = resolver.resolve();

        expect(result).toBe(path.join(mockConfigDir, 'logs', 'commandmate.log'));
      });

      it('should return issue-specific log path', () => {
        const resolver = new LogPathResolver();
        const result = resolver.resolve(135);

        expect(result).toBe(path.join(mockConfigDir, 'logs', 'commandmate-135.log'));
      });

      it('should handle various issue numbers', () => {
        const resolver = new LogPathResolver();

        expect(resolver.resolve(1)).toContain('commandmate-1.log');
        expect(resolver.resolve(999)).toContain('commandmate-999.log');
      });
    });

    describe('validate', () => {
      it('should return true for valid log path within logs directory', () => {
        const logsDir = path.join(mockConfigDir, 'logs');
        const validPath = path.join(logsDir, 'commandmate.log');
        vi.mocked(fs.realpathSync).mockReturnValue(validPath);

        const resolver = new LogPathResolver();
        const result = resolver.validate(validPath);

        expect(result).toBe(true);
      });

      it('should return false for path outside logs directory', () => {
        vi.mocked(fs.realpathSync).mockReturnValue('/var/log/evil.log');

        const resolver = new LogPathResolver();
        const result = resolver.validate('/var/log/evil.log');

        expect(result).toBe(false);
      });

      it('should handle ENOENT by checking logs directory exists within config', () => {
        const logsDir = path.join(mockConfigDir, 'logs');

        vi.mocked(fs.realpathSync)
          .mockImplementationOnce(() => {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          })
          .mockReturnValueOnce(logsDir);

        const resolver = new LogPathResolver();
        const result = resolver.validate(path.join(logsDir, 'new.log'));

        expect(result).toBe(true);
      });
    });
  });

  describe('Factory functions', () => {
    it('createDbPathResolver should return DbPathResolver instance', () => {
      const resolver = createDbPathResolver();
      expect(resolver).toBeInstanceOf(DbPathResolver);
    });

    it('createPidPathResolver should return PidPathResolver instance', () => {
      const resolver = createPidPathResolver();
      expect(resolver).toBeInstanceOf(PidPathResolver);
    });

    it('createLogPathResolver should return LogPathResolver instance', () => {
      const resolver = createLogPathResolver();
      expect(resolver).toBeInstanceOf(LogPathResolver);
    });
  });

  describe('TOCTOU Protection (SF-SEC-001)', () => {
    it('DbPathResolver.validate should use try-catch pattern', () => {
      const resolver = new DbPathResolver();

      // Simulate race condition - file is deleted between check and use
      vi.mocked(fs.realpathSync).mockImplementation(() => {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      // Should not throw, but return false gracefully
      const result = resolver.validate('/some/deleted/file.db');
      expect(result).toBe(false);
    });

    it('PidPathResolver.validate should use try-catch pattern', () => {
      const resolver = new PidPathResolver();

      vi.mocked(fs.realpathSync).mockImplementation(() => {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const result = resolver.validate('/some/deleted/file.pid');
      expect(result).toBe(false);
    });
  });
});
