/**
 * Unit tests for worktree child-table handling (Issue #1621, Phase 0).
 *
 * The defect: `getWorktreeChildTables` enumerated child tables from foreign-key
 * metadata alone, so the three tables that carry a `worktree_id` *without*
 * declaring a constraint — `tasks` (#1548), `verification_runs` (#1544) and
 * `skill_operations` (#1428) — were invisible to it. A worktree ID rename left
 * their rows addressing an ID nothing resolves, and a delete left them behind
 * because no CASCADE fires without a foreign key.
 *
 * The fix has an exception the enumeration alone does not express:
 * `skill_operations` is an append-only ledger that aborts UPDATE and DELETE at
 * the schema level, so it is enumerated but never written. Tests below pin both
 * halves — what must now follow, and what must still be left alone.
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
import {
  migrateWorktreeIdPreservingChildren,
  deleteWorktreesByIds,
  deleteRepositoryWorktrees,
} from '@/lib/db/worktree-db';
import {
  getWorktreeChildTables,
  getDeletableWorktreeChildTables,
} from '@/lib/db/migrations/worktree-child-tables';

const REPO = '/tmp/cm-1621/repo';

/** Tables that hold a `worktree_id` but declare no foreign key to worktrees. */
const CONSTRAINTLESS_TABLES = ['tasks', 'verification_runs', 'skill_operations'];

function insertWorktree(db: Database.Database, id: string, repo = REPO): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, ?, ?, ?, 'repo')`
  ).run(id, id, `${repo}/${id}`, repo);
}

function insertChatMessage(db: Database.Database, id: string, worktreeId: string): void {
  db.prepare(
    `INSERT INTO chat_messages (id, worktree_id, role, content, timestamp)
     VALUES (?, ?, 'user', 'hello', 1800000000000)`
  ).run(id, worktreeId);
}

function insertTask(db: Database.Database, id: string, worktreeId: string): void {
  db.prepare(
    `INSERT INTO tasks (
      id, worktree_id, cli_tool_id, title, goal, contract_json, status,
      created_at, updated_at
    ) VALUES (?, ?, 'claude', 'title', 'goal', '{}', 'pending',
      1800000000000, 1800000000000)`
  ).run(id, worktreeId);
}

/** Inserts a run plus one gate result, and returns the run id. */
function insertVerificationRun(db: Database.Database, worktreeId: string): number {
  const info = db
    .prepare(
      `INSERT INTO verification_runs (worktree_id, trigger, status, started_at)
       VALUES (?, 'manual', 'passed', 1800000000000)`
    )
    .run(worktreeId);
  const runId = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO verification_gate_results (run_id, gate_id, command, status, started_at)
     VALUES (?, 'lint', 'npm run lint', 'passed', 1800000000000)`
  ).run(runId);
  return runId;
}

function insertSkillOperation(db: Database.Database, id: string, worktreeId: string): void {
  db.prepare(
    `INSERT INTO skill_operations (
      id, operation_id, idempotency_key, binding_hash, operation, state, result,
      actor_type, actor_id, worktree_id, skill_id, recorded_at
    ) VALUES (?, ?, ?, 'bh', 'install', 'completed', 'success',
      'user', 'u1', ?, 'demo-skill', 1800000000000)`
  ).run(id, `op-${id}`, `idem-${id}`, worktreeId);
}

function worktreeIdsIn(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`SELECT worktree_id FROM "${table}" ORDER BY rowid`).all() as Array<{
      worktree_id: string;
    }>
  ).map((row) => row.worktree_id);
}

function countIn(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
}

/** Every table the live schema declares a foreign key to `worktrees` from. */
function foreignKeyChildTables(db: Database.Database): Array<{ table: string; column: string }> {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);

  const children: Array<{ table: string; column: string }> = [];
  for (const table of tables) {
    if (table === 'worktrees') continue;
    const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
      table: string;
      from: string;
      to: string | null;
    }>;
    for (const fk of fks) {
      if (fk.table === 'worktrees' && (fk.to === 'id' || fk.to === null)) {
        children.push({ table, column: fk.from });
      }
    }
  }
  return children;
}

