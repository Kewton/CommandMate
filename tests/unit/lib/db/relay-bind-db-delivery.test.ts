/**
 * Unit tests for the relay ledger's delivery attempts, imported from the
 * module they were split into (Issue #4095).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay } from '@/lib/db/relay-db';
import * as relayBindDb from '@/lib/db/relay-bind-db';
import { getRelayPendingPayload, stashRelayPayload } from '@/lib/db/relay-bind-db';
import {
  RELAY_DELIVERY_SERVER_RESTARTED,
  claimRelayPayloadDelivery,
  completeRelayPayloadDelivery,
  endRelayPayloadAttempt,
  holdRelayPayloadDelivery,
  isCurrentRelayPayloadAttempt,
  listRelaysWithDeliveryHold,
  recoverInterruptedRelayDeliveries,
  recoverInterruptedRelayDeliveryRefs,
  releaseRelayPayloadDelivery,
} from '@/lib/db/relay-bind-db-delivery';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

function open(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  for (const id of ['wt-a', 'wt-b']) {
    db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`).run(
      id,
      id,
      `/tmp/${id}`,
      NOW
    );
  }
  return db;
}

describe('relay-bind-db-delivery', () => {
  let db: Database.Database;
  let relayId: string;

  beforeEach(() => {
    db = open();
    relayId = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW }).id;
    stashRelayPayload(db, relayId, 'reply', 'the reply', NOW + 1, { payloadId: 'p1' });
  });
  afterEach(() => db.close());

  function claim(attemptId: string, owner = 'boot-1'): string | null {
    return claimRelayPayloadDelivery(db, {
      relayId,
      payloadId: 'p1',
      kind: 'reply',
      body: 'the reply',
      attemptId,
      owner,
      mintPayloadId: 'minted',
      now: NOW + 2,
    });
  }

  it('relay-bind-db re-exports the same functions', () => {
    expect(relayBindDb.RELAY_DELIVERY_SERVER_RESTARTED).toBe(RELAY_DELIVERY_SERVER_RESTARTED);
    expect(relayBindDb.claimRelayPayloadDelivery).toBe(claimRelayPayloadDelivery);
    expect(relayBindDb.completeRelayPayloadDelivery).toBe(completeRelayPayloadDelivery);
    expect(relayBindDb.endRelayPayloadAttempt).toBe(endRelayPayloadAttempt);
    expect(relayBindDb.holdRelayPayloadDelivery).toBe(holdRelayPayloadDelivery);
    expect(relayBindDb.isCurrentRelayPayloadAttempt).toBe(isCurrentRelayPayloadAttempt);
    expect(relayBindDb.listRelaysWithDeliveryHold).toBe(listRelaysWithDeliveryHold);
    expect(relayBindDb.recoverInterruptedRelayDeliveries).toBe(recoverInterruptedRelayDeliveries);
    expect(relayBindDb.recoverInterruptedRelayDeliveryRefs).toBe(recoverInterruptedRelayDeliveryRefs);
    expect(relayBindDb.releaseRelayPayloadDelivery).toBe(releaseRelayPayloadDelivery);
  });

  it('claims once, and a completed attempt empties the slot', () => {
    expect(claim('att-1')).toBe('p1');
    expect(claim('att-2')).toBeNull();
    const ref = { relayId, payloadId: 'p1', attemptId: 'att-1', now: NOW + 3 };
    expect(isCurrentRelayPayloadAttempt(db, ref)).toBe(true);
    expect(isCurrentRelayPayloadAttempt(db, { ...ref, attemptId: 'att-2' })).toBe(false);
    expect(completeRelayPayloadDelivery(db, { ...ref, attemptId: 'att-2' })).toBe(false);
    expect(completeRelayPayloadDelivery(db, ref)).toBe(true);
    expect(getRelayPendingPayload(db, relayId)).toBeNull();
  });

  it('a released attempt queues the payload again', () => {
    claim('att-1');
    expect(releaseRelayPayloadDelivery(db, { relayId, payloadId: 'p1', attemptId: 'att-1', now: NOW + 3 })).toBe(true);
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ payloadId: 'p1', body: 'the reply' });
    expect(claim('att-2')).toBe('p1');
  });

  it('a held attempt stays in the slot and is listed with its hold', () => {
    claim('att-1');
    const ref = { relayId, payloadId: 'p1', attemptId: 'att-1', now: NOW + 3 };
    expect(holdRelayPayloadDelivery(db, { ...ref, reason: 'unknown' })).toBe(true);
    const held = listRelaysWithDeliveryHold(db, { endpoint: A });
    expect(held).toHaveLength(1);
    expect(held[0].deliveryHold).toMatchObject({ state: 'uncertain', payloadId: 'p1', attemptId: 'att-1', reason: 'unknown' });
    expect(listRelaysWithDeliveryHold(db, { worktreeId: 'wt-other' })).toEqual([]);
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ payloadId: 'p1' });
    expect(endRelayPayloadAttempt(db, ref)).toBe(false);
  });

  it('recovery holds another boot\'s attempt and leaves this boot\'s own', () => {
    claim('att-1', 'boot-old');
    expect(recoverInterruptedRelayDeliveries(db, 'boot-old', NOW + 3)).toBe(0);
    expect(recoverInterruptedRelayDeliveryRefs(db, 'boot-new', NOW + 4)).toEqual([
      { relayId, payloadId: 'p1', attemptId: 'att-1', now: NOW + 4 },
    ]);
    expect(listRelaysWithDeliveryHold(db)[0].deliveryHold?.reason).toBe(RELAY_DELIVERY_SERVER_RESTARTED);
    expect(recoverInterruptedRelayDeliveries(db, 'boot-new', NOW + 5)).toBe(0);
  });
});
