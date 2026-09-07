/**
 * Unit tests for the relay ledger's CRUD (Issue #2377).
 *
 * The point of this file is the GUARDED updates. Every write that must happen at
 * most once is a compare-and-set in SQL, and a test that only checked the happy
 * path would pass just as well against a naive read-decide-write — which is
 * exactly the shape that delivers a reply twice when the Stop hook and the
 * poller find the same finished turn. Each guard therefore gets a SECOND call
 * asserting it lost.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  cancelRelay,
  clearRelayPending,
  countOpenRelaysBetween,
  countRelays,
  createRelay,
  getRelayById,
  getRelayPromptSignature,
  getSessionRelaySummary,
  listExpiredOpenRelays,
  listOpenRelaysForWorktree,
  listOpenRelaysTo,
  listRelaysWithPendingPayload,
  markRelayDelivered,
  markRelayExpired,
  markRelayPromptNotified,
  stashRelayPayload,
} from '@/lib/db/relay-db';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const C = { worktreeId: 'wt-c', instanceId: 'copilot' };

function insertWorktree(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, NOW);
}

function open(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  for (const id of ['wt-a', 'wt-b', 'wt-c']) insertWorktree(db, id);
  return db;
}

function newRelay(db: Database.Database, from = A, to = B, hops = 1) {
  return createRelay(db, { from, to, hops, expiresAt: NOW + DAY_MS, now: NOW });
}

describe('relay-db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = open();
  });
  afterEach(() => db.close());

  describe('createRelay', () => {
    it('writes a pending row and hands back what it wrote', () => {
      const relay = newRelay(db);

      expect(relay.state).toBe('pending');
      expect(relay.hops).toBe(1);
      expect(relay.sentRequestId).toBeNull();
      expect(relay.pendingKind).toBeNull();
      expect(getRelayById(db, relay.id)).toEqual(relay);
    });

    it('keeps the two ends distinguishable', () => {
      const relay = newRelay(db);
      const read = getRelayById(db, relay.id);

      expect(read?.from).toEqual(A);
      expect(read?.to).toEqual(B);
    });
  });

  describe('reading by session', () => {
    it('separates what a session owes from what it awaits', () => {
      // A asked B; C asked A. So A awaits one and owes one.
      newRelay(db, A, B);
      newRelay(db, C, A);

      const summary = getSessionRelaySummary(db, A);
      expect(summary.awaiting.map((r) => r.to)).toEqual([B]);
      expect(summary.owed.map((r) => r.from)).toEqual([C]);
    });

    it('lists a worktree\'s relays from either end', () => {
      newRelay(db, A, B);
      newRelay(db, C, A);

      expect(listOpenRelaysForWorktree(db, 'wt-a')).toHaveLength(2);
      expect(listOpenRelaysForWorktree(db, 'wt-c')).toHaveLength(1);
    });

    it('drops a closed relay out of both lists', () => {
      const relay = newRelay(db, A, B);
      cancelRelay(db, relay.id, NOW);

      expect(getSessionRelaySummary(db, A).awaiting).toEqual([]);
      expect(listOpenRelaysTo(db, B)).toEqual([]);
      expect(listOpenRelaysForWorktree(db, 'wt-a')).toEqual([]);
    });
  });

  describe('countOpenRelaysBetween', () => {
    it('counts only the direction asked about', () => {
      newRelay(db, A, B);

      expect(countOpenRelaysBetween(db, A, B)).toBe(1);
      expect(countOpenRelaysBetween(db, B, A)).toBe(0);
    });

    it('stops counting a relay once it closes', () => {
      const relay = newRelay(db, A, B);
      markRelayDelivered(db, relay.id, `relay:${relay.id}`, NOW);

      expect(countOpenRelaysBetween(db, A, B)).toBe(0);
    });
  });

  describe('stashRelayPayload', () => {
    it('accepts the first payload and refuses the second', () => {
      const relay = newRelay(db);

      expect(stashRelayPayload(db, relay.id, 'reply', 'first', NOW)).toBe(true);
      // The second producer of the same finished turn. THIS is the guard.
      expect(stashRelayPayload(db, relay.id, 'reply', 'second', NOW)).toBe(false);

      const [pending] = listRelaysWithPendingPayload(db);
      expect(pending.body).toBe('first');
    });

    it('accepts again once the payload has been cleared', () => {
      const relay = newRelay(db);
      stashRelayPayload(db, relay.id, 'prompt', 'a confirmation', NOW);
      clearRelayPending(db, relay.id, NOW);

      expect(stashRelayPayload(db, relay.id, 'reply', 'the answer', NOW)).toBe(true);
    });

    it('refuses a relay that is no longer open', () => {
      const relay = newRelay(db);
      cancelRelay(db, relay.id, NOW);

      expect(stashRelayPayload(db, relay.id, 'reply', 'too late', NOW)).toBe(false);
    });

    it('lists a stashed payload with its kind and body', () => {
      const relay = newRelay(db);
      stashRelayPayload(db, relay.id, 'reply', '[from Codex] done', NOW);

      expect(listRelaysWithPendingPayload(db)).toEqual([
        { relay: expect.objectContaining({ id: relay.id }), kind: 'reply', body: '[from Codex] done' },
      ]);
    });
  });

  describe('markRelayDelivered', () => {
    it('closes the relay exactly once', () => {
      const relay = newRelay(db);

      expect(markRelayDelivered(db, relay.id, `relay:${relay.id}`, NOW)).toBe(true);
      expect(markRelayDelivered(db, relay.id, `relay:${relay.id}`, NOW)).toBe(false);

      const read = getRelayById(db, relay.id);
      expect(read?.state).toBe('delivered');
      expect(read?.sentRequestId).toBe(`relay:${relay.id}`);
      expect(read?.deliveredAt).toBe(NOW);
      expect(read?.pendingKind).toBeNull();
    });

    it('answers false rather than throwing when the id is already taken', () => {
      const first = newRelay(db, A, B);
      const second = newRelay(db, C, B);
      markRelayDelivered(db, first.id, 'relay:shared', NOW);

      // The UNIQUE index refusing the write IS "somebody got there first", and a
      // delivery path may not turn that into an exception.
      expect(markRelayDelivered(db, second.id, 'relay:shared', NOW)).toBe(false);
      expect(getRelayById(db, second.id)?.state).toBe('pending');
    });

    it('delivers from the prompt state', () => {
      const relay = newRelay(db);
      markRelayPromptNotified(db, relay.id, 'prompt-row-1', NOW);

      expect(markRelayDelivered(db, relay.id, `relay:${relay.id}`, NOW)).toBe(true);
    });
  });

  describe('markRelayPromptNotified', () => {
    it('records the signature and keeps the relay open', () => {
      const relay = newRelay(db);
      markRelayPromptNotified(db, relay.id, 'prompt-row-1', NOW);

      expect(getRelayById(db, relay.id)?.state).toBe('prompt');
      expect(getRelayPromptSignature(db, relay.id)).toBe('prompt-row-1');
      expect(listOpenRelaysTo(db, B).map((r) => r.id)).toEqual([relay.id]);
    });

    it('leaves a stashed payload in place (clearing is the delivery\'s job)', () => {
      const relay = newRelay(db);
      stashRelayPayload(db, relay.id, 'prompt', 'waiting on you', NOW);
      markRelayPromptNotified(db, relay.id, 'prompt-row-1', NOW);

      expect(listRelaysWithPendingPayload(db)).toHaveLength(1);
    });
  });

  describe('expiry', () => {
    it('lists only relays whose deadline has passed', () => {
      const soon = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW - 1, now: NOW });
      createRelay(db, { from: C, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });

      expect(listExpiredOpenRelays(db, NOW).map((r) => r.id)).toEqual([soon.id]);
    });

    it('expires exactly once', () => {
      const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW - 1, now: NOW });

      expect(markRelayExpired(db, relay.id, NOW)).toBe(true);
      expect(markRelayExpired(db, relay.id, NOW)).toBe(false);
      expect(getRelayById(db, relay.id)?.state).toBe('expired');
    });

    it('does not expire a relay that already delivered', () => {
      const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW - 1, now: NOW });
      markRelayDelivered(db, relay.id, `relay:${relay.id}`, NOW);

      expect(markRelayExpired(db, relay.id, NOW)).toBe(false);
      expect(getRelayById(db, relay.id)?.state).toBe('delivered');
    });
  });

  describe('cancelRelay', () => {
    it('cancels an open relay once', () => {
      const relay = newRelay(db);

      expect(cancelRelay(db, relay.id, NOW)).toBe(true);
      expect(cancelRelay(db, relay.id, NOW)).toBe(false);
      expect(getRelayById(db, relay.id)?.state).toBe('cancelled');
    });

    it('refuses to cancel a delivered relay', () => {
      const relay = newRelay(db);
      markRelayDelivered(db, relay.id, `relay:${relay.id}`, NOW);

      expect(cancelRelay(db, relay.id, NOW)).toBe(false);
    });
  });

  describe('countRelays', () => {
    it('counts per state across everything by default', () => {
      const delivered = newRelay(db, A, B);
      markRelayDelivered(db, delivered.id, `relay:${delivered.id}`, NOW);
      newRelay(db, C, B);

      expect(countRelays(db)).toEqual({
        pending: 1,
        delivered: 1,
        prompt: 0,
        expired: 0,
        cancelled: 0,
      });
    });

    it('narrows to one worktree at either end', () => {
      newRelay(db, A, B);
      newRelay(db, C, B);

      expect(countRelays(db, { worktreeId: 'wt-a' }).pending).toBe(1);
      expect(countRelays(db, { worktreeId: 'wt-b' }).pending).toBe(2);
    });

    it('narrows to one instance inside a worktree', () => {
      newRelay(db, A, B);
      newRelay(db, { worktreeId: 'wt-a', instanceId: 'claude-2' }, C);

      expect(countRelays(db, { worktreeId: 'wt-a', instanceId: 'claude' }).pending).toBe(1);
      expect(countRelays(db, { worktreeId: 'wt-a', instanceId: 'claude-2' }).pending).toBe(1);
    });

    it('honours the since window', () => {
      createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW - 10_000 });
      createRelay(db, { from: C, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });

      expect(countRelays(db, { since: NOW }).pending).toBe(1);
      expect(countRelays(db, { since: NOW - 20_000 }).pending).toBe(2);
    });
  });
});
