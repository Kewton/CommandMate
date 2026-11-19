/**
 * Issue #4420: the reply to a relay this session opened is not the parent of the
 * next relay it opens — and the replies are counted instead, so a session that
 * keeps opening a relay on every reply still stops (案 C, `MAX_RELAY_ROUNDS`).
 *
 * Rows are written the way production writes them: `relay-delivery` puts the
 * reply into the REQUESTER's history (`messageType: 'relay'`, keyed
 * `relay:<id>`, body from `buildRelayReplyMessage`). The "request" row — a
 * relay row naming a relay this session is the `to` of — is the shape the
 * #2377 / #2387 suites seed by hand; production writes none today (design §1),
 * but the guard keeps reading it (I2), so it is seeded here the same way.
 *
 * Invariants (docs/design/relay-reply-not-parent-4420.md §4):
 *  I1 a reply row is not a parent; I2 it does not hide the real parent;
 *  I3 a human row still ends the chain, echoes are still read past;
 *  I4 a row that cannot be decided is treated as before;
 *  I6 replies are counted, `MAX_RELAY_ROUNDS` refuses, the flag does not lift it;
 *  I7 replies and echoes do not push the parent out of the window, ties sort
 *     one way; I8 an echo is attributed to the relay row right behind it only.
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
    setMockDb: (value: Database.Database | null) => {
      mockDb = value;
    },
  };
});

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, relayRequestId } from '@/lib/db/chat-db';
import { markRelayDelivered, markRelayExpired } from '@/lib/db/relay-db';
import { recordUserTurn } from '@/lib/history/user-turn-recorder';
import { buildRelayReplyMessage } from '@/lib/relay/relay-messages';
import {
  countConsecutiveReplyRounds,
  findParentRelayHops,
  scanRelayLineage,
  openRelay,
  withdrawRelay,
  type OpenRelayResult,
} from '@/lib/relay/relay-service';
import {
  decideRelayCreation,
  MAX_RELAY_HOPS,
  MAX_RELAY_LINEAGE_ROWS,
  MAX_RELAY_ROUNDS,
} from '@/lib/relay/relay-policy';
import type { RelayEndpoint, SessionRelay } from '@/lib/relay/types';

const NOW = Date.parse('2026-11-19T03:00:00.000Z');
const ECHO_DELAY_MS = 662;

const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const C = { worktreeId: 'wt-c', instanceId: 'copilot' };
const D = { worktreeId: 'wt-d', instanceId: 'codex' };
const X = { worktreeId: 'wt-x', instanceId: 'claude' };

let db: Database.Database;
let clock: number;
let replySeq: number;

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

function tick(ms = 1_000): number {
  clock += ms;
  return clock;
}

function open(
  from: RelayEndpoint,
  to: RelayEndpoint,
  allowRelayChain = false
): OpenRelayResult {
  return openRelay(db, { from, to, allowRelayChain, now: tick() });
}

function mustOpen(from: RelayEndpoint, to: RelayEndpoint, allowRelayChain = false): SessionRelay {
  const result = open(from, to, allowRelayChain);
  if (!result.ok) throw new Error(`setup: ${result.refusal.code}`);
  return result.relay;
}

/** A user row in A's history (A is claude in wt-a). */
function rowOnA(
  content: string,
  atMs: number,
  extra: { messageType?: 'relay' | 'normal'; requestId?: string } = {}
): void {
  createMessage(db, {
    worktreeId: 'wt-a',
    role: 'user',
    content,
    messageType: extra.messageType ?? 'normal',
    timestamp: new Date(atMs),
    requestId: extra.requestId,
    cliToolId: 'claude',
    instanceId: 'claude',
  });
}

/**
 * The reply to `relay` (A is its `from`) landing in A's composer, as
 * `deliverOne` writes it, and the ledger closing it.
 *
 * @returns the body, so an echo can repeat it
 */
function deliverReply(
  relay: SessionRelay,
  options: { echo?: boolean; atMs?: number } = {}
): string {
  replySeq += 1;
  const body = buildRelayReplyMessage(
    { alias: `Agent ${replySeq}`, worktreeId: relay.to.worktreeId },
    `answer ${replySeq}`
  );
  const at = options.atMs ?? tick();
  rowOnA(body, at, { messageType: 'relay', requestId: relayRequestId(relay.id) });
  markRelayDelivered(db, relay.id, relayRequestId(relay.id), at);
  if (options.echo) seedEcho(body, at + ECHO_DELAY_MS);
  return body;
}

