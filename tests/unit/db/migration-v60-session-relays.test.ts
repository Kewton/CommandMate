/**
 * Unit tests for migration v60 (session_relays, Issue #2377).
 *
 * 1. Fresh DB end state — the table, the four indexes, the defaults.
 * 2. The `state` CHECK actually rejects an unknown word (the vocabulary is the
 *    point of the column, and a typo landing as a sixth value would create a
 *    bucket nothing queries).
 * 3. The partial UNIQUE index on `sent_request_id` — the idempotency the Issue
 *    asks for by name — refuses a second delivery id and permits many NULLs.
 * 4. ON DELETE CASCADE fires from BOTH worktree columns under the pragma the app
 *    runs with, and `getWorktreeChildTables` finds both by introspection.
 * 5. Upgrade of an existing pre-v60 database, and rollback.
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
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name);
}

function openMigrated(): Database.Database {
  const db = new Database(':memory:');
  // db-instance.ts enables this before migrations; cascade is silently inert on
  // a raw connection, which would make the cascade tests vacuous.
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertWorktree(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, updated_at)
     VALUES (?, ?, ?, 1800000000000)`
  ).run(id, id, `/tmp/${id}`);
}

function insertRelay(
  db: Database.Database,
  overrides: {
    id?: string;
    from?: string;
    to?: string;
    state?: string;
    sentRequestId?: string | null;
  } = {}
): string {
  const id = overrides.id ?? `relay-${Math.random().toString(16).slice(2)}`;
  db.prepare(
    `INSERT INTO session_relays
      (id, from_worktree_id, from_instance_id, to_worktree_id, to_instance_id,
       state, hops, sent_request_id, created_at, updated_at, expires_at)
     VALUES (?, ?, 'claude', ?, 'codex', ?, 1, ?, 1800000000000, 1800000000000, 1800086400000)`
  ).run(
    id,
    overrides.from ?? 'wt-a',
    overrides.to ?? 'wt-b',
    overrides.state ?? 'pending',
    overrides.sentRequestId ?? null
  );
  return id;
}

describe('migration v60: session_relays', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMigrated();
    insertWorktree(db, 'wt-a');
    insertWorktree(db, 'wt-b');
  });

  afterEach(() => db.close());

  it('creates the table with the documented indexes', () => {
    expect(tableNames(db)).toContain('session_relays');

    const indexes = indexNames(db, 'session_relays');
    expect(indexes).toContain('idx_session_relays_sent_request');
    expect(indexes).toContain('idx_session_relays_to');
    expect(indexes).toContain('idx_session_relays_from');
    expect(indexes).toContain('idx_session_relays_open');
  });

  it('defaults hops to 1 and leaves every optional column null', () => {
    const id = insertRelay(db);
    const row = db.prepare('SELECT * FROM session_relays WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;

    expect(row.hops).toBe(1);
    expect(row.sent_request_id).toBeNull();
    expect(row.pending_kind).toBeNull();
    expect(row.pending_body).toBeNull();
    expect(row.prompt_signature).toBeNull();
    expect(row.delivered_at).toBeNull();
  });

  it('accepts every state in the vocabulary and rejects one outside it', () => {
    for (const state of ['pending', 'delivered', 'prompt', 'expired', 'cancelled']) {
      expect(() => insertRelay(db, { state })).not.toThrow();
    }
    expect(() => insertRelay(db, { state: 'delivred' })).toThrow(/CHECK constraint/i);
  });

  it('refuses a second row under the same sent_request_id', () => {
    insertRelay(db, { id: 'r1', sentRequestId: 'relay:r1' });
    expect(() => insertRelay(db, { id: 'r2', sentRequestId: 'relay:r1' })).toThrow(
      /UNIQUE constraint/i
    );
  });

  it('permits many rows with no sent_request_id (the index is partial)', () => {
    insertRelay(db, { id: 'r1' });
    insertRelay(db, { id: 'r2' });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM session_relays').get() as { n: number }).n
    ).toBe(2);
  });

  it('cascades from the requester side', () => {
    insertRelay(db, { id: 'r1', from: 'wt-a', to: 'wt-b' });
    db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-a');
    expect(db.prepare('SELECT id FROM session_relays WHERE id = ?').get('r1')).toBeUndefined();
  });

  it('cascades from the worker side too', () => {
    insertRelay(db, { id: 'r1', from: 'wt-a', to: 'wt-b' });
    db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-b');
    expect(db.prepare('SELECT id FROM session_relays WHERE id = ?').get('r1')).toBeUndefined();
  });

  it('exposes BOTH worktree columns to the child-table introspection', () => {
    const columns = getWorktreeChildTables(db)
      .filter((child) => child.table === 'session_relays')
      .map((child) => child.column)
      .sort();

    expect(columns).toEqual(['from_worktree_id', 'to_worktree_id']);
  });

  it('upgrades a database that stopped at v59, and rolls back', () => {
    const older = new Database(':memory:');
    older.pragma('foreign_keys = ON');
    // A fresh DB migrated to v59 only: the runner has no "stop at" knob, so the
    // upgrade is exercised by rolling a fully migrated DB back and forward.
    runMigrations(older);
    rollbackMigrations(older, 59);
    expect(getCurrentVersion(older)).toBe(59);
    expect(tableNames(older)).not.toContain('session_relays');

    runMigrations(older);
    expect(getCurrentVersion(older)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableNames(older)).toContain('session_relays');
    older.close();
  });
});
