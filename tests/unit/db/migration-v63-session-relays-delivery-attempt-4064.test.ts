/**
 * Migration v63: the relay delivery's own attempt (Issue #4064).
 *
 * 1. Up on a v62 database: existing pending payloads — `payload_id` NULL
 *    included — read as queued (no hold) and are listed for delivery.
 * 2. The CHECK constraint holds the vocabulary.
 * 3. Down drops exactly the v63 columns and keeps the rows and payloads.
 *
 * The database is a file under a fresh `fs.mkdtempSync(os.tmpdir())`
 * directory, removed in `afterEach`.
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
import { V63_SESSION_RELAY_COLUMNS } from '@/lib/db/migrations/v63-session-relays-delivery-attempt';
import { getRelayById, listRelaysWithPendingPayload } from '@/lib/db/relay-db';

let dir: string;
let db: Database.Database;

function columns(): string[] {
  return (db.prepare('PRAGMA table_info(session_relays)').all() as Array<{ name: string }>).map((c) => c.name);
}

function insertWorktree(id: string): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, 1800000000000)`).run(id, id, `/tmp/${id}`);
}

/** A row written by a v62 server: a queued payload, with or without an id. */
function insertV62Relay(id: string, payloadId: string | null): void {
  db.prepare(
    `INSERT INTO session_relays
      (id, from_worktree_id, from_instance_id, to_worktree_id, to_instance_id,
       state, hops, pending_kind, pending_body, payload_id, created_at, updated_at, expires_at)
     VALUES (?, 'wt-a', 'claude', 'wt-b', 'codex', 'pending', 1, 'reply', 'done', ?,
       1800000000000, 1800000000000, 1800086400000)`
  ).run(id, payloadId);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-v63-'));
  db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  rollbackMigrations(db, 62);
  insertWorktree('wt-a');
  insertWorktree('wt-b');
});

afterEach(() => {
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migration v63: session_relays delivery attempt (Issue #4064)', () => {
  it('starts from a v62 database without the columns (the control)', () => {
    expect(getCurrentVersion(db)).toBe(62);
    for (const column of V63_SESSION_RELAY_COLUMNS) expect(columns()).not.toContain(column);
  });

  it('up: existing pending payloads, a NULL payload id included, stay queued', () => {
    insertV62Relay('r-id', 'p1');
    insertV62Relay('r-null', null);
    runMigrations(db);

    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(63);
    for (const column of V63_SESSION_RELAY_COLUMNS) expect(columns()).toContain(column);
    expect(getRelayById(db, 'r-id')?.deliveryHold).toBeNull();
    expect(getRelayById(db, 'r-null')?.deliveryHold).toBeNull();
    expect(listRelaysWithPendingPayload(db).map((item) => item.relay.id).sort()).toEqual(['r-id', 'r-null']);
  });

  it('up: the CHECK constraint refuses a word outside the vocabulary', () => {
    runMigrations(db);
    insertV62Relay('r1', 'p1');
    const set = (value: unknown) =>
      db.prepare("UPDATE session_relays SET delivery_state = ? WHERE id = 'r1'").run(value);
    expect(() => set('attempting')).not.toThrow();
    expect(() => set('uncertain')).not.toThrow();
    expect(() => set(null)).not.toThrow();
    expect(() => set('failed')).toThrow(/CHECK constraint/i);
  });

  it('down: drops exactly the v63 columns and keeps the row and its payload', () => {
    runMigrations(db);
    insertV62Relay('r-keep', 'p1');
    db.prepare("UPDATE session_relays SET delivery_state = 'uncertain' WHERE id = 'r-keep'").run();

    rollbackMigrations(db, 62);

    expect(getCurrentVersion(db)).toBe(62);
    for (const column of V63_SESSION_RELAY_COLUMNS) expect(columns()).not.toContain(column);
    const row = db.prepare("SELECT * FROM session_relays WHERE id = 'r-keep'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ pending_kind: 'reply', pending_body: 'done', payload_id: 'p1' });
  });
});
