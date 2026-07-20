/**
 * Unit tests for migration v45 (skill_installations index, Issue #1235).
 *
 * 1. Fresh DB end state — table, columns and indexes exist.
 * 2. One row per (worktree, skill), enforced by the database rather than by the
 *    upsert that happens to be written today.
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

/** v46 made worktree_id a real foreign key, so the parent row must exist. */
function insertWorktree(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, ?, ?, '/tmp/cm-1235/repo', 'repo')`
  ).run(id, id, `/tmp/cm-1235/repo/${id}`);
}

function insertRow(
  db: Database.Database,
  id: string,
  worktreeId = 'wt-1',
  skillId = 'demo-skill'
): void {
  db.prepare(
    `INSERT INTO skill_installations (
      id, worktree_id, skill_id, version, install_root, receipt_sha256,
      source_repository, source_ref, source_commit, artifact_sha256,
      effective_risk, operation_id, installed_at, updated_at
    ) VALUES (?, ?, ?, '1.2.3', '.agents/skills/demo-skill', ?,
      'Kewton/commandmate-skills', 'demo-skill-v1.2.3', ?, ?,
      'low', 'op-1', 1800000000000, 1800000000000)`
  ).run(id, worktreeId, skillId, 'd'.repeat(64), 'b'.repeat(40), 'c'.repeat(64));
}

describe('migration v45: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the skill_installations table', () => {
    expect(tableNames(db)).toContain('skill_installations');
  });

  it('has the provenance columns that join a row back to its receipt', () => {
    const cols = (db.pragma('table_info(skill_installations)') as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'worktree_id',
        'skill_id',
        'version',
        'install_root',
        'receipt_sha256',
        'source_repository',
        'source_ref',
        'source_commit',
        'artifact_sha256',
        'effective_risk',
        'operation_id',
        'installed_at',
        'updated_at',
      ])
    );
  });

  it('creates the lookup indexes', () => {
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='skill_installations'"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_skill_installations_worktree',
        'idx_skill_installations_skill',
      ])
    );
  });
});

describe('migration v45: one row per (worktree, skill)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    insertWorktree(db, 'wt-1');
    insertWorktree(db, 'wt-2');
    insertRow(db, 'install-1');
  });

  afterEach(() => {
    db.close();
  });

  it('rejects a second row for the same pair at the database level', () => {
    expect(() => insertRow(db, 'install-2')).toThrow(/UNIQUE/);
  });

  it('allows the same Skill in another worktree', () => {
    insertRow(db, 'install-2', 'wt-2');
    const count = db.prepare('SELECT COUNT(*) AS n FROM skill_installations').get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });

  it('allows another Skill in the same worktree', () => {
    insertRow(db, 'install-2', 'wt-1', 'other-skill');
    const count = db.prepare('SELECT COUNT(*) AS n FROM skill_installations').get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });
});

describe('migration v45: rollback and idempotency', () => {
  it('down() drops the table and rewinds the version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

    rollbackMigrations(db, 44);

    expect(getCurrentVersion(db)).toBe(44);
    expect(tableNames(db)).not.toContain('skill_installations');
    // The audit log v44 created is untouched by the rollback of v45.
    expect(tableNames(db)).toContain('skill_operations');
    db.close();
  });

  it('re-running runMigrations is a no-op and keeps the table', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(tableNames(db)).toContain('skill_installations');
    db.close();
  });
});
