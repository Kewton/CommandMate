/**
 * Unit tests for `relay-db-delivery`, split out of `relay-db` (Issue #4096).
 *
 * The delivered-close writes are imported from the split-out module directly, and checked to
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
import { completeRelayReplyDelivery, markRelayDelivered } from '@/lib/db/relay-db-delivery';

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

/** A relay whose reply is being delivered (payload-1 / attempt-1). */
function claimedReply(db: Database.Database) {
  const relay = newRelay(db);
  relayDb.stashRelayPayload(db, relay.id, 'reply', 'the reply', NOW, { payloadId: 'payload-1' });
  const claimed = relayDb.claimRelayPayloadDelivery(db, {
    relayId: relay.id,
    payloadId: 'payload-1',
    kind: 'reply',
    body: 'the reply',
    attemptId: 'attempt-1',
    owner: 'boot-1',
    mintPayloadId: 'unused',
    now: NOW,
  });
  expect(claimed).toBe('payload-1');
  return relay;
}

describe('relay-db-delivery', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = open();
  });
  afterEach(() => {
    db.close();
  });

  it('relay-db re-exports the delivery functions from the split-out module', () => {
    expect(relayDb.markRelayDelivered).toBe(markRelayDelivered);
    expect(relayDb.completeRelayReplyDelivery).toBe(completeRelayReplyDelivery);
  });

  it('markRelayDelivered closes a relay once', () => {
    const relay = newRelay(db);
    expect(markRelayDelivered(db, relay.id, `relay:${relay.id}`, NOW)).toBe(true);
    expect(markRelayDelivered(db, relay.id, `relay:${relay.id}`, NOW)).toBe(false);
    expect(relayDb.getRelayById(db, relay.id)?.state).toBe('delivered');
  });

  it('completeRelayReplyDelivery closes the relay for the current attempt; a stale attempt writes nothing', () => {
    const relay = claimedReply(db);
    const stale = completeRelayReplyDelivery(db, {
      relayId: relay.id,
      payloadId: 'payload-1',
      attemptId: 'attempt-other',
      sentRequestId: `relay:${relay.id}`,
      now: NOW + 1,
    });
    expect(stale).toEqual({ closed: false, completed: false });
    expect(relayDb.getRelayById(db, relay.id)?.state).toBe('pending');

    const done = completeRelayReplyDelivery(db, {
      relayId: relay.id,
      payloadId: 'payload-1',
      attemptId: 'attempt-1',
      sentRequestId: `relay:${relay.id}`,
      now: NOW + 2,
    });
    expect(done).toEqual({ closed: true, completed: true });
    expect(relayDb.getRelayById(db, relay.id)?.state).toBe('delivered');
  });
});
