/**
 * Unit tests for the relay ledger's second slot and held count, imported from
 * the module they were split into (Issue #4095).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay } from '@/lib/db/relay-db';
import * as relayBindDb from '@/lib/db/relay-bind-db';
import { clearRelayPending, getRelayBinding, getRelayPendingPayload, stashRelayPayload } from '@/lib/db/relay-bind-db';
import {
  clearRelayPendingReply,
  clearRelayPendingReplyUnlessHeld,
  countHeldRelays,
  promoteRelayPendingReply,
  replaceRelayPromptWithPendingReply,
  replaceRelayPromptWithReply,
  setRelayPendingReply,
} from '@/lib/db/relay-bind-db-pending';
import type { RelayPendingReply } from '@/lib/db/relay-bind-db-base';

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

function reply(payloadId: string, body = 'the reply'): RelayPendingReply {
  return { candidateId: `msg-${payloadId}`, body, overlap: 'none', basis: 'test', payloadId };
}

describe('relay-bind-db-pending', () => {
  let db: Database.Database;
  let relayId: string;

  beforeEach(() => {
    db = open();
    relayId = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW }).id;
  });
  afterEach(() => db.close());

  it('relay-bind-db re-exports the same functions', () => {
    expect(relayBindDb.setRelayPendingReply).toBe(setRelayPendingReply);
    expect(relayBindDb.replaceRelayPromptWithReply).toBe(replaceRelayPromptWithReply);
    expect(relayBindDb.promoteRelayPendingReply).toBe(promoteRelayPendingReply);
    expect(relayBindDb.replaceRelayPromptWithPendingReply).toBe(replaceRelayPromptWithPendingReply);
    expect(relayBindDb.clearRelayPendingReply).toBe(clearRelayPendingReply);
    expect(relayBindDb.clearRelayPendingReplyUnlessHeld).toBe(clearRelayPendingReplyUnlessHeld);
    expect(relayBindDb.countHeldRelays).toBe(countHeldRelays);
  });

  it('keeps only the first reply behind a prompt notice, and promotes it once the notice is gone', () => {
    expect(setRelayPendingReply(db, relayId, reply('r1'), NOW + 1)).toBe(false); // no prompt notice yet
    expect(stashRelayPayload(db, relayId, 'prompt', 'the notice', NOW + 2, { payloadId: 'p1' })).toBe(true);
    expect(setRelayPendingReply(db, relayId, reply('r1'), NOW + 3)).toBe(true);
    expect(setRelayPendingReply(db, relayId, reply('r2'), NOW + 4)).toBe(false);
    expect(getRelayBinding(db, relayId)?.pendingReply?.payloadId).toBe('r1');

    expect(promoteRelayPendingReply(db, relayId, NOW + 5)).toBe(false); // the notice still holds the slot
    expect(clearRelayPending(db, relayId, NOW + 6, 'p1')).toBe(true);
    expect(promoteRelayPendingReply(db, relayId, NOW + 7)).toBe(true);
    const pending = getRelayPendingPayload(db, relayId);
    expect(pending).toMatchObject({ kind: 'reply', body: 'the reply', payloadId: 'r1' });
    expect(getRelayBinding(db, relayId)?.pendingReply).toBeNull();
  });

  it('replaceRelayPromptWithReply prefers the waiting reply and only takes the named notice', () => {
    stashRelayPayload(db, relayId, 'prompt', 'the notice', NOW + 1, { payloadId: 'p1' });
    expect(replaceRelayPromptWithReply(db, relayId, 'other', reply('r9'), NOW + 2)).toBeNull();
    expect(replaceRelayPromptWithReply(db, relayId, 'p1', reply('r2', 'given'), NOW + 3)).toBe('reply');
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'reply', body: 'given', payloadId: 'r2' });
  });

  it('replaceRelayPromptWithPendingReply moves the waiting reply into the first slot', () => {
    stashRelayPayload(db, relayId, 'prompt', 'the notice', NOW + 1, { payloadId: 'p1' });
    expect(replaceRelayPromptWithPendingReply(db, relayId, 'p1', NOW + 2)).toBe(false); // nothing waiting
    setRelayPendingReply(db, relayId, reply('r1', 'waiting'), NOW + 3);
    expect(replaceRelayPromptWithPendingReply(db, relayId, 'p1', NOW + 4)).toBe(true);
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ body: 'waiting', payloadId: 'r1' });
  });

  it('replaceRelayPromptWithReply takes the waiting reply over the given one', () => {
    stashRelayPayload(db, relayId, 'prompt', 'the notice', NOW + 1, { payloadId: 'p1' });
    setRelayPendingReply(db, relayId, reply('r1', 'waiting'), NOW + 2);
    expect(replaceRelayPromptWithReply(db, relayId, 'p1', reply('r2', 'given'), NOW + 3)).toBe('waiting-reply');
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ body: 'waiting', payloadId: 'r1' });
    expect(getRelayBinding(db, relayId)?.pendingReply).toBeNull();
  });

  it('clears the second slot, and countHeldRelays counts only uncertain holds', () => {
    stashRelayPayload(db, relayId, 'prompt', 'the notice', NOW + 1, { payloadId: 'p1' });
    setRelayPendingReply(db, relayId, reply('r1'), NOW + 2);
    expect(countHeldRelays(db)).toBe(0);
    db.prepare(`UPDATE session_relays SET delivery_state = 'uncertain' WHERE id = ?`).run(relayId);
    expect(countHeldRelays(db)).toBe(1);
    expect(countHeldRelays(db, { worktreeId: 'wt-a' })).toBe(1);
    expect(countHeldRelays(db, { worktreeId: 'wt-b', instanceId: 'other' })).toBe(0);
    expect(clearRelayPendingReplyUnlessHeld(db, relayId, NOW + 3)).toBe(false);
    clearRelayPendingReply(db, relayId, NOW + 4);
    expect(getRelayBinding(db, relayId)?.pendingReply).toBeNull();
  });
});
