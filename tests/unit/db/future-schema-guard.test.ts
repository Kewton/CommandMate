/**
 * Issue #1353: a database written by a newer build must stop startup.
 *
 * Migrations only move forward, so a schema beyond CURRENT_SCHEMA_VERSION has no
 * definition in this build. Before this guard, runMigrations() reported
 * "Schema is up to date" and opened it, and queries against renamed/dropped
 * columns failed later as opaque runtime 500s.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  getCurrentVersion,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/db-migrations';

/** Record a schema_version row for a version this build does not know about. */
function stampVersion(db: Database.Database, version: number): void {
  db.prepare(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)'
  ).run(version, `future-migration-v${version}`, Date.now());
}

describe('future schema version guard (Issue #1353)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('throws when the database schema is newer than this build supports', () => {
    stampVersion(db, CURRENT_SCHEMA_VERSION + 8);

    expect(() => runMigrations(db)).toThrow(
      new RegExp(`schema v${CURRENT_SCHEMA_VERSION + 8}.*newer version of CommandMate`, 's')
    );
  });

  it('names both versions and the recovery action in the error', () => {
    stampVersion(db, CURRENT_SCHEMA_VERSION + 1);

    let message = '';
    try {
      runMigrations(db);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // The whole point is diagnosability: the operator must be able to tell
    // version skew from a generic DB error without reading the source.
    expect(message).toContain(`v${CURRENT_SCHEMA_VERSION + 1}`);
    expect(message).toContain(`v${CURRENT_SCHEMA_VERSION}`);
    expect(message).toContain('commandmate update');
  });

  it('rejects a future database before writing anything to it', () => {
    stampVersion(db, CURRENT_SCHEMA_VERSION + 3);
    const before = getCurrentVersion(db);

    expect(() => runMigrations(db)).toThrow();

    // A rejected database must be left exactly as found — the operator may
    // still open it with the newer build that owns it.
    expect(getCurrentVersion(db)).toBe(before);
  });

  it('accepts a database at exactly the supported version', () => {
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('still migrates a database older than this build', () => {
    // The guard must not mistake the normal forward path for version skew.
    const fresh = new Database(':memory:');
    try {
      expect(() => runMigrations(fresh)).not.toThrow();
      expect(getCurrentVersion(fresh)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      fresh.close();
    }
  });
});