/** The transcript reader's pre-#2392 twin of a delivered row. */
function seedEcho(body: string, atMs: number): void {
  rowOnA(body, atMs, { requestId: `claude-prompt:${atMs}` });
  if (clock < atMs) clock = atMs;
}

/**
 * X asked A over a relay of depth `hops`, seeded as a relay row in A's history
 * naming a relay A is the `to` of (the #2377 / #2387 fixture shape).
 */
function seedRequestFromX(hops: number, atMs = tick()): string {
  const parent = openRelay(db, { from: X, to: A, now: atMs - 500 });
  if (!parent.ok) throw new Error('setup');
  db.prepare('UPDATE session_relays SET hops = ? WHERE id = ?').run(hops, parent.relay.id);
  rowOnA(`[from Claude / wt-x] please do ${hops}`, atMs, {
    messageType: 'relay',
    requestId: relayRequestId(parent.relay.id),
  });
  return parent.relay.id;
}

/** A `prompt` / `expired` notice: a relay row with no ledger key. */
function seedNotice(i: number, atMs = tick()): string {
  const body = `[from Codex / wt-b] waiting on a confirmation ${i}`;
  rowOnA(body, atMs, { messageType: 'relay' });
  return body;
}

function humanTypesOnA(text = 'a person typed this', atMs = tick()): void {
  rowOnA(text, atMs);
}

/** A's own relays, opened and answered `n` times in a row with nothing in between. */
function roundTrips(n: number, targets: RelayEndpoint[] = [B]): void {
  for (let i = 0; i < n; i += 1) {
    deliverReply(mustOpen(A, targets[i % targets.length]));
  }
}

function relayCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM session_relays').get() as { n: number }).n;
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  insertWorktree('wt-c', 'copilot');
  insertWorktree('wt-d', 'codex');
  insertWorktree('wt-x', 'claude');
  clock = NOW;
  replySeq = 0;
  await setMockDb(db);
});

afterEach(async () => {
  await setMockDb(null);
  db.close();
});

describe('#4420 the reply to my own relay is not the parent of the next one (I1)', () => {
  it('lets A ask B again, unflagged, once B has answered — at depth 1', () => {
    deliverReply(mustOpen(A, B));

    const result = open(A, B);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relay.hops).toBe(1);
    expect(findParentRelayHops(db, A)).toBeNull();
  });

  it('lets A ask somebody else (C) after B answered', () => {
    deliverReply(mustOpen(A, B));

    const result = open(A, C);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relay.hops).toBe(1);
  });

  it('lets the third request through as well', () => {
    deliverReply(mustOpen(A, B));
    deliverReply(mustOpen(A, B));

    const result = open(A, B);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relay.hops).toBe(1);
  });

  it('reads past the pre-#2392 echo of each reply too', () => {
    deliverReply(mustOpen(A, B), { echo: true });
    deliverReply(mustOpen(A, C), { echo: true });

    const result = open(A, B);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relay.hops).toBe(1);
  });
});

