/**
 * Unit tests for migration v48 (audit version transition + feed indexes, Issue #1248).
 *
 * 1. Fresh DB end state — the two transition columns and both feed indexes exist.
 * 2. Rows written before v48 survive and read back with NULL transitions.
 * 3. Append-only enforcement is still intact after the migration.
 * 4. Rollback removes the columns and restores the v44 triggers.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  rollbackMigrations,
  getCurrentVersion,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/db-migrations';

function columnNames(db: Database.Database): string[] {
  return (db.pragma('table_info(skill_operations)') as Array<{ name: string }>).map((c) => c.name);
}

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='skill_operations'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function triggerNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='skill_operations'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/** Insert using only the v44 column set, the way a pre-v48 writer would. */
function insertLegacyRow(db: Database.Database, id: string, recordedAt: number): void {
  db.prepare(
    `INSERT INTO skill_operations (
      id, operation_id, idempotency_key, binding_hash, operation, state, result,
      actor_type, actor_id, worktree_id, skill_id, skill_version,
      source_origin, source_repository, source_ref, source_commit, artifact_sha256,
      error_code, error_message, recorded_at
    ) VALUES (?, 'op-1', 'key-1', 'bind-1', 'install', 'SUCCEEDED', 'succeeded',
      'user', 'user-1', 'wt-1', 'demo-skill', '1.0.0',
      'github-release', 'Kewton/commandmate-skills', 'demo-skill-v1.0.0', ?, ?,
      NULL, NULL, ?)`
  ).run(id, 'b'.repeat(40), 'c'.repeat(64), recordedAt);
}

describe('migration v48: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('adds the version transition columns', () => {
    expect(columnNames(db)).toEqual(expect.arrayContaining(['from_version', 'to_version']));
  });

  it('adds the feed indexes without dropping the v44 lookup indexes', () => {
    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        'idx_skill_operations_recent',
        'idx_skill_operations_result',
        'idx_skill_operations_operation_id',
        'idx_skill_operations_idempotency_key',
        'idx_skill_operations_target',
      ])
    );
  });

  it('keeps the cross-worktree feed off a full table scan', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM skill_operations ORDER BY recorded_at DESC, id DESC LIMIT 10`
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_skill_operations_recent');
  });

  it('leaves both transition columns nullable, since the timeline has open ends', () => {
    const info = db.pragma('table_info(skill_operations)') as Array<{
      name: string;
      notnull: number;
    }>;
    const transitions = info.filter((c) => c.name === 'from_version' || c.name === 'to_version');
    expect(transitions).toHaveLength(2);
    expect(transitions.every((c) => c.notnull === 0)).toBe(true);
  });
});

describe('migration v48: existing rows and append-only', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('reads a row written without the transition columns as NULL/NULL', () => {
    insertLegacyRow(db, 'audit-legacy', 1800000000000);
    const row = db
      .prepare('SELECT from_version, to_version FROM skill_operations WHERE id = ?')
      .get('audit-legacy') as { from_version: string | null; to_version: string | null };
    expect(row.from_version).toBeNull();
    expect(row.to_version).toBeNull();
  });

  it('still rejects UPDATE and DELETE after the ALTER TABLE', () => {
    insertLegacyRow(db, 'audit-1', 1800000000000);
    expect(() =>
      db.prepare("UPDATE skill_operations SET to_version = '2.0.0' WHERE id = 'audit-1'").run()
    ).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM skill_operations WHERE id = 'audit-1'").run()).toThrow(
      /append-only/
    );
  });
});

describe('migration v48: rollback and idempotency', () => {
  it('down() removes the columns and restores the append-only triggers', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    insertLegacyRow(db, 'audit-kept', 1800000000000);

    rollbackMigrations(db, 47);

    expect(getCurrentVersion(db)).toBe(47);
    expect(columnNames(db)).not.toContain('from_version');
    expect(columnNames(db)).not.toContain('to_version');
    expect(indexNames(db)).not.toContain('idx_skill_operations_recent');
    expect(triggerNames(db)).toEqual(
      expect.arrayContaining(['skill_operations_no_update', 'skill_operations_no_delete'])
    );
    expect(() =>
      db.prepare("DELETE FROM skill_operations WHERE id = 'audit-kept'").run()
    ).toThrow(/append-only/);

    const count = db.prepare('SELECT COUNT(*) AS n FROM skill_operations').get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('re-running runMigrations is a no-op', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(columnNames(db)).toContain('from_version');
    db.close();
  });
});
