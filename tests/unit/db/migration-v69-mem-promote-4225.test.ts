/**
 * Migration v69: the promote records of mem (Issue #4225, design §6.1).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, rollbackMigrations, runMigrations } from '@/lib/db/db-migrations';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';

const insertOperation = (db: Database.Database, id: string, itemId: string, state: string, pending = 0) =>
  db
    .prepare(
      `INSERT INTO mem_promote_operations (id, preview_id, item_id, item_version, item_fingerprint, context_worktree_id,
         context_worktree_incarnation, repository_id, destination_kind, destination, base_fingerprint, body, body_sha256,
         effect, quote_origin, state, transition_pending, approved_at, updated_at)
       VALUES (?, 'p', ?, 1, 'f', 'wt', 'inc', 'r', 'issue_comment', '{}', 'b', 'body', 'sha', 'spec', 'agent', ?, ?, 1, 1)`
    )
    .run(id, itemId, state, pending);

describe('migration v69: mem_promote_*', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  it('lands on the current version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(69);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('is no worktree child: a worktree delete does not take the record of a write outside', () => {
    const tables = getWorktreeChildTables(db).map((entry) => entry.table);
    for (const table of ['mem_promote_previews', 'mem_promote_operations', 'mem_promote_attempts']) expect(tables).not.toContain(table);
  });

  it('one operation in progress per item: approved / in_flight / unknown / succeeded waiting for its transition', () => {
    insertOperation(db, 'a', 'item', 'unknown');
    expect(() => insertOperation(db, 'b', 'item', 'in_flight')).toThrow(/UNIQUE/);
    db.prepare("UPDATE mem_promote_operations SET state = 'succeeded', transition_pending = 1 WHERE id = 'a'").run();
    expect(() => insertOperation(db, 'c', 'item', 'approved')).toThrow(/UNIQUE/);
    // (control) settled ones do not hold it.
    db.prepare("UPDATE mem_promote_operations SET transition_pending = 0 WHERE id = 'a'").run();
    insertOperation(db, 'd', 'item', 'failed');
    insertOperation(db, 'e', 'item', 'in_flight');
    expect(db.prepare('SELECT COUNT(*) AS n FROM mem_promote_operations').get()).toEqual({ n: 3 });
  });

  it('one open attempt per operation, and states it does not have are refused', () => {
    insertOperation(db, 'a', 'item', 'in_flight');
    db.prepare("INSERT INTO mem_promote_attempts (id, operation_id, boot_id, started_at) VALUES ('x', 'a', 'boot', 1)").run();
    expect(() => db.prepare("INSERT INTO mem_promote_attempts (id, operation_id, boot_id, started_at) VALUES ('y', 'a', 'boot', 1)").run()).toThrow(
      /UNIQUE/
    );
    expect(() => db.prepare("UPDATE mem_promote_operations SET state = 'sent'").run()).toThrow();
    expect(() => db.prepare("UPDATE mem_promote_attempts SET outcome = 'maybe'").run()).toThrow();
  });

  it('rolls back to v68 without touching mem_items', () => {
    rollbackMigrations(db, 68);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'mem_promote_operations'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'mem_items'").get()).toBeDefined();
  });
});