describe('#4420 a reply does not hide the real parent (I2, I9)', () => {
  it('(i) keeps the depth-2 parent behind the reply: unflagged refused, flagged depth 3 again', () => {
    seedRequestFromX(2);
    const ab = mustOpen(A, B, true);
    expect(ab.hops).toBe(3);
    deliverReply(ab);

    expect(findParentRelayHops(db, A)).toBe(2);

    const unflagged = open(A, C);
    expect(unflagged.ok).toBe(false);
    if (!unflagged.ok) expect(unflagged.refusal.code).toBe('RELAY_CHAIN_BLOCKED');

    const flagged = open(A, C, true);
    expect(flagged.ok).toBe(true);
    if (!flagged.ok) return;
    expect(flagged.relay.hops).toBe(3);
  });

  it('(ii) refuses the next one when the parent behind the reply is already at MAX_RELAY_HOPS', () => {
    // A→B is opened before the parent row exists (the ledger order does not
    // matter, only the history's): the reply then sits in front of the parent.
    const ab = mustOpen(A, B);
    seedRequestFromX(MAX_RELAY_HOPS);
    deliverReply(ab);

    const flagged = open(A, C, true);
    expect(flagged.ok).toBe(false);
    if (!flagged.ok) expect(flagged.refusal.code).toBe('RELAY_HOPS_EXCEEDED');

    const unflagged = open(A, C);
    expect(unflagged.ok).toBe(false);
    if (!unflagged.ok) expect(unflagged.refusal.code).toBe('RELAY_CHAIN_BLOCKED');
  });

  it('still lets a human row between the parent and the reply end the chain (I3)', () => {
    const ab = mustOpen(A, B);
    seedRequestFromX(2);
    humanTypesOnA();
    deliverReply(ab);

    expect(findParentRelayHops(db, A)).toBeNull();
    expect(open(A, C).ok).toBe(true);
  });

  it('still lets a human row after the reply end the chain (I3)', () => {
    seedRequestFromX(2);
    deliverReply(mustOpen(A, B, true));
    humanTypesOnA();

    expect(findParentRelayHops(db, A)).toBeNull();
    expect(open(A, C).ok).toBe(true);
  });
});

describe('#4420 rows that cannot be decided are treated as before (I4)', () => {
  it('treats a reply row whose relay is gone as the parent: null, and the parent behind it is not reached', () => {
    seedRequestFromX(2);
    rowOnA('[from Ghost / wt-b] gone', tick(), {
      messageType: 'relay',
      requestId: relayRequestId('a-relay-that-never-existed'),
    });

    expect(findParentRelayHops(db, A)).toBeNull();
    expect(open(A, C).ok).toBe(true);
  });

  it('answers null when the newest relay row is a notice with no ledger key', () => {
    seedRequestFromX(2);
    rowOnA('[from Codex / wt-b] is waiting on a confirmation', tick(), { messageType: 'relay' });

    expect(findParentRelayHops(db, A)).toBeNull();
  });

  it('does not take a relay of the same worktree but another instance as A\'s own', () => {
    // wt-a/claude-2 opened it; the row is (wrongly) in A's history. Not A's
    // reply, so it is a parent, as every non-reply relay row was before.
    const other = { worktreeId: 'wt-a', instanceId: 'claude-2' };
    const relay = openRelay(db, { from: other, to: B, now: tick() });
    if (!relay.ok) throw new Error('setup');
    db.prepare('UPDATE session_relays SET hops = 2 WHERE id = ?').run(relay.relay.id);
    rowOnA('[from Codex / wt-b] for claude-2', tick(), {
      messageType: 'relay',
      requestId: relayRequestId(relay.relay.id),
    });

    expect(findParentRelayHops(db, A)).toBe(2);
  });
});

