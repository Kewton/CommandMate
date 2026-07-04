/**
 * Unit tests for migration v37 (worktree_todos table, Issue #1015).
 *
 * Three angles (mirrors the v36 migration test):
 *  1. Fresh DB end state — the full migration chain creates the worktree_todos
 *     table with its index and the CASCADE foreign key to worktrees.
 *  2. Rollback — down() drops the table cleanly and the runner rewinds the
 *     recorded schema version.
 *  3. Idempotency — re-running the migration chain is a no-op and the table
 *     survives.
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

interface ColumnInfo { name: string; notnull: number }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe('migration v37: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the worktree_todos table', () => {
    expect(tableNames(db)).toContain('worktree_todos');
  });

  it('has the expected columns', () => {
    const cols = columns(db, 'worktree_todos').map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'worktree_id',
        'content',
        'done',
        'position',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('creates the (worktree_id, position) index', () => {
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='worktree_todos'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_worktree_todos_wt');
  });

  it('declares the ON DELETE CASCADE foreign key to worktrees', () => {
    const fks = db.pragma('foreign_key_list(worktree_todos)') as Array<{
      table: string;
      on_delete: string;
    }>;
    const wtFk = fks.find((fk) => fk.table === 'worktrees');
    expect(wtFk).toBeDefined();
    expect(wtFk!.on_delete).toBe('CASCADE');
  });
});

describe('migration v37: rollback', () => {
  it('down() drops the table and rewinds the version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableNames(db)).toContain('worktree_todos');

    rollbackMigrations(db, 36);

    expect(getCurrentVersion(db)).toBe(36);
    expect(tableNames(db)).not.toContain('worktree_todos');
    db.close();
  });
});

describe('migration v37: idempotency via runner', () => {
  it('re-running runMigrations is a no-op and keeps the table', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(tableNames(db)).toContain('worktree_todos');
    db.close();
  });
});
