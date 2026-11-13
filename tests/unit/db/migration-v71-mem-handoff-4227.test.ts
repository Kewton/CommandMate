/**
 * Migration v71: the hand-off's requests and proposals (Issue #4227 G-PR2, design
 * `mem-ui-4227.md` §4.3). After E's v69 and F's v70 (PM decision).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '@/lib/db/db-migrations';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import { v71_migrations } from '@/lib/db/migrations/v71-mem-handoff';

describe('migration v71: mem hand-off', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  const names = (type: string) => (db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as Array<{ name: string }>).map((row) => row.name);

  it('lands on v71 after v70', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(71);
    expect(v71_migrations.map((migration) => migration.version)).toEqual([71]);
    expect(names('table')).toEqual(expect.arrayContaining(['mem_handoff_requests', 'mem_handoff_proposals']));
    expect(names('trigger')).toEqual(
      expect.arrayContaining(['mem_handoff_proposals_immutable', 'mem_handoff_requests_pinned', 'mem_handoff_requests_forced_sticky'])
    );
  });

  it('is not a child table of a worktree (a record outlives it; no worktree_id column)', () => {
    const children = getWorktreeChildTables(db).map((child) => child.table);
    expect(children).not.toContain('mem_handoff_requests');
    const columns = (db.prepare('PRAGMA table_info("mem_handoff_requests")').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('target_worktree_id');
    expect(columns).not.toContain('worktree_id');
  });

  it('one open request per worktree and instance', () => {
    const insert = (id: string, state: string) =>
      db
        .prepare(
          `INSERT INTO mem_handoff_requests (id, repository_id, branch, detached, target_worktree_id, target_worktree_incarnation, instance_id,
             cli_tool_id, instance_on_roster, boundary_id, state, agent_deadline_at, expires_at, created_at, updated_at, version)
           VALUES (?, 'r', 'main', 0, 'w', 'wi', 'claude', 'claude', 1, 'b', ?, 1, 2, 0, 0, 1)`
        )
        .run(id, state);
    insert('a', 'awaiting_agent');
    expect(() => insert('b', 'reviewing')).toThrow(/UNIQUE/);
    insert('c', 'ended');
  });

  it('rolls back by dropping both tables and their triggers', () => {
    v71_migrations[0].down!(db);
    expect(names('table').filter((name) => name.startsWith('mem_handoff'))).toEqual([]);
    expect(names('trigger').filter((name) => name.startsWith('mem_handoff'))).toEqual([]);
  });
});