describe('#4420 the window and the order of equal timestamps (I7)', () => {
  it.each([
    ['5th', 2, false],
    ['6th', 2, true],
    ['7th', 3, false],
  ])('finds the parent as the %s user row behind replies and echoes', (_label, pairs, extraReply) => {
    seedRequestFromX(2);
    const relays: SessionRelay[] = [];
    const targets = [B, C, D];
    for (let i = 0; i < pairs + (extraReply ? 1 : 0); i += 1) relays.push(mustOpen(A, targets[i], true));
    for (let i = 0; i < pairs; i += 1) deliverReply(relays[i], { echo: true });
    if (extraReply) deliverReply(relays[pairs]);

    expect(findParentRelayHops(db, A)).toBe(2);
    const result = open(A, C);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('RELAY_CHAIN_BLOCKED');
  });

  it.each([
    ['echo inserted first', true],
    ['reply inserted first', false],
  ])('reads an echo with the same timestamp as its reply as the echo (%s)', (_label, echoFirst) => {
    seedRequestFromX(2);
    const ab = mustOpen(A, B, true);
    const at = tick();
    replySeq += 1;
    const body = buildRelayReplyMessage({ alias: 'Same', worktreeId: 'wt-b' }, 'same time');
    const reply = () =>
      rowOnA(body, at, { messageType: 'relay', requestId: relayRequestId(ab.id) });
    const echo = () => rowOnA(body, at, { requestId: 'claude-prompt:same' });
    if (echoFirst) {
      echo();
      reply();
    } else {
      reply();
      echo();
    }
    markRelayDelivered(db, ab.id, relayRequestId(ab.id), at);

    expect(findParentRelayHops(db, A)).toBe(2);
    expect(countConsecutiveReplyRounds(db, A)).toBe(1);
  });

  it.each([
    ['human inserted first', true],
    ['reply inserted first', false],
  ])('reads a human row with the same timestamp as a reply as newer: the chain ends (%s)', (_label, humanFirst) => {
    seedRequestFromX(2);
    const ab = mustOpen(A, B, true);
    const at = tick();
    const reply = () =>
      rowOnA('[from Codex / wt-b] tie', at, { messageType: 'relay', requestId: relayRequestId(ab.id) });
    if (humanFirst) {
      humanTypesOnA('typed in the same millisecond', at);
      reply();
    } else {
      reply();
      humanTypesOnA('typed in the same millisecond', at);
    }

    expect(findParentRelayHops(db, A)).toBeNull();
    expect(countConsecutiveReplyRounds(db, A)).toBe(0);
  });

  it.each([
    ['parent inserted first', true],
    ['reply inserted first', false],
  ])('finds the parent when it and a reply share a timestamp (%s)', (_label, parentFirst) => {
    const ab = mustOpen(A, B);
    const at = tick();
    const reply = () =>
      rowOnA('[from Codex / wt-b] tie', at, { messageType: 'relay', requestId: relayRequestId(ab.id) });
    if (parentFirst) {
      seedRequestFromX(2, at);
      reply();
    } else {
      reply();
      seedRequestFromX(2, at);
    }

    expect(findParentRelayHops(db, A)).toBe(2);
  });
});

describe('#4420 an echo belongs to the relay row right behind it only (I8)', () => {
  it('reads "echo R2 → reply R2 → echo R1 → parent R1" as a parent', () => {
    const ab = mustOpen(A, B);
    const parentAt = tick();
    seedRequestFromX(2, parentAt);
    seedEcho(`[from Claude / wt-x] please do 2`, parentAt + ECHO_DELAY_MS);
    deliverReply(ab, { echo: true });

    expect(findParentRelayHops(db, A)).toBe(2);
  });

  it('does not let a row with the reply\'s body, older than the reply, pass as the parent\'s echo', () => {
    const ab = mustOpen(A, B);
    seedRequestFromX(2);
    const replyAt = tick(5_000);
    replySeq += 1;
    const body = buildRelayReplyMessage({ alias: 'Codex', worktreeId: 'wt-b' }, 'early');
    rowOnA(body, replyAt - 2_000); // same body, but before the reply: not its echo
    rowOnA(body, replyAt, { messageType: 'relay', requestId: relayRequestId(ab.id) });
    markRelayDelivered(db, ab.id, relayRequestId(ab.id), replyAt);

    expect(findParentRelayHops(db, A)).toBeNull();
    expect(countConsecutiveReplyRounds(db, A)).toBe(1);
  });

  it('#2392: the transcript reader writes no row for a delivered reply, so nothing is there to attribute', async () => {
    seedRequestFromX(2);
    const ab = mustOpen(A, B, true);
    const body = deliverReply(ab);

    const recorded = await recordUserTurn(
      { worktreeId: 'wt-a', cliToolId: 'claude', instanceId: 'claude' },
      'claude-prompt:4420-reader',
      body,
      clock + ECHO_DELAY_MS
    );

    expect(recorded.outcome).toBe('already-recorded');
    expect(findParentRelayHops(db, A)).toBe(2);
    expect(countConsecutiveReplyRounds(db, A)).toBe(1);
  });

  it('known limit (#2387 rule, unchanged): a person retyping the reply\'s exact body reads as its echo', () => {
    seedRequestFromX(2);
    const body = deliverReply(mustOpen(A, B, true));
    rowOnA(body, tick(30_000)); // unkeyed, as `/send` writes it

    expect(findParentRelayHops(db, A)).toBe(2);
    expect(countConsecutiveReplyRounds(db, A)).toBe(1);
  });

  it('a person typing anything else ends the chain', () => {
    seedRequestFromX(2);
    deliverReply(mustOpen(A, B, true));
    humanTypesOnA('a different body');

    expect(findParentRelayHops(db, A)).toBeNull();
    expect(countConsecutiveReplyRounds(db, A)).toBe(0);
  });
});

