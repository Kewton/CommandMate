/**
 * Unit tests for migration v44 (skill_operations audit log, Issue #1234).
 *
 * 1. Fresh DB end state — table, columns and indexes exist.
 * 2. Append-only — UPDATE and DELETE are rejected by the database itself.
 * 3. Rollback and idempotency of the migration chain.
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

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function insertRow(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO skill_operations (
      id, operation_id, idempotency_key, binding_hash, operation, state, result,
      actor_type, actor_id, worktree_id, skill_id, skill_version,
      source_origin, source_repository, source_ref, source_commit, artifact_sha256,
      error_code, error_message, recorded_at
    ) VALUES (?, 'op-1', 'key-1', 'bind-1', 'install', 'SUCCEEDED', 'succeeded',
      'user', 'user-1', 'wt-1', 'demo-skill', '1.0.0',
      'github-release', 'Kewton/commandmate-skills', 'demo-skill-v1.0.0', ?, ?,
      NULL, NULL, 1800000000000)`
  ).run(id, 'b'.repeat(40), 'c'.repeat(64));
}

describe('migration v44: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the skill_operations table', () => {
    expect(tableNames(db)).toContain('skill_operations');
  });

  it('has the source provenance and actor columns audit depends on', () => {
    const cols = (db.pragma('table_info(skill_operations)') as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'operation_id',
        'idempotency_key',
        'binding_hash',
        'operation',
        'state',
        'result',
        'actor_type',
        'actor_id',
        'worktree_id',
        'skill_id',
        'skill_version',
        'source_origin',
        'source_repository',
        'source_ref',
        'source_commit',
        'artifact_sha256',
        'error_code',
        'error_message',
        'recorded_at',
      ])
    );
  });

  it('creates the lookup indexes', () => {
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='skill_operations'"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_skill_operations_operation_id',
        'idx_skill_operations_idempotency_key',
        'idx_skill_operations_target',
      ])
    );
  });
});

describe('migration v44: append-only enforcement', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    insertRow(db, 'audit-1');
  });

  afterEach(() => {
    db.close();
  });

  it('accepts inserts', () => {
    insertRow(db, 'audit-2');
    const count = db.prepare('SELECT COUNT(*) AS n FROM skill_operations').get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('rejects UPDATE at the database level, not by convention', () => {
    expect(() =>
      db.prepare("UPDATE skill_operations SET result = 'failed' WHERE id = 'audit-1'").run()
    ).toThrow(/append-only/);
    const row = db.prepare('SELECT result FROM skill_operations WHERE id = ?').get('audit-1') as {
      result: string;
    };
    expect(row.result).toBe('succeeded');
  });

  it('rejects DELETE', () => {
    expect(() =>
      db.prepare("DELETE FROM skill_operations WHERE id = 'audit-1'").run()
    ).toThrow(/append-only/);
    const count = db.prepare('SELECT COUNT(*) AS n FROM skill_operations').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('migration v44: rollback and idempotency', () => {
  it('down() drops the table and rewinds the version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

    rollbackMigrations(db, 43);

    expect(getCurrentVersion(db)).toBe(43);
    expect(tableNames(db)).not.toContain('skill_operations');
    db.close();
  });

  it('re-running runMigrations is a no-op and keeps the table', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(tableNames(db)).toContain('skill_operations');
    db.close();
  });
});
