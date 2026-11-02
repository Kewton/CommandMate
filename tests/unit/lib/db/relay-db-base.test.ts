/**
 * Unit tests for `relay-db-base`, split out of `relay-db` (Issue #4096).
 *
 * The shared reads are imported from the split-out module directly, and checked to
 * be the functions `relay-db` (the public surface every caller imports)
 * re-exports.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import * as relayDb from '@/lib/db/relay-db';
import { createRelay } from '@/lib/db/relay-db';
import { getRelayById } from '@/lib/db/relay-db-base';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

function insertWorktree(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, NOW);
}

function open(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  for (const id of ['wt-a', 'wt-b']) insertWorktree(db, id);
  return db;
}

function newRelay(db: Database.Database, from = A, to = B) {
  return createRelay(db, { from, to, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
}

describe('relay-db-base', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = open();
  });
  afterEach(() => {
    db.close();
  });

  it('relay-db re-exports getRelayById from the split-out module', () => {
    expect(relayDb.getRelayById).toBe(getRelayById);
  });

  it('getRelayById reads the relay createRelay returned, and null for an unknown id', () => {
    const relay = newRelay(db);
    expect(getRelayById(db, relay.id)).toEqual(relay);
    expect(getRelayById(db, 'no-such-relay')).toBeNull();
  });
});