describe('#4420 round trips are counted and capped at MAX_RELAY_ROUNDS (I6)', () => {
  it('lets the request after MAX_RELAY_ROUNDS - 1 replies through', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);

    expect(countConsecutiveReplyRounds(db, A)).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, B).ok).toBe(true);
  });

  it('refuses the request after MAX_RELAY_ROUNDS replies with RELAY_HOPS_EXCEEDED, flag or not', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    const before = relayCount();

    const unflagged = open(A, B);
    expect(unflagged.ok).toBe(false);
    if (!unflagged.ok) {
      expect(unflagged.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
      expect(unflagged.refusal.message).toContain(`${MAX_RELAY_ROUNDS}`);
      expect(unflagged.refusal.message).toMatch(/in a row/);
      expect(unflagged.refusal.message).not.toMatch(/Relay chains stop at/);
    }

    const flagged = open(A, B, true);
    expect(flagged.ok).toBe(false);
    if (!flagged.ok) expect(flagged.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
    expect(relayCount()).toBe(before);
  });

  it('counts per requesting session, whoever it asks', () => {
    roundTrips(MAX_RELAY_ROUNDS, [B, C]);

    const result = open(A, C);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
  });

  it('starts again from zero once a person types', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    humanTypesOnA();

    expect(countConsecutiveReplyRounds(db, A)).toBe(0);
    expect(open(A, B).ok).toBe(true);
  });

  it('does not count echoes', () => {
    for (let i = 0; i < MAX_RELAY_ROUNDS - 1; i += 1) deliverReply(mustOpen(A, B), { echo: true });

    expect(countConsecutiveReplyRounds(db, A)).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, B).ok).toBe(true);
  });

  it('neither counts nor resets on an expiry notice', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);
    const expiring = mustOpen(A, C);
    markRelayExpired(db, expiring.id, tick());
    rowOnA('[from Copilot / wt-c] did not answer in time', tick(), { messageType: 'relay' });

    expect(countConsecutiveReplyRounds(db, A)).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, B).ok).toBe(true);
  });

  it('does not count a cancelled relay', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);
    const cancelled = mustOpen(A, C);
    expect(withdrawRelay(db, cancelled.id, tick()).ok).toBe(true);

    expect(countConsecutiveReplyRounds(db, A)).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, C).ok).toBe(true);
  });

  it('stops counting at a reply row it cannot decide, without adding or resetting', () => {
    roundTrips(3);
    rowOnA('[from Ghost / wt-b] gone', tick(), {
      messageType: 'relay',
      requestId: relayRequestId('a-relay-that-never-existed'),
    });
    roundTrips(MAX_RELAY_ROUNDS);

    // The ten newer replies are counted; the three behind the ghost are not.
    expect(countConsecutiveReplyRounds(db, A)).toBe(MAX_RELAY_ROUNDS);
    expect(open(A, B).ok).toBe(false);
  });

  it('stops counting at a request row (A is its `to`)', () => {
    roundTrips(3);
    seedRequestFromX(1);
    deliverReply(mustOpen(A, B, true));
    deliverReply(mustOpen(A, B, true));

    expect(countConsecutiveReplyRounds(db, A)).toBe(2);
  });

  it('reads a history of nothing but notices to its start: zero replies, the next relay goes (I10)', () => {
    // #4420 fix1: this used to be refused as "at the limit" because the read
    // window filled up. I10 reads to a settled end (here, the start of the
    // history), so sixty notices are sixty notices and zero replies.
    for (let i = 0; i < 60; i += 1) seedNotice(i);

    expect(countConsecutiveReplyRounds(db, A)).toBe(0);
    expect(open(A, B).ok).toBe(true);
  });

  it('is scoped to the instance', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    const sibling = { worktreeId: 'wt-a', instanceId: 'claude-2' };

    expect(countConsecutiveReplyRounds(db, sibling)).toBe(0);
  });

  it('leaves A\'s history as the delivery wrote it (sanity of the fixture)', () => {
    roundTrips(2);
    const users = getMessages(db, 'wt-a', { limit: 50, cliToolId: 'claude', instanceId: 'claude' })
      .filter((m) => m.role === 'user');
    expect(users.map((m) => m.messageType)).toEqual(['relay', 'relay']);
  });
});

