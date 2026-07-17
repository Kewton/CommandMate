/**
 * Issue #1360: getDbInstance() must set busy_timeout and journal_mode=WAL so
 * that opening the same DB file from more than one process does not fail
 * immediately with SQLITE_BUSY (busy_timeout defaults to 0 = fail at once, and
 * the default rollback journal takes an exclusive write lock).
 *
 * A real file-backed connection is used on purpose: WAL is silently ignored for
 * in-memory databases, so the assertions below would not exercise the fix if
 * the connection were mocked to `:memory:`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-db-pragmas-'));
const dbPath = path.join(tmpDir, 'cm.db');

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ CM_DB_PATH: dbPath })),
}));

const runMigrations = vi.fn();
vi.mock('@/lib/db/db-migrations', () => ({
  runMigrations: (db: Database.Database) => runMigrations(db),
}));

import { getDbInstance, closeDbInstance } from '@/lib/db/db-instance';

describe('getDbInstance connection pragmas (Issue #1360)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The schema itself is not under test; keep migrations a no-op so the fix
    // (connection pragmas) is isolated.
    runMigrations.mockImplementation(() => { /* no-op */ });
  });

  afterEach(() => {
    closeDbInstance();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enables WAL journal mode on the shared connection', () => {
    const db = getDbInstance();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('sets a non-zero busy_timeout so contended writes wait instead of failing at once', () => {
    const db = getDbInstance();
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('keeps foreign key enforcement enabled (Issue #294 ordering preserved)', () => {
    const db = getDbInstance();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('applies the pragmas before running migrations', () => {
    const pragmasAtMigrationTime: Record<string, unknown> = {};
    runMigrations.mockImplementation((db: Database.Database) => {
      pragmasAtMigrationTime.journal_mode = db.pragma('journal_mode', { simple: true });
      pragmasAtMigrationTime.busy_timeout = db.pragma('busy_timeout', { simple: true });
      pragmasAtMigrationTime.foreign_keys = db.pragma('foreign_keys', { simple: true });
    });

    getDbInstance();

    expect(pragmasAtMigrationTime).toEqual({
      journal_mode: 'wal',
      busy_timeout: 5000,
      foreign_keys: 1,
    });
  });
});
