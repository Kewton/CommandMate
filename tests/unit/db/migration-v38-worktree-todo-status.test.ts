/**
 * Unit tests for migration v38 (worktree_todos.status, Issue #1032).
 *
 * Three angles:
 *  1. Fresh DB end state — the full migration chain adds a NOT NULL `status`
 *     column defaulting to 'todo'.
 *  2. Backfill — applying v38.up() over a v37-shaped table maps existing rows
 *     from the legacy binary `done` flag (done=1 -> 'done', done=0 -> 'todo').
 *  3. Idempotency — re-running the migration chain is a no-op (runner-level).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION, getCurrentVersion } from '@/lib/db/db-migrations';
import { v38_migrations } from '@/lib/db/migrations/v38-worktree-todo-status';

interface ColumnInfo { name: string; notnull: number; dflt_value: string | null }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

describe('migration v38: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('brings the schema to v38', () => {
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(38);
  });

  it('adds a NOT NULL status column defaulting to "todo"', () => {
    const statusCol = columns(db, 'worktree_todos').find((c) => c.name === 'status');
    expect(statusCol).toBeDefined();
    expect(statusCol!.notnull).toBe(1);
    expect(statusCol!.dflt_value).toContain('todo');
  });

  it('keeps the legacy done column for backward compatibility', () => {
    const names = columns(db, 'worktree_todos').map((c) => c.name);
    expect(names).toContain('done');
    expect(names).toContain('status');
  });
});

describe('migration v38: backfill from the legacy done flag', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Reconstruct the v37-shaped table (no status column) to exercise up().
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE worktree_todos (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        content TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO worktree_todos (id, worktree_id, content, done, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('completed', 'wt-1', 'done task', 1, 0, 1, 1);
    insert.run('open', 'wt-1', 'open task', 0, 1, 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  it('maps done=1 -> "done" and done=0 -> "todo"', () => {
    v38_migrations[0].up(db);

    const rows = db
      .prepare('SELECT id, status FROM worktree_todos ORDER BY position ASC')
      .all() as Array<{ id: string; status: string }>;

    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId.completed).toBe('done');
    expect(byId.open).toBe('todo');
  });
});

describe('migration v38: idempotency via runner', () => {
  it('re-running runMigrations is a no-op', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const names = columns(db, 'worktree_todos').map((c) => c.name);
    expect(names).toContain('status');
    db.close();
  });
});
