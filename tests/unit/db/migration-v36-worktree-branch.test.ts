/**
 * Unit tests for migration v36 (worktrees.branch column, Issue #1003).
 *
 * Three angles:
 *  1. Fresh DB end state — running the full migration chain yields a nullable
 *     `branch` column on the worktrees table.
 *  2. Legacy apply (no data loss) — running v36.up() over a pre-v36 worktrees
 *     table adds the column while leaving existing rows intact. There is NO
 *     backfill (no in-DB source for the real branch), so the column is
 *     NULL-initialized and populated on the next sync.
 *  3. Idempotency — re-running the migration chain via the runner is a no-op
 *     (version already recorded) and the branch column survives.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { v36_migrations } from '@/lib/db/migrations/v36-worktree-branch';

interface ColumnInfo { name: string; notnull: number; dflt_value: unknown }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

describe('migration v36: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('adds a nullable branch column to worktrees', () => {
    const branch = columns(db, 'worktrees').find(c => c.name === 'branch');
    expect(branch).toBeDefined();
    // Nullable so existing/legacy rows and non-sync writers are unaffected.
    expect(branch!.notnull).toBe(0);
  });
});

describe('migration v36: legacy apply (up() in isolation)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Minimal pre-v36 worktrees schema (no branch column).
    db.exec(`
      CREATE TABLE worktrees (
        id TEXT PRIMARY KEY,
        name TEXT,
        path TEXT,
        updated_at INTEGER
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('adds branch column and preserves existing rows with branch NULL (no backfill, no data loss)', () => {
    db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?,?,?,?)`)
      .run('wt-a', 'feature/foo', '/tmp/a', 1700000000000);

    v36_migrations[0].up(db);

    const cols = columns(db, 'worktrees').map(c => c.name);
    expect(cols).toContain('branch');

    const row = db.prepare(`SELECT id, name, branch FROM worktrees WHERE id = ?`).get('wt-a') as {
      id: string;
      name: string;
      branch: string | null;
    };
    // Existing data intact; branch NULL-initialized (populated on next sync).
    expect(row).toEqual({ id: 'wt-a', name: 'feature/foo', branch: null });
  });
});

describe('migration v36: idempotency via runner', () => {
  it('re-running runMigrations is a no-op and keeps the branch column', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // Second run: v36 is already recorded, so nothing pending; must not throw.
    expect(() => runMigrations(db)).not.toThrow();

    const cols = columns(db, 'worktrees').map(c => c.name);
    expect(cols).toContain('branch');
    db.close();
  });
});
