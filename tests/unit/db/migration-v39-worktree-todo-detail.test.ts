/**
 * Unit tests for migration v39 (worktree_todos.detail, Issue #1034).
 *
 * Three angles:
 *  1. Fresh DB end state — the full migration chain adds a NOT NULL `detail`
 *     column defaulting to '' (empty string).
 *  2. Harmless migration — applying v39.up() over a v38-shaped table leaves
 *     existing rows with an empty detail (no data loss).
 *  3. Idempotency — re-running the migration chain is a no-op (runner-level).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION, getCurrentVersion } from '@/lib/db/db-migrations';
import { v39_migrations } from '@/lib/db/migrations/v39-worktree-todo-detail';

interface ColumnInfo { name: string; notnull: number; dflt_value: string | null }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

describe('migration v39: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('brings the schema to v39', () => {
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(39);
  });

  it('adds a NOT NULL detail column defaulting to an empty string', () => {
    const detailCol = columns(db, 'worktree_todos').find((c) => c.name === 'detail');
    expect(detailCol).toBeDefined();
    expect(detailCol!.notnull).toBe(1);
    // SQLite stores the default literal, e.g. "''".
    expect(detailCol!.dflt_value).toContain("''");
  });

  it('keeps the existing content/status columns alongside detail', () => {
    const names = columns(db, 'worktree_todos').map((c) => c.name);
    expect(names).toContain('content');
    expect(names).toContain('status');
    expect(names).toContain('detail');
  });
});

describe('migration v39: harmless migration over existing rows', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Reconstruct the v38-shaped table (no detail column) to exercise up().
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE worktree_todos (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        content TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'todo',
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO worktree_todos (id, worktree_id, content, done, status, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('existing', 'wt-1', 'legacy task', 0, 'todo', 0, 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  it('backfills existing rows with an empty detail (no data loss)', () => {
    v39_migrations[0].up(db);

    const row = db
      .prepare('SELECT id, content, detail FROM worktree_todos WHERE id = ?')
      .get('existing') as { id: string; content: string; detail: string };

    expect(row.content).toBe('legacy task');
    expect(row.detail).toBe('');
  });
});

describe('migration v39: idempotency via runner', () => {
  it('re-running runMigrations is a no-op', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const names = columns(db, 'worktree_todos').map((c) => c.name);
    expect(names).toContain('detail');
    db.close();
  });
});
