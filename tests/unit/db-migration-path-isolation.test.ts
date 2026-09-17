/**
 * DB Migration Path Isolation Tests (Positive Control)
 * Issue #2605: DB migration isolation test with simulated legacy DB
 * Tests for migrateDbIfNeeded in db-migration-path.ts
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real home directory before stubbing (Issue #2605)
const realHome = os.homedir();

function countRealHomeTestEntries(): number {
  try {
    return fs.readdirSync(realHome).filter((name) => name.startsWith('.commandmate-test-')).length;
  } catch {
    return 0;
  }
}

const initialTestEntriesCount = countRealHomeTestEntries();

// Create sandbox in os.tmpdir() with cwd and home subdirectories
const { sandboxDir, sandboxCwd, sandboxHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsModule = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osModule = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathModule = require('path');

  const sandboxDir = fsModule.realpathSync(fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'cm-isolation-test-')));
  const sandboxCwd = pathModule.join(sandboxDir, 'cwd');
  const sandboxHome = pathModule.join(sandboxDir, 'home');
  fsModule.mkdirSync(sandboxCwd, { recursive: true });
  fsModule.mkdirSync(sandboxHome, { recursive: true });

  return { sandboxDir, sandboxCwd, sandboxHome };
});

// Mock isSystemDirectory: returns false for paths inside sandbox realpath, delegates otherwise
vi.mock('@/config/system-directories', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/config/system-directories')>();
  const pathModule = await import('path');
  const fsModule = await import('fs');

  return {
    ...original,
    isSystemDirectory: (inputPath: string) => {
      const lexicalPath = pathModule.resolve(inputPath);
      let physicalPath = lexicalPath;
      try {
        physicalPath = fsModule.realpathSync(lexicalPath);
      } catch {
        let current = lexicalPath;
        const pending: string[] = [];
        while (current !== pathModule.dirname(current)) {
          try {
            const real = fsModule.realpathSync(current);
            physicalPath = pathModule.join(real, ...pending);
            break;
          } catch {
            pending.unshift(pathModule.basename(current));
            current = pathModule.dirname(current);
          }
        }
      }

      const isInsideSandbox = (p: string) =>
        p === sandboxDir || p.startsWith(sandboxDir + pathModule.sep);

      if (isInsideSandbox(lexicalPath) || isInsideSandbox(physicalPath)) {
        return false;
      }

      return original.isSystemDirectory(inputPath);
    },
  };
});

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

import { migrateDbIfNeeded } from '../../src/lib/db/db-migration-path';

describe('db-migration-path isolation (positive control)', () => {
  afterEach(() => {
    try {
      if (fs.existsSync(sandboxDir)) {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    try {
      if (fs.existsSync(sandboxDir)) {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
    expect(countRealHomeTestEntries()).toBeLessThanOrEqual(initialTestEntriesCount);
  });

  it('should migrate database when legacy db exists in isolated environment', () => {
    // Put fake DB in <sandbox cwd>/data/db.sqlite
    const fakeDbDir = path.join(sandboxCwd, 'data');
    fs.mkdirSync(fakeDbDir, { recursive: true });
    const fakeDbPath = path.join(fakeDbDir, 'db.sqlite');
    fs.writeFileSync(fakeDbPath, 'SQLite format 3\0test');

    vi.spyOn(process, 'cwd').mockReturnValue(sandboxCwd);
    vi.stubEnv('HOME', sandboxHome);
    vi.stubEnv('DATABASE_PATH', '');

    const targetPath = path.join(sandboxHome, '.commandmate', 'data', 'cm.db');

    const result = migrateDbIfNeeded(targetPath);

    expect(result.migrated).toBe(true);
    expect(result.sourcePath).toBe(fakeDbPath);
    expect(result.targetPath).toBe(targetPath);
    expect(result.backupPath).toBe(`${fakeDbPath}.bak`);

    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('SQLite format 3\0test');
    expect(fs.existsSync(`${fakeDbPath}.bak`)).toBe(true);
    expect(fs.readFileSync(`${fakeDbPath}.bak`, 'utf8')).toBe('SQLite format 3\0test');
  });
});
