/**
 * Legacy DB migration keeps updates that are still in `-wal` (Issue #3993).
 *
 * `migrateDbIfNeeded` used to copy the main file alone, so a legacy database in
 * WAL mode lost every committed update not yet written back. Positive control:
 * a database whose rows live only in `-wal` (a writer that never checkpointed)
 * must arrive with them. Negative control: a database without `-wal` is copied
 * byte for byte, as before.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { sandboxRoots } = vi.hoisted(() => ({ sandboxRoots: [] as string[] }));

// os.tmpdir() is under /var on macOS, which isSystemDirectory rejects; the
// sandboxes this file creates are allowed, everything else is delegated.
vi.mock('@/config/system-directories', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/config/system-directories')>();
  const pathModule = await import('path');
  return {
    ...original,
    isSystemDirectory: (inputPath: string) => {
      const resolved = pathModule.resolve(inputPath);
      if (sandboxRoots.some((root) => resolved === root || resolved.startsWith(root + pathModule.sep))) {
        return false;
      }
      return original.isSystemDirectory(inputPath);
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

import { migrateDbIfNeeded } from '../../src/lib/db/db-migration-path';

function makeSandbox(): { cwd: string; home: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-db-migration-wal-3993-')));
  sandboxRoots.push(root);
  const cwd = path.join(root, 'cwd');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(cwd, 'data'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  vi.stubEnv('HOME', home);
  vi.stubEnv('DATABASE_PATH', '');
  return { cwd, home };
}

function readNotes(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT body FROM notes ORDER BY id').all() as Array<{ body: string }>).map(
      (row) => row.body
    );
  } finally {
    db.close();
  }
}

describe('migrateDbIfNeeded with a WAL-mode legacy database (Issue #3993)', () => {
  const openWriters: Database.Database[] = [];

  afterEach(() => {
    for (const writer of openWriters.splice(0)) {
      try {
        writer.close();
      } catch {
        // already closed
      }
    }
    for (const root of sandboxRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('carries rows that exist only in -wal into the new location and the backup (positive)', () => {
    const { cwd, home } = makeSandbox();
    const legacyPath = path.join(cwd, 'data', 'db.sqlite');

    // A writer that never checkpoints: every row below is in -wal only.
    const writer = new Database(legacyPath);
    openWriters.push(writer);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    writer.prepare('INSERT INTO notes (body) VALUES (?)').run('only-in-wal');
    expect(fs.statSync(`${legacyPath}-wal`).size).toBeGreaterThan(0);

    // The defect: the main file alone does not have the table at all.
    const mainOnly = path.join(cwd, 'main-only.sqlite');
    fs.copyFileSync(legacyPath, mainOnly);
    expect(() => readNotes(mainOnly)).toThrow(/no such table/);

    const targetPath = path.join(home, '.commandmate', 'data', 'cm.db');
    const result = migrateDbIfNeeded(targetPath);

    expect(result.migrated).toBe(true);
    expect(result.sourcePath).toBe(legacyPath);
    expect(readNotes(targetPath)).toEqual(['only-in-wal']);
    expect(readNotes(`${legacyPath}.bak`)).toEqual(['only-in-wal']);
    expect((fs.statSync(`${legacyPath}.bak`).mode & 0o777)).toBe(0o600);
    // Self-contained: the copy needs no sidecar to be complete.
    expect(fs.existsSync(`${targetPath}-wal`)).toBe(false);
    // No temporary file is left next to either copy.
    expect(fs.readdirSync(path.dirname(targetPath)).filter((name) => name.endsWith('.partial'))).toEqual([]);
    expect(fs.readdirSync(path.join(cwd, 'data')).filter((name) => name.endsWith('.partial'))).toEqual([]);

    // The legacy database is left as it was: still readable, row still there.
    writer.close();
    expect(readNotes(legacyPath)).toEqual(['only-in-wal']);
  });

  it('copies a database without -wal byte for byte, as before (negative)', () => {
    const { cwd, home } = makeSandbox();
    const legacyPath = path.join(cwd, 'data', 'db.sqlite');

    const db = new Database(legacyPath);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    db.prepare('INSERT INTO notes (body) VALUES (?)').run('in-main-file');
    db.close();
    expect(fs.existsSync(`${legacyPath}-wal`)).toBe(false);
    const original = fs.readFileSync(legacyPath);

    const copySpy = vi.spyOn(fs, 'copyFileSync');
    const targetPath = path.join(home, '.commandmate', 'data', 'cm.db');
    const result = migrateDbIfNeeded(targetPath);

    expect(result.migrated).toBe(true);
    expect(copySpy).toHaveBeenCalledWith(legacyPath, `${legacyPath}.bak`);
    expect(copySpy).toHaveBeenCalledWith(legacyPath, targetPath);
    expect(fs.readFileSync(targetPath).equals(original)).toBe(true);
    expect(fs.readFileSync(`${legacyPath}.bak`).equals(original)).toBe(true);
    expect(readNotes(targetPath)).toEqual(['in-main-file']);
  });
});
