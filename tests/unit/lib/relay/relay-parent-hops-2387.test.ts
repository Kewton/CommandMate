/**
 * The loop guard against the row ordering production actually produces (#2387).
 *
 * `relay-service.test.ts` states the rule with hand-built rows. This file states
 * the same rule with the *real* second writer: `recordUserTurn`, the function
 * every transcript reader calls, run against the same database a moment after a
 * delivery. That matters because the defect #2387 fixes was a green suite over
 * an input production never produces — the guard's contract was satisfied and
 * the ledger still recorded `hops = 1` for every chain, because nothing here had
 * ever asked what History looks like 662ms after a relay lands.
 *
 * So the echo is not seeded: it is *made*, by the writer that makes it, from the
 * body the delivery really sends (`buildRelayReplyMessage`). The first assertion
 * of the file is that it is an INSERT — that `recordUserTurn`'s de-duplication
 * genuinely cannot fold it into the relay row, because the relay row carries a
 * `request_id` and that path only claims rows without one. Everything after it
 * would be vacuous if that ever stopped being true.
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

describe('the delivery a transcript reader records twice (Issue #2387)', () => {
  it('really does write a second user row, and it is the newest one', async () => {
    deliverRelayToA(1);

    const recorded = await readTranscriptBack();

    // Not 'adopted': the relay row is keyed, and `recordUserTurn` only claims
    // rows with no `request_id`. This is the whole mechanism of the defect.
    expect(recorded.outcome).toBe('inserted');

    const rows = userRowsForA();
    expect(rows).toHaveLength(2);
    expect(rows[0].messageType).toBe('normal');
    expect(rows[0].content).toBe(DELIVERED_BODY);
    expect(rows[1].messageType).toBe('relay');
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
