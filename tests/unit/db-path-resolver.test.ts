/**
 * DB Path Resolver Tests
 * Issue #135: DB path resolution logic fix
 * Issue #136: Updated to mock install-context.ts
 * Tests for db-path-resolver.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { homedir } from 'os';

// Mock install-context.ts before importing db-path-resolver
// Issue #136: Updated import path
vi.mock('../../src/cli/utils/install-context', () => ({
  isGlobalInstall: vi.fn(),
  getConfigDir: vi.fn(() => path.join(homedir(), '.commandmate')),
}));

import { getDefaultDbPath, validateDbPath, getIssueDbPath } from '../../src/lib/db-path-resolver';
import { isGlobalInstall, getConfigDir } from '../../src/cli/utils/install-context';

describe('db-path-resolver', () => {
  const mockIsGlobalInstall = vi.mocked(isGlobalInstall);
  const mockGetConfigDir = vi.mocked(getConfigDir);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getDefaultDbPath', () => {
    describe('global install', () => {
      it('should return ~/.commandmate/data/cm.db for global install', () => {
        mockIsGlobalInstall.mockReturnValue(true);

        const result = getDefaultDbPath();

        const expected = path.join(homedir(), '.commandmate', 'data', 'cm.db');
        expect(result).toBe(expected);
      });

      it('should return absolute path for global install', () => {
        mockIsGlobalInstall.mockReturnValue(true);

        const result = getDefaultDbPath();

        expect(path.isAbsolute(result)).toBe(true);
      });
    });

    describe('local install', () => {
      it('should return <cwd>/data/cm.db as absolute path for local install', () => {
        mockIsGlobalInstall.mockReturnValue(false);

        const result = getDefaultDbPath();

        const expected = path.resolve(process.cwd(), 'data', 'cm.db');
        expect(result).toBe(expected);
      });

      it('should return absolute path for local install', () => {
        mockIsGlobalInstall.mockReturnValue(false);

        const result = getDefaultDbPath();

        expect(path.isAbsolute(result)).toBe(true);
      });
    });

    describe('path consistency', () => {
      it('should always return cm.db as filename', () => {
        mockIsGlobalInstall.mockReturnValue(true);
        const globalResult = getDefaultDbPath();

        mockIsGlobalInstall.mockReturnValue(false);
        const localResult = getDefaultDbPath();

        expect(path.basename(globalResult)).toBe('cm.db');
        expect(path.basename(localResult)).toBe('cm.db');
      });

      it('should always include data directory', () => {
        mockIsGlobalInstall.mockReturnValue(true);
        const globalResult = getDefaultDbPath();

        mockIsGlobalInstall.mockReturnValue(false);
        const localResult = getDefaultDbPath();

        expect(globalResult).toContain('/data/');
        expect(localResult).toContain('/data/');
      });
    });
  });

  describe('validateDbPath', () => {
    describe('global install - home directory protection', () => {
      it('should accept path within home directory for global install', () => {
        mockIsGlobalInstall.mockReturnValue(true);

        const validPath = path.join(homedir(), '.commandmate', 'data', 'cm.db');
        const result = validateDbPath(validPath);

        expect(result).toBe(validPath);
      });

      it('should reject path outside home directory for global install', () => {
        mockIsGlobalInstall.mockReturnValue(true);

        const invalidPath = '/etc/passwd';

        expect(() => validateDbPath(invalidPath)).toThrow('Security error');
        expect(() => validateDbPath(invalidPath)).toThrow('home directory');
      });

      it('should reject system directory for global install', () => {
        mockIsGlobalInstall.mockReturnValue(true);

        const systemPath = '/var/lib/commandmate/cm.db';

        expect(() => validateDbPath(systemPath)).toThrow('Security error');
      });
    });

    describe('local install - system directory protection (SEC-001)', () => {
      const systemDirs = ['/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/dev', '/sys', '/proc'];

      systemDirs.forEach((dir) => {
        it(`should reject path in ${dir} for local install`, () => {
          mockIsGlobalInstall.mockReturnValue(false);

          const invalidPath = `${dir}/commandmate/cm.db`;

          expect(() => validateDbPath(invalidPath)).toThrow('Security error');
          expect(() => validateDbPath(invalidPath)).toThrow('system directory');
        });
      });

      it('should accept path in user directory for local install', () => {
        mockIsGlobalInstall.mockReturnValue(false);

        const validPath = '/home/user/project/data/cm.db';
        const result = validateDbPath(validPath);

        expect(result).toBe(path.resolve(validPath));
      });

      it('should accept path in current working directory for local install', () => {
        mockIsGlobalInstall.mockReturnValue(false);

        const validPath = path.join(process.cwd(), 'data', 'cm.db');
        const result = validateDbPath(validPath);

        expect(result).toBe(path.resolve(validPath));
      });
    });

    describe('path resolution', () => {
      it('should resolve relative paths to absolute', () => {
        mockIsGlobalInstall.mockReturnValue(false);

        const relativePath = './data/cm.db';
        const result = validateDbPath(relativePath);

        expect(path.isAbsolute(result)).toBe(true);
        expect(result).toBe(path.resolve(relativePath));
      });
    });
  });

  // Issue #136: Tests for getIssueDbPath
  describe('getIssueDbPath', () => {
    beforeEach(() => {
      mockGetConfigDir.mockReturnValue(path.join(homedir(), '.commandmate'));
    });

    it('should return issue-specific db path', () => {
      const result = getIssueDbPath(135);

      const expected = path.join(homedir(), '.commandmate', 'data', 'cm-135.db');
      expect(result).toBe(expected);
    });

    it('should return absolute path', () => {
      const result = getIssueDbPath(200);

      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should include issue number in filename', () => {
      const issueNo = 42;
      const result = getIssueDbPath(issueNo);

      expect(result).toContain(`cm-${issueNo}.db`);
    });

    it('should use getConfigDir for base path', () => {
      const customConfigDir = '/custom/config/dir';
      mockGetConfigDir.mockReturnValue(customConfigDir);

      const result = getIssueDbPath(123);

      expect(result).toBe(path.join(customConfigDir, 'data', 'cm-123.db'));
    });
  });
});
