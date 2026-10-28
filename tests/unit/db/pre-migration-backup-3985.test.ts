/**
 * Issue #3985: a verified copy of the database before the first pending migration.
 *
 * Every database here lives in an os.tmpdir() directory created per test and
 * removed afterwards; the real database is never opened.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations, getCurrentVersion, type Migration } from '@/lib/db/migrations/runner';
import { runMigrations as runAllMigrations } from '@/lib/db/db-migrations';
import {
  createPreMigrationBackup,
  listMigrationBackups,
  MIGRATION_BACKUP_DIR_NAME,
  MIGRATION_BACKUP_GENERATIONS,
  readLastCompleteVersion,
} from '@/lib/db/migrations/pre-migration-backup';

const m1: Migration = {
  version: 1,
  name: 'create notes',
  up: (db) => db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)'),
};
const m2: Migration = {
  version: 2,
  name: 'add notes.tag',
  up: (db) => db.exec('ALTER TABLE notes ADD COLUMN tag TEXT'),
};
const m3: Migration = {
  version: 3,
  name: 'create tags',
  up: (db) => db.exec('CREATE TABLE tags (name TEXT PRIMARY KEY)'),
};

function readCopy(copyPath: string): { integrity: unknown; version: number; notes: number } {
  const copy = new Database(copyPath, { readonly: true, fileMustExist: true });
  try {
    return {
      integrity: copy.pragma('integrity_check', { simple: true }),
      version: (copy.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v,
      notes: (copy.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c,
    };
  } finally {
    copy.close();
  }
}

describe('pre-migration backup (Issue #3985)', () => {
  let tmpDir: string;
  let dbPath: string;
  let backupDir: string;
  let db: Database.Database;

  function openWal(): Database.Database {
    const conn = new Database(dbPath);
    conn.pragma('journal_mode = WAL');
    return conn;
  }

  /** A file database at v1 with one committed row. */
  function seedV1(): Database.Database {
    const conn = openWal();
    runMigrations(conn, [m1]);
    conn.prepare('INSERT INTO notes (body) VALUES (?)').run('before');
    return conn;
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-premigration-3985-'));
    dbPath = path.join(tmpDir, 'cm.db');
    backupDir = path.join(tmpDir, MIGRATION_BACKUP_DIR_NAME);
  });

  afterEach(() => {
    if (db?.open) db.close();
    if (fs.existsSync(backupDir)) fs.chmodSync(backupDir, 0o700);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('takes one verified copy at the pre-migration version before migrating', () => {
    db = seedV1();
    runMigrations(db, [m1, m2, m3]);

    const copies = listMigrationBackups(backupDir, 'cm.db');
    expect(copies).toHaveLength(1);
    expect(path.basename(copies[0])).toMatch(/^cm\.db\.v1-to-v3\.\d{8}T\d{9}Z\.[0-9a-f]{8}\.sqlite$/);
    expect(readCopy(copies[0])).toEqual({ integrity: 'ok', version: 1, notes: 1 });
    expect(getCurrentVersion(db)).toBe(3);
    // no half-written file is left behind
    expect(fs.readdirSync(backupDir).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  it('includes committed updates that are still only in the WAL (copyFileSync of the main file loses them)', () => {
    db = openWal();
    db.pragma('wal_autocheckpoint = 0');
    runMigrations(db, [m1]);
    db.prepare('INSERT INTO notes (body) VALUES (?)').run('only in wal');
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    // Control: copying the main file alone misses the un-checkpointed commit.
    const rawCopy = path.join(tmpDir, 'raw-copy.db');
    fs.copyFileSync(dbPath, rawCopy);
    const raw = new Database(rawCopy, { readonly: true });
    const rawTables = raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'notes'").get() as { c: number };
    raw.close();
    expect(rawTables.c).toBe(0);

    runMigrations(db, [m1, m2]);
    const [copy] = listMigrationBackups(backupDir, 'cm.db');
    expect(readCopy(copy)).toEqual({ integrity: 'ok', version: 1, notes: 1 });
  });

  it('does not copy when there is no pending migration', () => {
    db = seedV1();
    runMigrations(db, [m1]);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('does not copy a brand-new database (v0, no tables), including the real migration set', () => {
    db = openWal();
    runAllMigrations(db);
    expect(fs.existsSync(backupDir)).toBe(false);
    db.close();

    // Reopening the fully migrated database has nothing pending either.
    db = openWal();
    runAllMigrations(db);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('does not copy an in-memory database', () => {
    db = new Database(':memory:');
    runMigrations(db, [m1]);
    runMigrations(db, [m1, m2]);
    expect(getCurrentVersion(db)).toBe(2);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('stops before migrating when the copy cannot be written', () => {
    db = seedV1();
    fs.mkdirSync(backupDir, { mode: 0o700 });
    fs.chmodSync(backupDir, 0o500);

    expect(() => runMigrations(db, [m1, m2])).toThrow(
      new RegExp(`No migration was run\\. Backup directory: ${backupDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*CM_DB_SKIP_MIGRATION_BACKUP=1`)
    );
    expect(getCurrentVersion(db)).toBe(1);
    const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).not.toContain('tag');
  });

  it('migrates without a copy when CM_DB_SKIP_MIGRATION_BACKUP=1', () => {
    vi.stubEnv('CM_DB_SKIP_MIGRATION_BACKUP', '1');
    db = seedV1();
    runMigrations(db, [m1, m2]);
    expect(getCurrentVersion(db)).toBe(2);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('keeps three completed generations, pruning only after the new copy is verified', () => {
    db = seedV1();
    const stamps = [1, 2, 3, 4].map((n) => new Date(Date.UTC(2026, 9, 29, 0, 0, n)));
    for (const stamp of stamps) createPreMigrationBackup(db, 1, 2, stamp);

    const kept = listMigrationBackups(backupDir, 'cm.db');
    expect(kept).toHaveLength(MIGRATION_BACKUP_GENERATIONS);
    expect(kept.map((p) => path.basename(p).split('.')[3])).toEqual([
      '20261029T000002000Z',
      '20261029T000003000Z',
      '20261029T000004000Z',
    ]);

    // A failed fourth copy (the copy is not at the expected version) removes nothing.
    expect(() => createPreMigrationBackup(db, 2, 3, new Date(Date.UTC(2026, 9, 29, 0, 0, 5)))).toThrow(
      /copy is at schema v1, expected v2/
    );
    expect(listMigrationBackups(backupDir, 'cm.db')).toEqual(kept);
    expect(fs.readdirSync(backupDir).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  it('keeps the original restore point when a half-applied upgrade is retried (review P2-1)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      db = seedV1();
      const failingV3: Migration = {
        version: 3,
        name: 'always fails',
        up: () => {
          throw new Error('boom');
        },
      };
      // v1 -> v2 applies, v3 fails; every restart then starts from v2.
      for (let attempt = 0; attempt < 4; attempt++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 9, 29, 0, 0, attempt)));
        expect(() => runMigrations(db, [m1, m2, failingV3])).toThrow(/Migration 3 \(always fails\) failed/);
        expect(getCurrentVersion(db)).toBe(2);
      }
    } finally {
      vi.useRealTimers();
    }

    const names = listMigrationBackups(backupDir, 'cm.db').map((p) => path.basename(p).split('.').slice(2, 4).join('.'));
    expect(names).toEqual([
      'v1-to-v3.20261029T000000000Z',
      'v2-to-v3.20261029T000002000Z',
      'v2-to-v3.20261029T000003000Z',
    ]);
    const original = listMigrationBackups(backupDir, 'cm.db')[0];
    expect(readCopy(original)).toEqual({ integrity: 'ok', version: 1, notes: 1 });
  });

  it('still keeps only the newest three across successive successful upgrades', () => {
    const m4: Migration = { version: 4, name: 'create t4', up: (conn) => conn.exec('CREATE TABLE t4 (x)') };
    const m5: Migration = { version: 5, name: 'create t5', up: (conn) => conn.exec('CREATE TABLE t5 (x)') };
    const all = [m1, m2, m3, m4, m5];
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      db = seedV1();
      for (let target = 2; target <= 5; target++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 9, 29, 0, 0, target)));
        runMigrations(db, all.filter((m) => m.version <= target));
      }
    } finally {
      vi.useRealTimers();
    }

    const names = listMigrationBackups(backupDir, 'cm.db').map((p) => path.basename(p).split('.')[2]);
    expect(names).toEqual(['v2-to-v3', 'v3-to-v4', 'v4-to-v5']);
  });

  describe('original restore point follows the last completed version (review P2, 2nd round)', () => {
    const failingV3: Migration = {
      version: 3,
      name: 'always fails',
      up: () => {
        throw new Error('boom');
      },
    };
    const m4: Migration = { version: 4, name: 'create t4', up: (conn) => conn.exec('CREATE TABLE t4 (x)') };
    const m5: Migration = { version: 5, name: 'create t5', up: (conn) => conn.exec('CREATE TABLE t5 (x)') };

    function at(second: number): void {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 29, 0, 0, second)));
    }
    function copyNames(): string[] {
      return listMigrationBackups(backupDir, 'cm.db').map((p) => path.basename(p).split('.').slice(2, 4).join('.'));
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps the v1 copy when a later build retries the half-applied upgrade with another target', () => {
      db = seedV1();
      at(0);
      // Build A aims at v3: v2 applies, v3 fails.
      expect(() => runMigrations(db, [m1, m2, failingV3])).toThrow(/Migration 3/);
      expect(getCurrentVersion(db)).toBe(2);
      // Build B aims at v4 and keeps failing on v3.
      for (let attempt = 1; attempt <= 3; attempt++) {
        at(attempt);
        expect(() => runMigrations(db, [m1, m2, failingV3, m4])).toThrow(/Migration 3/);
      }

      expect(copyNames()).toEqual([
        'v1-to-v3.20261029T000000000Z',
        'v2-to-v4.20261029T000002000Z',
        'v2-to-v4.20261029T000003000Z',
      ]);
      expect(readLastCompleteVersion(backupDir, 'cm.db')).toBe(1);
      expect(readCopy(listMigrationBackups(backupDir, 'cm.db')[0]).version).toBe(1);
    });

    it('advances the record on a completed run, so later upgrades prune the old restore point', () => {
      db = seedV1();
      at(0);
      expect(() => runMigrations(db, [m1, m2, failingV3])).toThrow(/Migration 3/);
      at(1);
      runMigrations(db, [m1, m2, m3]);
      expect(readLastCompleteVersion(backupDir, 'cm.db')).toBe(3);
      at(2);
      runMigrations(db, [m1, m2, m3, m4]);
      at(3);
      runMigrations(db, [m1, m2, m3, m4, m5]);

      expect(copyNames()).toEqual([
        'v2-to-v3.20261029T000001000Z',
        'v3-to-v4.20261029T000002000Z',
        'v4-to-v5.20261029T000003000Z',
      ]);
      expect(readLastCompleteVersion(backupDir, 'cm.db')).toBe(5);
    });

    it('assumes the starting version when nothing is recorded (first copy, or a directory from an older build)', () => {
      db = seedV1();
      // Copies left by an older build, without a record.
      fs.mkdirSync(backupDir, { mode: 0o700 });
      for (const name of [
        'cm.db.v0-to-v1.20261028T000000000Z.0000000a.sqlite',
        'cm.db.v0-to-v1.20261028T000001000Z.0000000b.sqlite',
        'cm.db.v0-to-v1.20261028T000002000Z.0000000c.sqlite',
      ]) {
        fs.writeFileSync(path.join(backupDir, name), '', { mode: 0o600 });
      }
      at(0);
      runMigrations(db, [m1, m2]);

      const recordPath = path.join(backupDir, 'cm.db.last-complete-version');
      // The run completed, so the assumed v1 has been replaced by v2.
      expect(readLastCompleteVersion(backupDir, 'cm.db')).toBe(2);
      expect(fs.statSync(recordPath).mode & 0o777).toBe(0o600);
      expect(copyNames()).toEqual([
        'v0-to-v1.20261028T000001000Z',
        'v0-to-v1.20261028T000002000Z',
        'v1-to-v2.20261029T000000000Z',
      ]);
      expect(fs.readdirSync(backupDir).filter((n) => n.endsWith('.partial'))).toEqual([]);
    });

    it('writes the assumed version before migrating, so a failed first run still records where it began', () => {
      db = seedV1();
      at(0);
      expect(() => runMigrations(db, [m1, m2, failingV3])).toThrow(/Migration 3/);
      expect(readLastCompleteVersion(backupDir, 'cm.db')).toBe(1);
    });

    it('does not stop startup when the record cannot be written', () => {
      db = seedV1();
      fs.mkdirSync(path.join(backupDir, 'cm.db.last-complete-version', 'blocker'), { recursive: true });
      at(0);
      runMigrations(db, [m1, m2]);

      expect(getCurrentVersion(db)).toBe(2);
      expect(readLastCompleteVersion(backupDir, 'cm.db')).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not record the last completed schema version'));
      expect(fs.readdirSync(backupDir).filter((n) => n.endsWith('.partial'))).toEqual([]);
    });
  });

  it('creates the directory 0700 and the copy 0600', () => {
    db = seedV1();
    runMigrations(db, [m1, m2]);
    expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    const [copy] = listMigrationBackups(backupDir, 'cm.db');
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
  });

  it('refuses to start migrating when another connection migrated after the version read', () => {
    db = seedV1();
    const intruder: Migration = {
      version: 2,
      name: 'raced',
      up: () => {},
    };
    // Simulate the race: a second connection records v2 right after our copy.
    const other = new Database(dbPath);
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((fn) => {
      other.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (2, ?, 0)').run('other');
      spy.mockRestore();
      return db.transaction(fn);
    });
    try {
      expect(() => runMigrations(db, [m1, intruder])).toThrow(/schema version changed from v1 to v2/);
    } finally {
      other.close();
    }
  });
});
