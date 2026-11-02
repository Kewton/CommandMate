/**
 * Migration v62: the relay bound to its send (Issue #3957).
 *
 * 1. Up on an existing v61 database: the rows already there read as `legacy`
 *    with every new column NULL, and their pending payload is untouched.
 * 2. The CHECK constraints hold the vocabularies.
 * 3. Down drops exactly the v62 columns and keeps the rows, the pending
 *    payload, the indexes and both foreign keys (cascade still fires).
 * 4. Up → down → up is clean.
 *
 * Each database lives in a file under `os.tmpdir()` (a fresh `mkdtempSync`
 * directory, removed in `afterEach`), so the upgrade is that of a real file
 * and nothing outside the temporary directory is touched.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  runMigrations,
  rollbackMigrations,
  getCurrentVersion,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/db-migrations';
import { V62_SESSION_RELAY_COLUMNS } from '@/lib/db/migrations/v62-session-relays-bind';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import { getRelayById, listRelaysWithPendingPayload } from '@/lib/db/relay-db';

let dir: string;
let db: Database.Database;

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function indexNames(): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_relays'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name).sort();
}

function insertWorktree(id: string): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, 1800000000000)`).run(
    id,
    id,
    `/tmp/${id}`
  );
}

/** A row written by a v61 server: no v62 column named. */
function insertV61Relay(id: string, pending: { kind: string; body: string } | null = null): void {
  db.prepare(
    `INSERT INTO session_relays
      (id, from_worktree_id, from_instance_id, to_worktree_id, to_instance_id,
       state, hops, sent_request_id, pending_kind, pending_body, created_at, updated_at, expires_at)
     VALUES (?, 'wt-a', 'claude', 'wt-b', 'codex', 'pending', 1, NULL, ?, ?, 1800000000000, 1800000000000, 1800086400000)`
  ).run(id, pending?.kind ?? null, pending?.body ?? null);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-v62-'));
  db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  rollbackMigrations(db, 61);
  insertWorktree('wt-a');
  insertWorktree('wt-b');
});

afterEach(() => {
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migration v62: session_relays binding columns (Issue #3957)', () => {
  it('starts from a v61 database that has none of the columns (the control)', () => {
    expect(getCurrentVersion(db)).toBe(61);
    for (const column of V62_SESSION_RELAY_COLUMNS) expect(columns('session_relays')).not.toContain(column);
  });

  it('up: adds every column and reads the existing rows as legacy, payload kept', () => {
    insertV61Relay('r-old', { kind: 'reply', body: '[from Codex / wt-b] done' });
    runMigrations(db);

    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(62);
    for (const column of V62_SESSION_RELAY_COLUMNS) expect(columns('session_relays')).toContain(column);

    const relay = getRelayById(db, 'r-old');
    expect(relay).toMatchObject({
      bindMode: 'legacy',
      sendState: null,
      inputBoundaryAt: null,
      boundaryKind: null,
      turnOpenAtSend: null,
      obsState: null,
      holdReason: null,
      overlap: null,
    });
    expect(listRelaysWithPendingPayload(db)).toEqual([
      expect.objectContaining({ kind: 'reply', body: '[from Codex / wt-b] done' }),
    ]);
  });

  it('up: the CHECK constraints refuse words outside each vocabulary', () => {
    runMigrations(db);
    insertV61Relay('r1');
    const set = (column: string, value: unknown) =>
      db.prepare(`UPDATE session_relays SET ${column} = ? WHERE id = 'r1'`).run(value);

    expect(() => set('bind_mode', 'bound')).not.toThrow();
    expect(() => set('bind_mode', 'bond')).toThrow(/CHECK constraint/i);
    for (const state of ['awaiting', 'input_started', 'sent', 'failed', 'unknown']) {
      expect(() => set('send_state', state)).not.toThrow();
    }
    expect(() => set('send_state', 'sending')).toThrow(/CHECK constraint/i);
    expect(() => set('boundary_kind', 'dispatch')).not.toThrow();
    expect(() => set('boundary_kind', 'paste')).toThrow(/CHECK constraint/i);
    expect(() => set('turn_open_at_send', 2)).toThrow(/CHECK constraint/i);
    expect(() => set('obs_state', 'turn_unknown')).not.toThrow();
    expect(() => set('obs_state', 'stale')).toThrow(/CHECK constraint/i);
    for (const overlap of ['none', 'later', 'earlier', 'both', 'unknown']) {
      expect(() => set('overlap', overlap)).not.toThrow();
    }
    expect(() => set('overlap', 'maybe')).toThrow(/CHECK constraint/i);
    expect(() => set('bind_mode', null)).toThrow(/NOT NULL/i);
  });

  it('down: drops exactly the v62 columns and keeps rows, payload, indexes and foreign keys', () => {
    runMigrations(db);
    const indexesBefore = indexNames();
    insertV61Relay('r-keep', { kind: 'prompt', body: 'waiting' });
    db.prepare("UPDATE session_relays SET bind_mode = 'bound', send_state = 'sent' WHERE id = 'r-keep'").run();

    rollbackMigrations(db, 61);

    expect(getCurrentVersion(db)).toBe(61);
    for (const column of V62_SESSION_RELAY_COLUMNS) expect(columns('session_relays')).not.toContain(column);
    const row = db.prepare("SELECT * FROM session_relays WHERE id = 'r-keep'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ state: 'pending', pending_kind: 'prompt', pending_body: 'waiting' });
    expect(indexNames()).toEqual(indexesBefore);
    expect(
      getWorktreeChildTables(db)
        .filter((child) => child.table === 'session_relays')
        .map((child) => child.column)
        .sort()
    ).toEqual(['from_worktree_id', 'to_worktree_id']);
    db.prepare("DELETE FROM worktrees WHERE id = 'wt-b'").run();
    expect(db.prepare("SELECT id FROM session_relays WHERE id = 'r-keep'").get()).toBeUndefined();
  });

  it('up → down → up is clean', () => {
    runMigrations(db);
    rollbackMigrations(db, 61);
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    for (const column of V62_SESSION_RELAY_COLUMNS) expect(columns('session_relays')).toContain(column);
  });
});
