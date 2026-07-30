/**
 * Unit tests for migration v50 (tasks, Issue #1545).
 *
 * 1. Fresh DB end state — table, index, nullability.
 * 2. The status CHECK vocabulary actually rejects unknown values (the constraint
 *    is the reason the statuses mean anything).
 * 3. Upgrade of an existing pre-v50 database, and rollback.
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
import { TASK_STATUSES } from '@/lib/db';

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name);
}

function insertTask(
  db: Database.Database,
  overrides: { id?: string; status?: string; contractJson?: string | null } = {}
): void {
  db.prepare(
    `INSERT INTO tasks
      (id, worktree_id, cli_tool_id, instance_id, title, goal, contract_path, contract_json,
       status, last_verification_run_id, created_at, updated_at, started_at, finished_at)
     VALUES (?, 'wt-1', 'claude', NULL, 'title', 'goal', '.commandmate/tasks/t.yaml', ?,
       ?, NULL, 1800000000000, 1800000000000, NULL, NULL)`
  ).run(
    overrides.id ?? 'task-1',
    overrides.contractJson === undefined ? '{"version":1}' : overrides.contractJson,
    overrides.status ?? 'pending'
  );
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('migration v50 — fresh database', () => {
  beforeEach(() => {
    runMigrations(db);
  });

  it('reaches CURRENT_SCHEMA_VERSION, which is at least 50', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(50);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('creates the tasks table and its worktree index', () => {
    expect(tableNames(db)).toContain('tasks');
    expect(indexNames(db, 'tasks')).toContain('idx_tasks_worktree');
  });

  it('accepts every status in TASK_STATUSES', () => {
    TASK_STATUSES.forEach((status, index) => {
      expect(() => insertTask(db, { id: `task-${index}`, status })).not.toThrow();
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({
      n: TASK_STATUSES.length,
    });
  });

  it('rejects a status outside the CHECK vocabulary', () => {
    expect(() => insertTask(db, { status: 'done' })).toThrow(/CHECK constraint failed/);
  });

  it('rejects a task with no contract snapshot', () => {
    expect(() => insertTask(db, { contractJson: null })).toThrow(/NOT NULL constraint failed/);
  });

  it('rejects a duplicate task id', () => {
    insertTask(db);
    expect(() => insertTask(db)).toThrow(/UNIQUE constraint failed/);
  });
});

describe('migration v50 — upgrade and rollback', () => {
  it('adds tasks to a database that stopped at v49', () => {
    runMigrations(db);
    rollbackMigrations(db, 49);
    expect(tableNames(db)).not.toContain('tasks');
    expect(getCurrentVersion(db)).toBe(49);

    runMigrations(db);
    expect(tableNames(db)).toContain('tasks');
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('keeps verification_runs intact when tasks is rolled back', () => {
    runMigrations(db);
    rollbackMigrations(db, 49);
    // verification_runs.task_id is a free column by design (v49), so dropping
    // tasks must not take the run history with it.
    expect(tableNames(db)).toContain('verification_runs');
  });
});
