/**
 * The loop guard against the row ordering production actually produces (#2387).
 *
 * `relay-service.test.ts` states the rule with hand-built rows. This file states
 * the same rule against the *real* second writer: `recordUserTurn`, the function
 * every transcript reader calls, run against the same database a moment after a
 * delivery. That matters because the defect #2387 fixes was a green suite over
 * an input production never produces — the guard's contract was satisfied and
 * the ledger still recorded `hops = 1` for every chain, because nothing here had
 * ever asked what History looks like 662ms after a relay lands.
 *
 * ## What #2392 changed underneath this file
 *
 * When it was written, `recordUserTurn` could not help INSERTING the echo: the
 * relay row carries `relay:<ledgerId>` and #2196's claim only ever touched rows
 * with no `request_id`. #2392 removed the echo at its source — the reader now
 * recognises the delivery's own row and writes nothing — so the first test below
 * states that new truth, including the part #2387 depends on: the delivery's
 * `request_id` is **not** rewritten, because that column is the loop guard's
 * only way back to the ledger.
 *
 * The guard's tolerance of an echo is not thereby untested, and must not be: an
 * echo row sits in every database a delivery reached before #2392 landed, and
 * any producer writing an identical `normal` row would make another. So the
 * second half of the file seeds one by hand and re-states every rule against it.
 * Together the two halves say the guard holds both for the row ordering
 * production makes now and for the one it made before.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
      mockDb = db;
    },
  };
});

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, relayRequestId } from '@/lib/db/chat-db';
import { recordUserTurn } from '@/lib/history/user-turn-recorder';
import { buildRelayReplyMessage } from '@/lib/relay/relay-messages';
import { findParentRelayHops, openRelay } from '@/lib/relay/relay-service';
import { MAX_RELAY_HOPS } from '@/lib/relay/relay-policy';

const NOW = Date.parse('2026-09-07T04:31:43.099Z');
/** The gap measured between the two rows in the UAT this Issue is written from. */
const ECHO_DELAY_MS = 662;

const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const C = { worktreeId: 'wt-c', instanceId: 'copilot' };

/** What `deliverOne` puts in A's composer for a reply. */
const DELIVERED_BODY = buildRelayReplyMessage({ alias: 'Codex 2', worktreeId: 'wt-c' }, '2');

let db: Database.Database;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

/**
 * C asks A, and the answer lands in A's composer.
 *
 * The relay row is written the way `deliverOne` writes it — `messageType:
 * 'relay'`, keyed `relay:<id>` — because that key is exactly what makes the
 * echo unavoidable.
 *
 * @returns the parent relay's id
 */
function deliverRelayToA(hops: number): string {
  const parent = openRelay(db, { from: C, to: A, now: NOW - 60_000 });
  expect(parent.ok).toBe(true);
  if (!parent.ok) throw new Error('setup');
  db.prepare('UPDATE session_relays SET hops = ? WHERE id = ?').run(hops, parent.relay.id);

  createMessage(db, {
    worktreeId: 'wt-a',
    role: 'user',
    content: DELIVERED_BODY,
    messageType: 'relay',
    timestamp: new Date(NOW),
    requestId: relayRequestId(parent.relay.id),
    cliToolId: 'claude',
    instanceId: 'claude',
  });
  return parent.relay.id;
}

/** A's own transcript reader recording the prompt it was just handed. */
function readTranscriptBack(atMs = NOW + ECHO_DELAY_MS) {
  return recordUserTurn(
    { worktreeId: 'wt-a', cliToolId: 'claude', instanceId: 'claude' },
    'claude-prompt:bbc5c6d9-ea0f-4c3b-9d21-6a5f0e2c1d47',
    DELIVERED_BODY,
    atMs
  );
}

/**
 * The echo row as it exists in a database written before #2392.
 *
 * Seeded rather than made, because the writer that made it no longer does: this
 * is the row the guard still has to see past, in every History a delivery
 * reached while `recordUserTurn` was still inserting it.
 */
function seedEchoRow(atMs = NOW + ECHO_DELAY_MS) {
  return createMessage(db, {
    worktreeId: 'wt-a',
    role: 'user',
    content: DELIVERED_BODY,
    messageType: 'normal',
    timestamp: new Date(atMs),
    requestId: 'claude-prompt:bbc5c6d9-ea0f-4c3b-9d21-6a5f0e2c1d47',
    cliToolId: 'claude',
    instanceId: 'claude',
  });
}