describe('#4420 I10: count and parent are read to a settled end, not to a window edge', () => {
  // The fc01e3bd0 window was 45 user turns (5 + 4 × MAX_RELAY_ROUNDS); the
  // 44 / 45 / 46 cases straddle that old edge on purpose.
  it.each([44, 45, 46])('lets the next relay through after %i notices and nothing else', (n) => {
    for (let i = 0; i < n; i += 1) seedNotice(i);

    expect(countConsecutiveReplyRounds(db, A)).toBe(0);
    expect(open(A, B).ok).toBe(true);
  });

  it('lets it through after 3 replies and 40 notices', () => {
    roundTrips(3);
    for (let i = 0; i < 40; i += 1) seedNotice(i);

    expect(countConsecutiveReplyRounds(db, A)).toBe(3);
    expect(open(A, B).ok).toBe(true);
  });

  it('lets it through after 3 replies and 45 notices (past the old edge)', () => {
    roundTrips(3);
    for (let i = 0; i < 45; i += 1) seedNotice(i);

    expect(countConsecutiveReplyRounds(db, A)).toBe(3);
    expect(open(A, B).ok).toBe(true);
  });

  it('lets it through when the history ends after exactly 45 rows (3 replies + 42 notices)', () => {
    roundTrips(3);
    for (let i = 0; i < 42; i += 1) seedNotice(i);

    expect(countConsecutiveReplyRounds(db, A)).toBe(3);
    expect(open(A, B).ok).toBe(true);
  });

  // 44 splits the echo from its notice at the old 45-turn edge; 31 and 63 at
  // the edges of the current reads (32, then 64 turns).
  it.each([31, 44, 63])('refuses after 10 replies, a notice, its echo and %i notices (the echo split from its row at a read edge)', (notices) => {
    roundTrips(MAX_RELAY_ROUNDS);
    const at = tick();
    const body = seedNotice(-1, at);
    seedEcho(body, at + ECHO_DELAY_MS);
    for (let i = 0; i < notices; i += 1) seedNotice(i);

    expect(countConsecutiveReplyRounds(db, A)).toBe(MAX_RELAY_ROUNDS);
    const result = open(A, B);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
      expect(result.refusal.message).toMatch(/in a row/);
    }
  });

  it('keeps the parent found behind a split echo and many notices (no parent lost at an edge)', () => {
    const ab = mustOpen(A, B);
    seedRequestFromX(2);
    deliverReply(ab);
    const at = tick();
    seedEcho(seedNotice(-1, at), at + ECHO_DELAY_MS);
    for (let i = 0; i < 44; i += 1) seedNotice(i);

    // A notice in front of the parent answers "no parent" (I4, unchanged), so
    // the guarantee here is the count: one reply, found behind 46 rows.
    expect(countConsecutiveReplyRounds(db, A)).toBe(1);
  });

  it.each([
    ['reply, notice, echo', ['reply', 'notice', 'echo']],
    ['echo, reply, notice', ['echo', 'reply', 'notice']],
    ['notice, echo, reply', ['notice', 'echo', 'reply']],
  ])('counts the 10th reply whatever the insertion order of a same-millisecond reply, notice and echo (%s)', (_label, order) => {
    roundTrips(MAX_RELAY_ROUNDS - 1);
    const last = mustOpen(A, B);
    const at = tick();
    const replyBody = '[from Codex / wt-b] the tenth answer';
    const write = {
      reply: () => rowOnA(replyBody, at, { messageType: 'relay', requestId: relayRequestId(last.id) }),
      notice: () => rowOnA('[from Copilot / wt-c] waiting at the same instant', at, { messageType: 'relay' }),
      echo: () => rowOnA(replyBody, at, { requestId: 'claude-prompt:tie' }),
    };
    for (const kind of order as Array<keyof typeof write>) write[kind]();
    markRelayDelivered(db, last.id, relayRequestId(last.id), at);

    expect(countConsecutiveReplyRounds(db, A)).toBe(MAX_RELAY_ROUNDS);
    const result = open(A, B);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
  });

  it.each([
    [MAX_RELAY_ROUNDS - 1, true],
    [MAX_RELAY_ROUNDS, false],
  ])('reads past turns with many assistant rows (%i replies → allowed: %s)', (replies, allowed) => {
    for (let i = 0; i < replies; i += 1) {
      deliverReply(mustOpen(A, B));
      for (let j = 0; j < 60; j += 1) {
        createMessage(db, {
          worktreeId: 'wt-a',
          role: 'assistant',
          content: `step ${i}.${j}`,
          messageType: 'normal',
          timestamp: new Date(tick(1)),
          cliToolId: 'claude',
          instanceId: 'claude',
        });
      }
      for (let k = 0; k < 5; k += 1) seedNotice(i * 10 + k);
    }

    expect(countConsecutiveReplyRounds(db, A)).toBe(replies);
    expect(open(A, B).ok).toBe(allowed);
  });

  it(`stops at MAX_RELAY_LINEAGE_ROWS and refuses, saying how many replies it could confirm`, () => {
    roundTrips(2);
    for (let i = 0; i < MAX_RELAY_LINEAGE_ROWS + 20; i += 1) seedNotice(i);

    const lineage = scanRelayLineage(db, A);
    expect(lineage.truncated).toBe(true);
    expect(lineage.replyRounds).toBe(0);

    const result = open(A, B, true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
      expect(result.refusal.message).toContain(`${MAX_RELAY_LINEAGE_ROWS}`);
      expect(result.refusal.message).toMatch(/0 replies/);
      expect(result.refusal.message).not.toMatch(/in a row, each right after a reply/);
    }
  });

  it('reads a history of just under MAX_RELAY_LINEAGE_ROWS to its start and lets it through', () => {
    roundTrips(2);
    for (let i = 0; i < MAX_RELAY_LINEAGE_ROWS - 10; i += 1) seedNotice(i);

    const lineage = scanRelayLineage(db, A);
    expect(lineage.truncated).toBe(false);
    expect(lineage.replyRounds).toBe(2);
    expect(open(A, B).ok).toBe(true);
  });
});