describe('getWorktreeChildTables (Issue #1621)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('enumerates tables that carry worktree_id without a foreign key', () => {
    const tables = getWorktreeChildTables(db).map((child) => child.table);

    for (const table of CONSTRAINTLESS_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it('keeps every foreign-key-declared child (no regression from #1151)', () => {
    const children = getWorktreeChildTables(db);

    for (const fkChild of foreignKeyChildTables(db)) {
      expect(children).toContainEqual(fkChild);
    }
    // The FK set is non-empty, so the assertion above is not vacuous.
    expect(foreignKeyChildTables(db).length).toBeGreaterThanOrEqual(9);
  });

  it('reports the referencing column for every child', () => {
    for (const { table, column } of getWorktreeChildTables(db)) {
      const columns = (
        db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columns).toContain(column);
    }
  });

  it('never lists worktrees itself or a sqlite internal table', () => {
    const tables = getWorktreeChildTables(db).map((child) => child.table);

    expect(tables).not.toContain('worktrees');
    expect(tables.filter((table) => table.startsWith('sqlite_'))).toEqual([]);
    // sqlite_sequence exists in this schema (AUTOINCREMENT), so the filter above
    // is actually excluding something rather than matching nothing.
    const internal = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    expect(internal.length).toBeGreaterThan(0);
  });

  it('omits tables with no worktree reference at all', () => {
    const tables = getWorktreeChildTables(db).map((child) => child.table);

    // task_events keys on task_id, verification_gate_results on run_id.
    expect(tables).not.toContain('task_events');
    expect(tables).not.toContain('verification_gate_results');
    expect(tables).not.toContain('repositories');
    expect(tables).not.toContain('schema_version');
  });

  it('lists each (table, column) pair once even when both signals match', () => {
    const keys = getWorktreeChildTables(db).map(({ table, column }) => `${table}.${column}`);

    expect(new Set(keys).size).toBe(keys.length);
    // chat_messages matches on both the column name and the declared FK.
    expect(keys).toContain('chat_messages.worktree_id');
  });

  it('excludes the append-only ledger from the deletable set only', () => {
    const all = getWorktreeChildTables(db).map((child) => child.table);
    const deletable = getDeletableWorktreeChildTables(db).map((child) => child.table);

    expect(all).toContain('skill_operations');
    expect(deletable).not.toContain('skill_operations');
    expect(deletable).toContain('tasks');
    expect(deletable).toContain('verification_runs');
    expect(deletable).toContain('chat_messages');
  });
});

describe('migrateWorktreeIdPreservingChildren (Issue #1621)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    insertWorktree(db, 'wt-old');
    insertWorktree(db, 'wt-other');
  });

  afterEach(() => db.close());

  function rename(oldId: string, newId: string): void {
    db.transaction(() => migrateWorktreeIdPreservingChildren(db, oldId, newId))();
  }

  it('repoints rows in tables that declare no foreign key', () => {
    insertTask(db, 'task-1', 'wt-old');
    insertVerificationRun(db, 'wt-old');

    rename('wt-old', 'wt-new');

    expect(worktreeIdsIn(db, 'tasks')).toEqual(['wt-new']);
    expect(worktreeIdsIn(db, 'verification_runs')).toEqual(['wt-new']);
  });

  it('still repoints foreign-key children', () => {
    insertChatMessage(db, 'msg-1', 'wt-old');

    rename('wt-old', 'wt-new');

    expect(worktreeIdsIn(db, 'chat_messages')).toEqual(['wt-new']);
  });

  it('leaves other worktrees alone', () => {
    insertTask(db, 'task-1', 'wt-old');
    insertTask(db, 'task-2', 'wt-other');

    rename('wt-old', 'wt-new');

    const rows = db
      .prepare('SELECT id, worktree_id FROM tasks ORDER BY id')
      .all() as Array<{ id: string; worktree_id: string }>;
    expect(rows).toEqual([
      { id: 'task-1', worktree_id: 'wt-new' },
      { id: 'task-2', worktree_id: 'wt-other' },
    ]);
  });

  it('does not abort on the append-only ledger, and does not rewrite it', () => {
    insertSkillOperation(db, 'op-row', 'wt-old');
    insertTask(db, 'task-1', 'wt-old');

    expect(() => rename('wt-old', 'wt-new')).not.toThrow();

    // The audit row records what happened under the identity in force at the
    // time; its BEFORE UPDATE trigger exists to keep it that way.
    expect(worktreeIdsIn(db, 'skill_operations')).toEqual(['wt-old']);
    // ...and the rest of the rename still landed.
    expect(worktreeIdsIn(db, 'tasks')).toEqual(['wt-new']);
    expect(
      db.prepare('SELECT id FROM worktrees WHERE id = ?').get('wt-new')
    ).toBeTruthy();
  });

  it('folds children into the destination when the new ID already exists', () => {
    insertTask(db, 'task-1', 'wt-old');
    insertChatMessage(db, 'msg-1', 'wt-old');

    rename('wt-old', 'wt-other');

    expect(worktreeIdsIn(db, 'tasks')).toEqual(['wt-other']);
    expect(worktreeIdsIn(db, 'chat_messages')).toEqual(['wt-other']);
    expect(db.prepare('SELECT id FROM worktrees WHERE id = ?').get('wt-old')).toBeUndefined();
  });
});

