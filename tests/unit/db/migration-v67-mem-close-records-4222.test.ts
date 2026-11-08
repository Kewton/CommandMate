/**
 * Migration v67: the end records, the notices and their attempts, and `issued_by`
 * (Issue #4222, design §3.1・§3.4).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '@/lib/db/db-migrations';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import { v67_migrations } from '@/lib/db/migrations/v67-mem-close-records';

describe('migration v67: mem close records', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  const columns = (table: string) => (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);

  it('lands on v67', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(67);
    expect(v67_migrations[0].version).toBe(67);
  });

  it('keeps the records and notices out of the worktree children (§3.4): no worktree_id column', () => {
    const children = getWorktreeChildTables(db).map((child) => child.table);
    for (const table of ['mem_close_records', 'mem_notices', 'mem_notice_attempts']) {
      expect(columns(table).length).toBeGreaterThan(0);
      expect(columns(table)).not.toContain('worktree_id');
      expect(children).not.toContain(table);
    }
    expect(columns('mem_instance_incarnations')).toContain('issued_by');
  });

  it('refuses a reserved notice without an attempt, and an issued_by outside the two', () => {
    db.prepare(
      `INSERT INTO mem_items (id, repository_id, branch, kind, state, text, origin_worktree_id, origin_worktree_incarnation,
         origin_instance_id, origin_cli_tool_id, origin_incarnation, created_by, updated_by, version, checked_rules_version,
         created_at, updated_at) VALUES ('i1', 'r', 'b', 'next', 'open', 't', 'w', 'wi', 'c', 'claude', 'inc', 'agent', 'agent', 1, 1, 1, 1)`
    ).run();
    const insert = (state: string) =>
      db
        .prepare(
          `INSERT INTO mem_notices (id, item_id, repository_id, branch, origin_worktree_ref, origin_worktree_incarnation, origin_instance_id,
             origin_cli_tool_id, origin_incarnation, item_created_at, state, created_at) VALUES ('n1', 'i1', 'r', 'b', 'w', 'wi', 'c', 'claude', 'inc', 1, ?, 1)`
        )
        .run(state);
    expect(() => insert('reserved')).toThrow();
    insert('pending');
    // The notice goes with its item (purge).
    db.prepare("DELETE FROM mem_items WHERE id = 'i1'").run();
    expect((db.prepare('SELECT COUNT(*) n FROM mem_notices').get() as { n: number }).n).toBe(0);
    db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('w', 'w', '/x/w', '/x', 'r')`).run();
    expect(() =>
      db
        .prepare(`INSERT INTO mem_instance_incarnations (worktree_id, instance_id, cli_tool_id, incarnation, created_at, issued_by) VALUES ('w', 'c', 'claude', 'x', 1, 'other')`)
        .run()
    ).toThrow();
  });

  it('rolls back what it added', () => {
    v67_migrations[0].down!(db);
    for (const table of ['mem_close_records', 'mem_notices', 'mem_notice_attempts']) {
      expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toEqual({ n: 0 });
    }
    expect(columns('mem_instance_incarnations')).not.toContain('issued_by');
    v67_migrations[0].up(db);
    expect(columns('mem_instance_incarnations')).toContain('issued_by');
  });
});
