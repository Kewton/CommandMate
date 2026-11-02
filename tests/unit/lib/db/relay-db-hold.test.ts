/**
 * Unit tests for `relay-db-hold`, split out of `relay-db` (Issue #4096).
 *
 * The hold resolution are imported from the split-out module directly, and checked to
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
import { resolveRelayDeliveryHold } from '@/lib/db/relay-db-hold';

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

/** A relay whose reply delivery is held `uncertain` (payload-1 / attempt-1). */
function heldReply(db: Database.Database) {
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
  expect(
    relayDb.holdRelayPayloadDelivery(db, {
      relayId: relay.id,
      payloadId: 'payload-1',
      attemptId: 'attempt-1',
      reason: 'submit-unconfirmed',
      now: NOW + 1,
    })
  ).toBe(true);
  return relay;
}

describe('relay-db-hold', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = open();
  });
  afterEach(() => {
    db.close();
  });

  it('relay-db re-exports resolveRelayDeliveryHold from the split-out module', () => {
    expect(relayDb.resolveRelayDeliveryHold).toBe(resolveRelayDeliveryHold);
  });

  it('confirm closes the held reply delivered; a second confirm is refused and writes nothing', () => {
    const relay = heldReply(db);
    const input = {
      relayId: relay.id,
      payloadId: 'payload-1',
      attemptId: 'attempt-1',
      action: 'confirm' as const,
      sentRequestId: `relay:${relay.id}`,
      now: NOW + 2,
    };
    const first = resolveRelayDeliveryHold(db, input);
    expect(first).toMatchObject({ ok: true, requeued: false, promoted: false, discardedReply: null, expired: false });
    expect(first.relay?.state).toBe('delivered');

    const second = resolveRelayDeliveryHold(db, input);
    expect(second).toMatchObject({ ok: false, refusal: 'no_hold' });
    expect(second.relay?.state).toBe('delivered');
  });

  it('a stale attempt and an unknown relay are refused, and the hold stays', () => {
    const relay = heldReply(db);
    const stale = resolveRelayDeliveryHold(db, {
      relayId: relay.id,
      payloadId: 'payload-1',
      attemptId: 'attempt-old',
      action: 'discard',
      sentRequestId: `relay:${relay.id}`,
      now: NOW + 2,
    });
    expect(stale).toMatchObject({ ok: false, refusal: 'stale' });
    expect(stale.relay?.state).toBe('pending');

    const missing = resolveRelayDeliveryHold(db, {
      relayId: 'no-such-relay',
      payloadId: 'payload-1',
      attemptId: 'attempt-1',
      action: 'retry',
      sentRequestId: 'relay:no-such-relay',
      now: NOW + 2,
    });
    expect(missing).toMatchObject({ ok: false, refusal: 'not_found', relay: null });
  });
});