describe('#4420 decideRelayCreation with replyRounds (pure)', () => {
  const base = { from: A, to: B, parentHops: null, allowRelayChain: false, openBetween: 0 };

  it('behaves as before without replyRounds', () => {
    expect(decideRelayCreation(base)).toEqual({ ok: true, hops: 1 });
  });

  it('lets replyRounds below the limit through', () => {
    expect(decideRelayCreation({ ...base, replyRounds: MAX_RELAY_ROUNDS - 1 })).toEqual({
      ok: true,
      hops: 1,
    });
  });

  it('refuses at the limit with RELAY_HOPS_EXCEEDED, and the flag does not lift it', () => {
    for (const allowRelayChain of [false, true]) {
      const verdict = decideRelayCreation({ ...base, allowRelayChain, replyRounds: MAX_RELAY_ROUNDS });
      expect('code' in verdict && verdict.code).toBe('RELAY_HOPS_EXCEEDED');
    }
  });

  it('refuses a truncated read below the limit with its own sentence (I10)', () => {
    const verdict = decideRelayCreation({ ...base, replyRounds: 3, historyTruncated: true });
    expect('code' in verdict && verdict.code).toBe('RELAY_HOPS_EXCEEDED');
    expect('message' in verdict && verdict.message).toMatch(/3 replies/);
    expect('message' in verdict && verdict.message).toContain(`${MAX_RELAY_LINEAGE_ROWS}`);
  });

  it('asks the chain rule first and the duplicate rule after', () => {
    const chain = decideRelayCreation({ ...base, parentHops: 1, replyRounds: MAX_RELAY_ROUNDS });
    expect('code' in chain && chain.code).toBe('RELAY_CHAIN_BLOCKED');

    const dup = decideRelayCreation({ ...base, openBetween: 1, replyRounds: MAX_RELAY_ROUNDS });
    expect('code' in dup && dup.code).toBe('RELAY_HOPS_EXCEEDED');
  });
});