describe('deleteWorktreesByIds (Issue #1621)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    insertWorktree(db, 'wt-1');
    insertWorktree(db, 'wt-2');
  });

  afterEach(() => db.close());

  it('deletes rows in tables that declare no foreign key', () => {
    insertTask(db, 'task-1', 'wt-1');
    insertVerificationRun(db, 'wt-1');

    const result = deleteWorktreesByIds(db, ['wt-1']);

    expect(result).toEqual({ deletedCount: 1 });
    expect(countIn(db, 'tasks')).toBe(0);
    expect(countIn(db, 'verification_runs')).toBe(0);
  });

  it('takes grandchildren with it through the cascade they do declare', () => {
    insertVerificationRun(db, 'wt-1');
    expect(countIn(db, 'verification_gate_results')).toBe(1);

    deleteWorktreesByIds(db, ['wt-1']);

    expect(countIn(db, 'verification_gate_results')).toBe(0);
  });

  it('still deletes foreign-key children', () => {
    insertChatMessage(db, 'msg-1', 'wt-1');

    deleteWorktreesByIds(db, ['wt-1']);

    expect(countIn(db, 'chat_messages')).toBe(0);
  });

  it('leaves rows belonging to other worktrees', () => {
    insertTask(db, 'task-1', 'wt-1');
    insertTask(db, 'task-2', 'wt-2');
    insertChatMessage(db, 'msg-2', 'wt-2');

    deleteWorktreesByIds(db, ['wt-1']);

    expect(worktreeIdsIn(db, 'tasks')).toEqual(['wt-2']);
    expect(worktreeIdsIn(db, 'chat_messages')).toEqual(['wt-2']);
  });

  it('does not abort on the append-only ledger, and keeps its history', () => {
    insertSkillOperation(db, 'op-row', 'wt-1');
    insertTask(db, 'task-1', 'wt-1');

    expect(() => deleteWorktreesByIds(db, ['wt-1'])).not.toThrow();

    expect(countIn(db, 'worktrees')).toBe(1);
    expect(countIn(db, 'tasks')).toBe(0);
    // The audit feed reads across every worktree, including deleted ones.
    expect(worktreeIdsIn(db, 'skill_operations')).toEqual(['wt-1']);
  });

  it('is a no-op for an empty ID list', () => {
    insertTask(db, 'task-1', 'wt-1');

    expect(deleteWorktreesByIds(db, [])).toEqual({ deletedCount: 0 });
    expect(countIn(db, 'tasks')).toBe(1);
  });
});

