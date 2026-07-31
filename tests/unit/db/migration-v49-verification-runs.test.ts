/**
 * Unit tests for migration v49 (verification_runs / verification_gate_results, Issue #1542).
 *
 * 1. Fresh DB end state — both tables, both indexes, nullability.
 * 2. The CHECK vocabularies actually reject unknown values (the constraints are
 *    the reason the statuses mean anything).
 * 3. ON DELETE CASCADE fires under the pragma the app runs with.
 * 4. Upgrade of an existing pre-v49 database, and rollback.
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
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name);
}

function insertRun(
  db: Database.Database,
  overrides: { trigger?: string; status?: string } = {}
): number {
  const info = db
    .prepare(
      `INSERT INTO verification_runs
        (worktree_id, instance_id, task_id, trigger, status, base_ref, started_at, finished_at)
       VALUES ('wt-1', NULL, NULL, ?, ?, 'origin/develop', 1800000000000, NULL)`
    )
    .run(overrides.trigger ?? 'manual', overrides.status ?? 'running');
  return Number(info.lastInsertRowid);
}

function insertGate(db: Database.Database, runId: number, status = 'running'): number {
  const info = db
    .prepare(
      `INSERT INTO verification_gate_results
        (run_id, gate_id, command, status, exit_code, duration_ms, log_tail, started_at, finished_at)
       VALUES (?, 'lint', 'npm run lint', ?, NULL, NULL, NULL, 1800000000000, NULL)`
    )
    .run(runId, status);
  return Number(info.lastInsertRowid);
}

function openMigrated(): Database.Database {
  const db = new Database(':memory:');
  // db-instance.ts enables this before migrations; cascade is silently inert
  // on a raw connection, which would make the cascade tests vacuous.
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('migration v49: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMigrated();
  });

  afterEach(() => {
    db.close();
  });

  it('creates both verification tables', () => {
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['verification_runs', 'verification_gate_results'])
    );
  });

  it('creates the worktree feed and run lookup indexes', () => {
    expect(indexNames(db, 'verification_runs')).toContain('idx_verification_runs_worktree');
    expect(indexNames(db, 'verification_gate_results')).toContain(
      'idx_verification_gate_results_run'
    );
  });

  it('reaches the current schema version', () => {
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(49);
  });

  it('requires worktree_id, trigger, status and started_at but nothing else', () => {
    const info = db.pragma('table_info(verification_runs)') as Array<{
      name: string;
      notnull: number;
    }>;
    const required = info.filter((c) => c.notnull === 1).map((c) => c.name);
    expect(required.sort()).toEqual(['started_at', 'status', 'trigger', 'worktree_id']);
  });

  it('leaves task_id free of a foreign key, since the tasks table lands in Phase 2', () => {
    const fks = db.pragma('foreign_key_list(verification_runs)') as Array<{ from: string }>;
    expect(fks.map((fk) => fk.from)).not.toContain('task_id');
    expect(() =>
      db
        .prepare(
          `INSERT INTO verification_runs
            (worktree_id, task_id, trigger, status, started_at)
           VALUES ('wt-1', 'task-does-not-exist', 'task', 'running', 1800000000000)`
        )
        .run()
    ).not.toThrow();
  });

  it('keeps the worktree feed off a full table scan', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM verification_runs WHERE worktree_id = 'wt-1'
         ORDER BY started_at DESC, id DESC LIMIT 20`
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_verification_runs_worktree');
  });
});

describe('migration v49: status vocabularies are enforced by the database', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMigrated();
  });

  afterEach(() => {
    db.close();
  });

  it('accepts every documented run status', () => {
    for (const status of ['running', 'passed', 'failed', 'not_started', 'error', 'cancelled']) {
      expect(() => insertRun(db, { status })).not.toThrow();
    }
  });

  it('accepts every documented trigger', () => {
    for (const trigger of ['manual', 'wait', 'api', 'task']) {
      expect(() => insertRun(db, { trigger })).not.toThrow();
    }
  });

  it('accepts every documented gate status', () => {
    const runId = insertRun(db);
    for (const status of ['running', 'passed', 'failed', 'timeout', 'skipped', 'error']) {
      expect(() => insertGate(db, runId, status)).not.toThrow();
    }
  });

  it('rejects an unknown run status', () => {
    expect(() => insertRun(db, { status: 'succeeded' })).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown trigger', () => {
    expect(() => insertRun(db, { trigger: 'cron' })).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown gate status', () => {
    const runId = insertRun(db);
    expect(() => insertGate(db, runId, 'aborted')).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown status on UPDATE, not only on INSERT', () => {
    const runId = insertRun(db);
    expect(() =>
      db.prepare('UPDATE verification_runs SET status = ? WHERE id = ?').run('done', runId)
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('migration v49: gate results are bound to their run', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMigrated();
  });

  afterEach(() => {
    db.close();
  });

  it('cascades gate results when the run is deleted', () => {
    const runId = insertRun(db);
    insertGate(db, runId);
    insertGate(db, runId);

    db.prepare('DELETE FROM verification_runs WHERE id = ?').run(runId);

    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM verification_gate_results WHERE run_id = ?')
      .get(runId) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('refuses a gate result whose run does not exist', () => {
    expect(() => insertGate(db, 9999)).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('migration v49: upgrade path and rollback', () => {
  it('upgrades an existing pre-v49 database without touching its rows', () => {
    const db = openMigrated();
    try {
      db.prepare(
        "INSERT INTO worktrees (id, name, path, updated_at) VALUES ('wt-1', 'wt', '/tmp/wt-1', 1)"
      ).run();

      rollbackMigrations(db, 48);
      expect(getCurrentVersion(db)).toBe(48);
      expect(tableNames(db)).not.toContain('verification_runs');

      runMigrations(db);

      expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(tableNames(db)).toEqual(
        expect.arrayContaining(['verification_runs', 'verification_gate_results'])
      );
      const worktrees = db.prepare('SELECT COUNT(*) AS n FROM worktrees').get() as { n: number };
      expect(worktrees.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('down() drops both tables, child before parent', () => {
    const db = openMigrated();
    try {
      const runId = insertRun(db);
      insertGate(db, runId);

      expect(() => rollbackMigrations(db, 48)).not.toThrow();

      expect(tableNames(db)).not.toContain('verification_runs');
      expect(tableNames(db)).not.toContain('verification_gate_results');
    } finally {
      db.close();
    }
  });

  it('re-running runMigrations is a no-op', () => {
    const db = openMigrated();
    try {
      const runId = insertRun(db);
      expect(() => runMigrations(db)).not.toThrow();
      const rows = db.prepare('SELECT COUNT(*) AS n FROM verification_runs').get() as { n: number };
      expect(rows.n).toBe(1);
      expect(runId).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
