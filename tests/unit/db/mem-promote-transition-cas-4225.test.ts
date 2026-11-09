/**
 * The writes that change an operation's state are conditional on the state as read
 * (Issue #4225, design §11.1 I2, 5-2d P2): an earlier request never overwrites what a
 * later request or a person's confirmation wrote. In-memory database, nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { PROMOTE_RETENTION_MS } from '@/lib/promote/model';
import {
  abandonPromoteOperation,
  acknowledgePromoteTransition,
  beginPromoteTransition,
  finishPromoteTransition,
  getPromoteOperation,
  prunePromoteRecords,
  settlePromoteOperation,
} from '@/lib/db/mem-promote-db';

let db: Database.Database;

const insert = (id: string, state: string, pending = 0) =>
  db
    .prepare(
      `INSERT INTO mem_promote_operations (id, preview_id, item_id, item_version, item_fingerprint, context_worktree_id,
         context_worktree_incarnation, repository_id, destination_kind, destination, base_fingerprint, body, body_sha256,
         effect, quote_origin, state, transition_pending, approved_at, updated_at)
       VALUES (?, 'p', ?, 1, 'f', 'wt', 'inc', 'r', 'issue_comment', '{}', 'b', 'body', 'sha', 'spec', 'agent', ?, ?, 1, 1)`
    )
    .run(id, `item-${id}`, state, pending);
const row = (id: string) => getPromoteOperation(db, id)!;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});
afterEach(() => db.close());

describe('the item’s transition of a succeeded write (I2)', () => {
  it('begin takes the claim only from the state read; a stale read is refused and changes nothing', () => {
    insert('a', 'succeeded');
    const read = row('a');
    const claim = beginPromoteTransition(db, 'a', read, 2);
    expect(claim).not.toBeNull();
    expect(row('a')).toMatchObject({ transition_pending: 1, transition_claim: claim, transition_reason: null });
    // The same (now stale) read again: the state moved since.
    expect(beginPromoteTransition(db, 'a', read, 3)).toBeNull();
    expect(row('a').transition_claim).toBe(claim);
  });

  it('a person’s acknowledgement in between: the earlier failure is not written, the pending stays ended', () => {
    insert('a', 'succeeded');
    const claim = beginPromoteTransition(db, 'a', row('a'), 2)!;
    expect(acknowledgePromoteTransition(db, 'a', row('a'), 3)).toBe(true);
    expect(finishPromoteTransition(db, 'a', claim, { moved: false, reason: 'state_forbids' }, 4)).toBe(false);
    expect(row('a')).toMatchObject({ transition_pending: 0, transition_reason: null, transition_claim: null });
  });

  it('a later request takes over: the earlier failure is not written, the later answer is', () => {
    insert('a', 'succeeded');
    const first = beginPromoteTransition(db, 'a', row('a'), 2)!;
    const second = beginPromoteTransition(db, 'a', row('a'), 3)!;
    expect(finishPromoteTransition(db, 'a', first, { moved: false, reason: 'version_conflict' }, 4)).toBe(false);
    expect(row('a')).toMatchObject({ transition_pending: 1, transition_reason: null, transition_claim: second });
    expect(finishPromoteTransition(db, 'a', second, { moved: false, reason: 'disabled' }, 5)).toBe(true);
    expect(row('a')).toMatchObject({ transition_pending: 1, transition_reason: 'disabled', transition_claim: null });
  });

  it('the item moved (A’s success) ends the pending whoever holds the claim; a later failure then writes nothing', () => {
    insert('a', 'succeeded');
    const first = beginPromoteTransition(db, 'a', row('a'), 2)!;
    const second = beginPromoteTransition(db, 'a', row('a'), 3)!;
    expect(finishPromoteTransition(db, 'a', first, { moved: true }, 4)).toBe(true);
    expect(finishPromoteTransition(db, 'a', second, { moved: false, reason: 'version_conflict' }, 5)).toBe(false);
    expect(row('a')).toMatchObject({ transition_pending: 0, transition_reason: null, transition_claim: null });
  });

  it('(control) nothing in between: the failure is written with its reason, and a new request can take it again', () => {
    insert('a', 'succeeded');
    const claim = beginPromoteTransition(db, 'a', row('a'), 2)!;
    expect(finishPromoteTransition(db, 'a', claim, { moved: false, reason: 'version_conflict' }, 3)).toBe(true);
    expect(row('a')).toMatchObject({ transition_pending: 1, transition_reason: 'version_conflict', transition_claim: null });
    expect(beginPromoteTransition(db, 'a', row('a'), 4)).not.toBeNull();
  });

  it('the acknowledgement is conditional too: read before a later request took the claim → refused', () => {
    insert('a', 'succeeded', 1);
    const read = row('a');
    beginPromoteTransition(db, 'a', read, 2);
    expect(acknowledgePromoteTransition(db, 'a', read, 3)).toBe(false);
    expect(row('a').transition_pending).toBe(1);
  });

  it('nothing but a succeeded operation takes a transition', () => {
    for (const state of ['in_flight', 'unknown', 'failed', 'abandoned']) {
      insert(state, state);
      expect(beginPromoteTransition(db, state, row(state), 2)).toBeNull();
    }
  });
});

describe('the outcome of a write (I2)', () => {
  it('a reconcile settles from unknown only: an outcome written meanwhile is not overwritten', () => {
    insert('a', 'succeeded');
    expect(settlePromoteOperation(db, 'a', { state: 'unknown', reason: 'not_found_yet' }, 2, ['unknown'])).toBe(false);
    expect(row('a').state).toBe('succeeded');
    insert('b', 'in_flight');
    expect(settlePromoteOperation(db, 'b', { state: 'failed', reason: 'x' }, 2, ['unknown'])).toBe(false);
    expect(row('b').state).toBe('in_flight');
  });

  it('a person’s abandon is never overwritten by the approval’s late answer', () => {
    insert('a', 'unknown');
    expect(abandonPromoteOperation(db, 'a', 2)).toBe(true);
    expect(settlePromoteOperation(db, 'a', { state: 'succeeded', reason: null }, 3)).toBe(false);
    expect(row('a').state).toBe('abandoned');
  });

  it('(control) the approval’s own answer settles from in_flight, and from the unknown a staleness made of it', () => {
    insert('a', 'in_flight');
    expect(settlePromoteOperation(db, 'a', { state: 'succeeded', reason: null }, 2)).toBe(true);
    insert('b', 'unknown');
    expect(settlePromoteOperation(db, 'b', { state: 'succeeded', reason: null }, 2)).toBe(true);
    expect([row('a').state, row('b').state]).toEqual(['succeeded', 'succeeded']);
  });
});

describe('retention reads the pending too', () => {
  it('a succeeded write still waiting for its transition is kept past the retention; a settled one is removed', () => {
    insert('pending', 'succeeded', 1);
    insert('done', 'succeeded', 0);
    prunePromoteRecords(db, 1 + PROMOTE_RETENTION_MS + 1);
    expect(getPromoteOperation(db, 'pending')).not.toBeNull();
    expect(getPromoteOperation(db, 'done')).toBeNull();
  });
});
