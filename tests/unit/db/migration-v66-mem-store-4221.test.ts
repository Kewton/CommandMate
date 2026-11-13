/**
 * Migration v66: the mem store (Issue #4221, design §10).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '@/lib/db/db-migrations';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import { v66_migrations } from '@/lib/db/migrations/v66-mem-store';
// Issue #4222 / #4274: v67 builds on v66 and v68 sits above both, so going back to before v66
// goes back through v68 and then v67 first.
import { v67_migrations } from '@/lib/db/migrations/v67-mem-close-records';
import { v68_migrations } from '@/lib/db/migrations/v68-session-brief-boundaries';
// Issue #4225: v69 (mem_promote_*) sits above them all and goes back first.
import { v69_migrations } from '@/lib/db/migrations/v69-mem-promote';
import { v70_migrations } from '@/lib/db/migrations/v70-suggestion-shown';
// Issue #4227 (G-PR2): v71 (mem_handoff_*) sits above them all and goes back first.
import { v71_migrations } from '@/lib/db/migrations/v71-mem-handoff';
// Issue #4344: v72 (ask_correlations) sits above them all and goes back first.
import { v72_migrations } from '@/lib/db/migrations/v72-ask-correlations';

describe('migration v66: mem store', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  const columns = (table: string) => (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);

  it('lands on v66', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
  });

  it('keeps items out of the worktree children and the incarnations in (§10.3)', () => {
    const children = getWorktreeChildTables(db).map((child) => child.table);
    expect(children).not.toContain('mem_items');
    expect(columns('mem_items')).not.toContain('worktree_id');
    for (const table of ['mem_instance_incarnations', 'mem_worktree_incarnations', 'session_note_versions', 'session_notes']) {
      expect(children).toContain(table);
    }
  });

  it('gives an existing note version 1 and leaves it a plain note', () => {
    const fresh = new Database(':memory:');
    try {
      fresh.pragma('foreign_keys = ON');
      runMigrations(fresh);
      v72_migrations[0].down!(fresh);
      fresh.prepare('DELETE FROM schema_version WHERE version = 72').run();
      v71_migrations[0].down!(fresh);
      fresh.prepare('DELETE FROM schema_version WHERE version = 71').run();
      v70_migrations[0].down!(fresh);
      fresh.prepare('DELETE FROM schema_version WHERE version = 70').run();
      v69_migrations[0].down!(fresh);
      fresh.prepare('DELETE FROM schema_version WHERE version = 69').run();
      v68_migrations[0].down!(fresh);
      fresh.prepare('DELETE FROM schema_version WHERE version = 68').run();
      v67_migrations[0].down!(fresh);
      fresh.prepare('DELETE FROM schema_version WHERE version = 67').run();
      v66_migrations[0].down!(fresh);
      fresh.prepare('DELETE FROM schema_version WHERE version = 66').run();
      fresh.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('w', 'w', '/p', '/r', 'r')`).run();
      fresh.prepare(`INSERT INTO session_notes (worktree_id, instance_id, note, updated_at) VALUES ('w', 'claude', 'old', 1)`).run();
      runMigrations(fresh);
      expect(fresh.prepare('SELECT version, mem_item_id FROM session_notes').get()).toEqual({ version: 1, mem_item_id: null });
    } finally {
      fresh.close();
    }
  });

  it('refuses a state the kind does not have, and a key without its fingerprint', () => {
    const insert = (kind: string, state: string, key: string | null, fingerprint: string | null) =>
      db
        .prepare(
          `INSERT INTO mem_items (id, repository_id, branch, kind, state, text, origin_worktree_id, origin_worktree_incarnation,
             origin_instance_id, origin_cli_tool_id, origin_incarnation, created_by, updated_by, version, checked_rules_version,
             created_at, updated_at, idempotency_key, request_fingerprint)
           VALUES (?, 'r', 'main', ?, ?, 't', 'w', 'wi', 'claude', 'claude', 'i', 'agent', 'agent', 1, 1, 0, 0, ?, ?)`
        )
        .run(`${kind}-${state}-${key}`, kind, state, key, fingerprint);
    expect(() => insert('note', 'recorded', null, null)).toThrow();
    expect(() => insert('next', 'open', 'k', null)).toThrow();
    expect(() => insert('decision', 'recorded', null, null)).not.toThrow();
  });

  it('rolls back to the v65 shape', () => {
    v71_migrations[0].down!(db);
    v69_migrations[0].down!(db);
    v67_migrations[0].down!(db);
    v66_migrations[0].down!(db);
    expect(columns('session_notes').sort()).toEqual(['instance_id', 'note', 'updated_at', 'worktree_id']);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mem_%'").all() as unknown[]).length;
    expect(tables).toBe(0);
  });
});
