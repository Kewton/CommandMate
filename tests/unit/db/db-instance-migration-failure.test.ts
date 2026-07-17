/**
 * Issue #1353: getDbInstance() must not cache a connection whose migrations threw.
 *
 * The singleton was assigned before runMigrations() ran, so a thrown migration
 * left an open, unverified database in the module-level cache. The first caller
 * saw the error and every caller after it was handed that same database back
 * with no error at all — which would let the future-schema guard fire exactly
 * once and then be bypassed for the lifetime of the process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-db-instance-'));
const dbPath = path.join(tmpDir, 'cm.db');

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ CM_DB_PATH: dbPath })),
}));

const openDatabaseWithAbiRecovery = vi.fn();
vi.mock('@/lib/db/abi-recovery', () => ({
  openDatabaseWithAbiRecovery: (p: string) => openDatabaseWithAbiRecovery(p),
}));

const runMigrations = vi.fn();
vi.mock('@/lib/db/db-migrations', () => ({
  runMigrations: (db: Database.Database) => runMigrations(db),
}));

import { getDbInstance, closeDbInstance } from '@/lib/db/db-instance';

describe('getDbInstance migration failure (Issue #1353)', () => {
  let opened: Database.Database[];

  beforeEach(() => {
    vi.clearAllMocks();
    opened = [];
    openDatabaseWithAbiRecovery.mockImplementation(() => {
      const db = new Database(':memory:');
      opened.push(db);
      return db;
    });
  });

  afterEach(() => {
    try {
      closeDbInstance();
    } catch {
      // already closed by the failure path
    }
    for (const db of opened) {
      if (db.open) db.close();
    }
  });

  it('rethrows on every call instead of serving an unverified database', () => {
    const failure = new Error(
      'This database (schema v50) was created by a newer version of CommandMate'
    );
    runMigrations.mockImplementation(() => { throw failure; });

    expect(() => getDbInstance()).toThrow(failure);

    // The regression: this second call used to return the cached, unmigrated
    // database silently — exactly the "opens anyway" behaviour being fixed.
    expect(() => getDbInstance()).toThrow(failure);
    expect(() => getDbInstance()).toThrow(failure);
  });

  it('closes the database it opened when migrations throw', () => {
    runMigrations.mockImplementation(() => { throw new Error('migration failed'); });

    expect(() => getDbInstance()).toThrow('migration failed');

    expect(opened).toHaveLength(1);
    expect(opened[0].open).toBe(false);
  });

  it('caches the instance once migrations succeed', () => {
    runMigrations.mockImplementation(() => { /* success */ });

    const first = getDbInstance();
    const second = getDbInstance();

    expect(second).toBe(first);
    expect(openDatabaseWithAbiRecovery).toHaveBeenCalledTimes(1);
    expect(runMigrations).toHaveBeenCalledTimes(1);
  });

  it('recovers on a later call once the underlying failure is resolved', () => {
    runMigrations.mockImplementationOnce(() => { throw new Error('transient'); });

    expect(() => getDbInstance()).toThrow('transient');

    // Nothing poisoned: a subsequent call re-opens and migrates cleanly.
    runMigrations.mockImplementation(() => { /* success */ });
    const db = getDbInstance();

    expect(db.open).toBe(true);
    expect(openDatabaseWithAbiRecovery).toHaveBeenCalledTimes(2);
  });
});
