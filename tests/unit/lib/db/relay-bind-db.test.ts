/**
 * Unit tests for the relay ledger's send binding (Issue #3957), imported from
 * the module it was split into (Issue #3995).
 *
 * The bound relay's writes are guarded on the attempt token and the state the
 * row is expected to be in, so each case below asserts both that the right call
 * wins and that the wrong one loses without writing.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import * as relayDb from '@/lib/db/relay-db';
import { createRelay } from '@/lib/db/relay-db';
import {
  explainRelayBindRefusal,
  failOrphanedRelayBind,
  getRelayBinding,
  getRelayPendingPayload,
  listOpenBoundRelays,
  recordRelayInputBoundary,
  reserveRelayBind,
  setRelayHold,
  settleRelaySendState,
  stashRelayPayload,
} from '@/lib/db/relay-bind-db';
import * as relayBindDb from '@/lib/db/relay-bind-db';

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

function boundRelay(db: Database.Database) {
  return createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW, bindMode: 'bound' });
}

function reserve(db: Database.Database, relayId: string, attemptId = 'attempt-1'): boolean {
  return reserveRelayBind(db, { relayId, attemptId, owner: 'boot-1', ...B, now: NOW + 1 });
}

describe('relay-bind-db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = open();
  });
  afterEach(() => db.close());

  it('relay-db re-exports the same functions, so its callers and mocks are unchanged', () => {
    const moved = [
      'reserveRelayBind',
      'explainRelayBindRefusal',
      'getRelayBinding',
      'listOpenBoundRelays',
      'recordRelayInputBoundary',
      'settleRelaySendState',
      'setRelayHold',
      'failOrphanedRelayBind',
      'stashRelayPayload',
      'clearRelayPending',
      'getRelayPendingPayload',
      'listRelaysWithPendingPayload',
      'setRelayPendingReply',
      'promoteRelayPendingReply',
    ] as const;
    for (const name of moved) {
      expect(relayDb[name]).toBe(relayBindDb[name]);
    }
  });

  describe('reserveRelayBind', () => {
    it('reserves once; a second attempt loses and the first token stays', () => {
      const relay = boundRelay(db);
      expect(reserve(db, relay.id)).toBe(true);
      expect(reserve(db, relay.id, 'attempt-2')).toBe(false);

      const binding = getRelayBinding(db, relay.id);
      expect(binding?.bindAttemptId).toBe('attempt-1');
      expect(binding?.bindOwner).toBe('boot-1');
      expect(listOpenBoundRelays(db).map((b) => b.relay.id)).toEqual([relay.id]);
    });

    it('refuses a legacy relay and one addressed elsewhere without writing', () => {
      const legacy = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
      expect(reserve(db, legacy.id)).toBe(false);
      expect(getRelayBinding(db, legacy.id)?.bindAttemptId).toBeNull();

      const bound = boundRelay(db);
      expect(
        reserveRelayBind(db, { relayId: bound.id, attemptId: 'x', owner: 'boot-1', ...A, now: NOW + 1 })
      ).toBe(false);
      expect(getRelayBinding(db, bound.id)?.bindAttemptId).toBeNull();
    });
  });

  describe('explainRelayBindRefusal', () => {
    it('400 for a missing, legacy or misaddressed relay; 409 once already bound', () => {
      expect(explainRelayBindRefusal(db, 'nope', B.worktreeId, B.instanceId, NOW).status).toBe(400);

      const legacy = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
      expect(explainRelayBindRefusal(db, legacy.id, B.worktreeId, B.instanceId, NOW)).toMatchObject({
        status: 400,
        code: 'RELAY_BIND_INVALID',
      });

      const bound = boundRelay(db);
      expect(explainRelayBindRefusal(db, bound.id, A.worktreeId, A.instanceId, NOW).status).toBe(400);

      expect(reserve(db, bound.id)).toBe(true);
      expect(explainRelayBindRefusal(db, bound.id, B.worktreeId, B.instanceId, NOW)).toMatchObject({
        status: 409,
        code: 'RELAY_BIND_CONFLICT',
      });
    });
  });

  describe('recording the send', () => {
    it('writes the boundary and settles only under the attempt token', () => {
      const relay = boundRelay(db);
      expect(reserve(db, relay.id)).toBe(true);

      const boundary = {
        relayId: relay.id,
        at: NOW + 2,
        kind: 'dispatch' as const,
        turnOpenAtSend: false,
        obsState: 'valid' as const,
        obsSource: 'hook',
        replaceDispatch: false,
        now: NOW + 2,
      };
      expect(recordRelayInputBoundary(db, { ...boundary, attemptId: 'other' })).toBe(false);
      expect(recordRelayInputBoundary(db, { ...boundary, attemptId: 'attempt-1' })).toBe(true);

      const settle = { relayId: relay.id, from: ['input_started'] as const, to: 'sent' as const, now: NOW + 3 };
      expect(settleRelaySendState(db, { ...settle, attemptId: 'other' })).toBe(false);
      expect(
        settleRelaySendState(db, { ...settle, attemptId: 'attempt-1', inputMessageId: 'msg-1' })
      ).toBe(true);

      const binding = getRelayBinding(db, relay.id);
      expect(binding?.relay.sendState).toBe('sent');
      expect(binding?.relay.inputBoundaryAt).toBe(NOW + 2);
      expect(binding?.relay.turnOpenAtSend).toBe(false);
      expect(binding?.inputMessageId).toBe('msg-1');
    });

    it('setRelayHold records the reason and can invalidate the observation', () => {
      const relay = boundRelay(db);
      setRelayHold(db, relay.id, 'generation_changed', { invalidate: true, now: NOW + 1 });
      const binding = getRelayBinding(db, relay.id);
      expect(binding?.relay.holdReason).toBe('generation_changed');
      expect(binding?.relay.obsState).toBe('invalid');
    });
  });

  describe('failOrphanedRelayBind', () => {
    it('fails and cancels an awaiting reservation, dropping its payload', () => {
      const relay = boundRelay(db);
      expect(reserve(db, relay.id)).toBe(true);
      expect(stashRelayPayload(db, relay.id, 'prompt', 'notice', NOW + 1)).toBe(true);
      expect(getRelayPendingPayload(db, relay.id)?.body).toBe('notice');

      expect(failOrphanedRelayBind(db, relay.id, 'other', 'restart', NOW + 2)).toBe(false);
      expect(failOrphanedRelayBind(db, relay.id, 'attempt-1', 'restart', NOW + 2)).toBe(true);
      expect(failOrphanedRelayBind(db, relay.id, 'attempt-1', 'restart', NOW + 3)).toBe(false);

      const binding = getRelayBinding(db, relay.id);
      expect(binding?.relay.state).toBe('cancelled');
      expect(binding?.relay.sendState).toBe('failed');
      expect(binding?.relay.holdReason).toBe('restart');
      expect(getRelayPendingPayload(db, relay.id)).toBeNull();
      expect(listOpenBoundRelays(db)).toEqual([]);
    });
  });
});
