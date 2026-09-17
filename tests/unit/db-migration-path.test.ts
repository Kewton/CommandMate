/**
 * DB Migration Path Tests
 * Issue #135: DB path resolution logic fix
 * Tests for db-migration-path.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { homedir } from 'os';

// Real home directory before stubbing (Issue #2605)
const realHome = homedir();

function countRealHomeTestEntries(): number {
  try {
    return fs.readdirSync(realHome).filter((name) => name.startsWith('.commandmate-test-')).length;
  } catch {
    return 0;
  }
}

const initialTestEntriesCount = countRealHomeTestEntries();

import {
  getLegacyDbPaths,
  migrateDbIfNeeded,
  resolveAndValidatePath,
} from '../../src/lib/db/db-migration-path';

// Mock logger module (Issue #480)
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));


describe('db-migration-path', () => {
  let emptyTmpDirs: string[] = [];

  function createEmptyTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-empty-'));
    emptyTmpDirs.push(dir);
    return dir;
  }

  function cleanupEmptyTmpDirs(): void {
    for (const dir of emptyTmpDirs) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
    emptyTmpDirs = [];
  }

  afterEach(() => {
    cleanupEmptyTmpDirs();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    cleanupEmptyTmpDirs();
    expect(countRealHomeTestEntries()).toBeLessThanOrEqual(initialTestEntriesCount);
  });

  describe('resolveAndValidatePath', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('path validation', () => {
      it('should return null when path does not exist', () => {
        // Use a path that definitely doesn't exist
        const result = resolveAndValidatePath('/nonexistent/path/xyz123/cm.db', 'test path');

        expect(result).toBeNull();
      });

      it('should return the resolved path for existing files', () => {
        // Use current test file as a known existing path
        const currentFile = __filename;
        const result = resolveAndValidatePath(currentFile, 'test path');

        expect(result).toBe(currentFile);
      });
    });
  });

  describe('getLegacyDbPaths', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.DATABASE_PATH;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return CWD relative paths', () => {
      const paths = getLegacyDbPaths();

      expect(paths).toContain(path.join(process.cwd(), 'data', 'db.sqlite'));
      expect(paths).toContain(path.join(process.cwd(), 'data', 'cm.db'));
    });

    it('should include home directory path for old db.sqlite', () => {
      const paths = getLegacyDbPaths();

      expect(paths).toContain(path.join(homedir(), '.commandmate', 'data', 'db.sqlite'));
    });

    describe('SEC-005: DATABASE_PATH validation', () => {
      it('should include DATABASE_PATH when valid', () => {
        process.env.DATABASE_PATH = '/safe/path/db.sqlite';

        const paths = getLegacyDbPaths();

        expect(paths).toContain('/safe/path/db.sqlite');
      });

      it('should skip DATABASE_PATH in system directory', () => {
        process.env.DATABASE_PATH = '/etc/commandmate/db.sqlite';
        mockLogger.warn.mockClear();

        const paths = getLegacyDbPaths();

        expect(paths).not.toContain('/etc/commandmate/db.sqlite');
        expect(mockLogger.warn).toHaveBeenCalled();
});

      it('should skip DATABASE_PATH in /var directory', () => {
        process.env.DATABASE_PATH = '/var/lib/commandmate/db.sqlite';
        mockLogger.warn.mockClear();

        const paths = getLegacyDbPaths();

        expect(paths).not.toContain('/var/lib/commandmate/db.sqlite');
        expect(mockLogger.warn).toHaveBeenCalled();
});

      it('should skip DATABASE_PATH in /usr directory', () => {
        process.env.DATABASE_PATH = '/usr/share/commandmate/db.sqlite';
        mockLogger.warn.mockClear();

        const paths = getLegacyDbPaths();

        expect(paths).not.toContain('/usr/share/commandmate/db.sqlite');
        expect(mockLogger.warn).toHaveBeenCalled();
});
    });
  });

  describe('migrateDbIfNeeded', () => {
    describe('security - target path validation', () => {
      it('should throw for target in /etc directory', () => {
        const targetPath = '/etc/commandmate/cm.db';

        expect(() => migrateDbIfNeeded(targetPath)).toThrow('Security error');
        expect(() => migrateDbIfNeeded(targetPath)).toThrow('system directory');
      });

      it('should throw for target in /var directory', () => {
        const targetPath = '/var/lib/commandmate/cm.db';

        expect(() => migrateDbIfNeeded(targetPath)).toThrow('Security error');
      });

      it('should throw for target in /usr directory', () => {
        const targetPath = '/usr/share/commandmate/cm.db';

        expect(() => migrateDbIfNeeded(targetPath)).toThrow('Security error');
      });

      it('should throw for target in /bin directory', () => {
        const targetPath = '/bin/commandmate/cm.db';

        expect(() => migrateDbIfNeeded(targetPath)).toThrow('Security error');
      });

      it('should throw for target in /sbin directory', () => {
        const targetPath = '/sbin/commandmate/cm.db';

        expect(() => migrateDbIfNeeded(targetPath)).toThrow('Security error');
      });

      it('should throw for target in /dev directory', () => {
        const targetPath = '/dev/commandmate/cm.db';

        expect(() => migrateDbIfNeeded(targetPath)).toThrow('Security error');
      });

      it('should throw for target in /sys directory', () => {
        const targetPath = '/sys/commandmate/cm.db';

        expect(() => migrateDbIfNeeded(targetPath)).toThrow('Security error');
      });

      it('should throw for target in /proc directory', () => {
        const targetPath = '/proc/commandmate/cm.db';

        expect(() => migrateDbIfNeeded(targetPath)).toThrow('Security error');
      });
    });

    describe('when checking results', () => {
      it('should return valid MigrationResult object', () => {
        const emptyDir = createEmptyTmpDir();
        vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
        vi.stubEnv('HOME', emptyDir);
        vi.stubEnv('DATABASE_PATH', '');

        const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
        const copySpy = vi.spyOn(fs, 'copyFileSync');

        // Target uses the real home obtained before stubbing, but won't be created
        const targetPath = path.join(realHome, `.commandmate-test-${Date.now()}-results`, 'data', 'cm.db');

        const result = migrateDbIfNeeded(targetPath);

        // Assert migration was not performed and no directories or files were created
        expect(result.migrated).toBe(false);
        expect(fs.existsSync(path.dirname(targetPath))).toBe(false);
        expect(mkdirSpy).not.toHaveBeenCalled();
        expect(copySpy).not.toHaveBeenCalled();

        // Result should be a valid MigrationResult
        expect(result).toHaveProperty('migrated');
        expect(result).toHaveProperty('targetPath');
        expect(typeof result.migrated).toBe('boolean');
        expect(typeof result.targetPath).toBe('string');
        // Target path should be absolute
        expect(path.isAbsolute(result.targetPath)).toBe(true);
      });
    });
  });

  describe('MigrationResult interface', () => {
    it('should have correct structure', () => {
      const emptyDir = createEmptyTmpDir();
      vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
      vi.stubEnv('HOME', emptyDir);
      vi.stubEnv('DATABASE_PATH', '');

      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      const copySpy = vi.spyOn(fs, 'copyFileSync');

      const targetPath = path.join(realHome, `.commandmate-test-${Date.now()}-structure`, 'data', 'cm.db');
      const result = migrateDbIfNeeded(targetPath);

      // Assert migration was not performed and no directories or files were created
      expect(result.migrated).toBe(false);
      expect(fs.existsSync(path.dirname(targetPath))).toBe(false);
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(copySpy).not.toHaveBeenCalled();

      // Check result structure
      expect(result).toHaveProperty('migrated');
      expect(result).toHaveProperty('targetPath');
      expect(typeof result.migrated).toBe('boolean');
      expect(typeof result.targetPath).toBe('string');
    });
  });
});