function userRowsForA() {
  return getMessages(db, 'wt-a', {
    limit: 50,
    cliToolId: 'claude',
    instanceId: 'claude',
    matchResolvedInstance: true,
  }).filter((message) => message.role === 'user');
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  insertWorktree('wt-c', 'copilot');
  await setMockDb(db);
});

afterEach(async () => {
  await setMockDb(null);
  db.close();
});

describe('the delivery a transcript reader reads back (Issues #2387, #2392)', () => {
  it('writes no second row, and leaves the ledger pointer on the first', async () => {
    const relayId = deliverRelayToA(1);

    const recorded = await readTranscriptBack();

    // Not 'adopted' either: #2392 recognises the row without claiming it,
    // because claiming would overwrite the `relay:<id>` this file exists to
    // protect. Everything below would be vacuous if this ever became an insert.
    expect(recorded.outcome).toBe('already-recorded');

    const rows = userRowsForA();
    expect(rows).toHaveLength(1);
    expect(rows[0].messageType).toBe('relay');
    expect(rows[0].content).toBe(DELIVERED_BODY);
    expect(rows[0].requestId).toBe(relayRequestId(relayId));
  });

  it('does not hide the parent from the loop guard', async () => {
    deliverRelayToA(1);
    await readTranscriptBack();

    expect(findParentRelayHops(db, A)).toBe(1);
  });

  it('leaves a chained relay recorded one hop deeper', async () => {
    deliverRelayToA(1);
    await readTranscriptBack();

    const result = openRelay(db, { from: A, to: B, allowRelayChain: true, now: NOW + 5_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relay.hops).toBe(2);
  });

  it('still refuses an unflagged chain five seconds after the delivery', async () => {
    deliverRelayToA(1);
    await readTranscriptBack();

    const result = openRelay(db, { from: A, to: B, now: NOW + 5_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('RELAY_CHAIN_BLOCKED');
  });

  it('still stops the chain at MAX_RELAY_HOPS', async () => {
    deliverRelayToA(MAX_RELAY_HOPS);
    await readTranscriptBack();

    const result = openRelay(db, { from: A, to: B, allowRelayChain: true, now: NOW + 5_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
  });

  it('releases the chain when the operator types something of their own', async () => {
    deliverRelayToA(1);
    await readTranscriptBack();
    createMessage(db, {
      worktreeId: 'wt-a',
      role: 'user',
      content: 'never mind, do this instead',
      messageType: 'normal',
      timestamp: new Date(NOW + 30_000),
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    expect(findParentRelayHops(db, A)).toBeNull();
    expect(openRelay(db, { from: A, to: B, now: NOW + 31_000 }).ok).toBe(true);
  });
});

describe('an echo row written before #2392 removed the duplicate', () => {
  it('is still there to be seen past — the guard, not the writer, handles it', () => {
    deliverRelayToA(1);
    seedEchoRow();

    const rows = userRowsForA();
    expect(rows).toHaveLength(2);
    expect(rows[0].messageType).toBe('normal');
    expect(rows[1].messageType).toBe('relay');
  });

  it('does not hide the parent from the loop guard', () => {
    deliverRelayToA(1);
    seedEchoRow();

    expect(findParentRelayHops(db, A)).toBe(1);
  });

  it('leaves a chained relay recorded one hop deeper', () => {
    deliverRelayToA(1);
    seedEchoRow();

    const result = openRelay(db, { from: A, to: B, allowRelayChain: true, now: NOW + 5_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relay.hops).toBe(2);
  });

  it('still refuses an unflagged chain five seconds after the delivery', () => {
    deliverRelayToA(1);
    seedEchoRow();

    const result = openRelay(db, { from: A, to: B, now: NOW + 5_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('RELAY_CHAIN_BLOCKED');
  });

  it('still stops the chain at MAX_RELAY_HOPS', () => {
    deliverRelayToA(MAX_RELAY_HOPS);
    seedEchoRow();

    const result = openRelay(db, { from: A, to: B, allowRelayChain: true, now: NOW + 5_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
  });

  it('releases the chain when the operator types something of their own', () => {
    deliverRelayToA(1);
    seedEchoRow();
    createMessage(db, {
      worktreeId: 'wt-a',
      role: 'user',
      content: 'never mind, do this instead',
      messageType: 'normal',
      timestamp: new Date(NOW + 30_000),
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    expect(findParentRelayHops(db, A)).toBeNull();
    expect(openRelay(db, { from: A, to: B, now: NOW + 31_000 }).ok).toBe(true);
  });
});