describe('deleteRepositoryWorktrees (Issue #1621)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    insertWorktree(db, 'wt-1');
    insertWorktree(db, 'wt-2');
    insertWorktree(db, 'wt-keep', '/tmp/cm-1621/other');
  });

  afterEach(() => db.close());

  it('deletes constraint-less child rows for every worktree of the repository', () => {
    insertTask(db, 'task-1', 'wt-1');
    insertTask(db, 'task-2', 'wt-2');
    insertTask(db, 'task-keep', 'wt-keep');
    insertVerificationRun(db, 'wt-1');
    insertChatMessage(db, 'msg-1', 'wt-1');

    const result = deleteRepositoryWorktrees(db, REPO);

    expect(result).toEqual({ deletedCount: 2 });
    expect(worktreeIdsIn(db, 'tasks')).toEqual(['wt-keep']);
    expect(countIn(db, 'verification_runs')).toBe(0);
    expect(countIn(db, 'chat_messages')).toBe(0);
  });

  it('is a no-op for a repository with no worktrees', () => {
    insertTask(db, 'task-keep', 'wt-keep');

    expect(deleteRepositoryWorktrees(db, '/tmp/cm-1621/nothing-here')).toEqual({
      deletedCount: 0,
    });
    expect(countIn(db, 'worktrees')).toBe(3);
    expect(countIn(db, 'tasks')).toBe(1);
  });
});

describe('migration v52: orphaned worktree children (Issue #1621)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Bring the database to v51 — the state an existing install is in.
    runMigrations(db);
    rollbackMigrations(db, 51);
    expect(getCurrentVersion(db)).toBe(51);
  });

  afterEach(() => db.close());

  it('is registered in the schema history', () => {
    runMigrations(db);

    // v52 is no longer the head (v53 adds worktree_aliases, #1621 Phase 2), so
    // this asserts it is APPLIED rather than that it is the latest.
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(52);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const applied = db
      .prepare('SELECT name FROM schema_version WHERE version = 52')
      .get() as { name: string } | undefined;
    expect(applied?.name).toBe('delete-orphaned-worktree-children');
  });

  it('deletes rows pointing at a worktree that no longer exists', () => {
    insertWorktree(db, 'wt-live');
    insertTask(db, 'task-orphan', 'wt-gone');
    insertVerificationRun(db, 'wt-gone');

    runMigrations(db);

    expect(countIn(db, 'tasks')).toBe(0);
    expect(countIn(db, 'verification_runs')).toBe(0);
  });

  it('keeps rows whose worktree is still present', () => {
    insertWorktree(db, 'wt-live');
    insertTask(db, 'task-live', 'wt-live');
    insertTask(db, 'task-orphan', 'wt-gone');
    insertChatMessage(db, 'msg-live', 'wt-live');
    insertVerificationRun(db, 'wt-live');

    runMigrations(db);

    expect(worktreeIdsIn(db, 'tasks')).toEqual(['wt-live']);
    expect(worktreeIdsIn(db, 'chat_messages')).toEqual(['wt-live']);
    expect(worktreeIdsIn(db, 'verification_runs')).toEqual(['wt-live']);
    expect(countIn(db, 'verification_gate_results')).toBe(1);
  });

  it('takes the orphaned run gate results with it', () => {
    insertVerificationRun(db, 'wt-gone');
    expect(countIn(db, 'verification_gate_results')).toBe(1);

    runMigrations(db);

    expect(countIn(db, 'verification_gate_results')).toBe(0);
  });

  it('sweeps orphans out of foreign-key tables too', () => {
    // Reachable only with the constraint off, which is exactly how such rows
    // came to exist before the FK was added (see v46 for the same shape).
    db.pragma('foreign_keys = OFF');
    insertChatMessage(db, 'msg-orphan', 'wt-gone');
    db.pragma('foreign_keys = ON');

    runMigrations(db);

    expect(countIn(db, 'chat_messages')).toBe(0);
  });

  it('does not touch the append-only ledger', () => {
    insertSkillOperation(db, 'op-orphan', 'wt-gone');

    expect(() => runMigrations(db)).not.toThrow();

    expect(worktreeIdsIn(db, 'skill_operations')).toEqual(['wt-gone']);
  });

  it('is a no-op on a database with no orphans', () => {
    insertWorktree(db, 'wt-live');
    insertTask(db, 'task-live', 'wt-live');

    runMigrations(db);

    expect(countIn(db, 'tasks')).toBe(1);
  });
});
