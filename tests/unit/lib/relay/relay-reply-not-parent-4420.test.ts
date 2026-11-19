/**
 * Issue #4420: the reply to a relay this session opened is not the parent of the
 * next relay it opens — and the pace of such round trips is capped from the
 * ledger instead (案 Q, docs/design/relay-rounds-window-4420.md §2): a session
 * that received `MAX_RELAY_ROUNDS` replies to its own relays within
 * `RELAY_ROUNDS_WINDOW_MS` may not open another until the oldest ages out.
 *
 * Rows are written the way production writes them: `relay-delivery` puts the
 * reply into the REQUESTER's history (`messageType: 'relay'`, keyed
 * `relay:<id>`, body from `buildRelayReplyMessage`) and closes the relay
 * `delivered` at that moment. The "request" row — a relay row naming a relay
 * this session is the `to` of — is the shape the #2377 / #2387 suites seed by
 * hand; production writes none today (design D1), but the parent lookup keeps
 * reading it, so it is seeded here the same way. The suite that builds the
 * reply and its echo through the real `deliverOne` is
 * `tests/integration/relay-reply-rounds-delivery-4420.test.ts`.
 *
 * Parent (relay-reply-not-parent-4420.md): I1 a reply row is not a parent;
 * I2 it does not hide the real parent within the five-turn window; I3 a human
 * row still ends the chain; I4 a row that cannot be decided is treated as
 * before; I8 an echo is compared with the relay row right behind it only.
 * Pace (relay-rounds-window-4420.md §2.1, §2.3, §2.4): one COUNT over the
 * ledger; nothing in the history is read.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ info: [] as Array<{ module: string; action: string; data: unknown }> }));

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    createLogger: (module: string) => {
      const real = actual.createLogger(module);
      return {
        ...real,
        info: (action: string, data?: Record<string, unknown>) => {
          logged.info.push({ module, action, data });
          real.info(action, data);
        },
      };
    },
  };
});

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
import {
  claimRelayPayloadDelivery,
  getRelayById,
  getRelayPendingPayload,
  holdRelayPayloadDelivery,
  markRelayDelivered,
  markRelayExpired,
  stashRelayPayload,
} from '@/lib/db/relay-db';
import { recordUserTurn } from '@/lib/history/user-turn-recorder';
import { buildRelayReplyMessage } from '@/lib/relay/relay-messages';
import {
  countRecentReplyRounds,
  findParentRelayHops,
  openRelay,
  resolveRelayHold,
  withdrawRelay,
  type OpenRelayResult,
} from '@/lib/relay/relay-service';
import {
  decideRelayCreation,
  MAX_RELAY_HOPS,
  MAX_RELAY_ROUNDS,
  RELAY_ROUNDS_WINDOW_MS,
} from '@/lib/relay/relay-policy';
import type { RelayEndpoint, SessionRelay } from '@/lib/relay/types';

const NOW = Date.parse('2026-11-19T03:00:00.000Z');
const ECHO_DELAY_MS = 662;
const MINUTE = 60_000;

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

function humanTypesOnA(text = 'a person typed this', atMs = tick()): void {
  rowOnA(text, atMs);
}

/** A's own relays, opened and answered `n` times, one per `gapMs`. */
function roundTrips(n: number, targets: RelayEndpoint[] = [B], gapMs = 1_000): void {
  for (let i = 0; i < n; i += 1) {
    const relay = mustOpen(A, targets[i % targets.length]);
    deliverReply(relay, { atMs: tick(gapMs) });
  }
}

/** A relay A opened to `to`, whose reply is stashed and taken for delivery (`attempting`). */
function replyAttempting(to: RelayEndpoint): { relay: SessionRelay; payloadId: string; attemptId: string } {
  const relay = mustOpen(A, to);
  expect(stashRelayPayload(db, relay.id, 'reply', `[from ${to.instanceId}] answer`, tick())).toBe(true);
  const attemptId = `attempt-${relay.id}`;
  const payloadId = claimRelayPayloadDelivery(db, {
    relayId: relay.id,
    payloadId: getRelayPendingPayload(db, relay.id)?.payloadId ?? null,
    kind: 'reply',
    body: `[from ${to.instanceId}] answer`,
    attemptId,
    owner: 'boot-4420',
    mintPayloadId: `payload-${relay.id}`,
    now: tick(),
  });
  if (payloadId === null) throw new Error('setup: claim');
  return { relay, payloadId, attemptId };
}

/** The same, held `uncertain` (the send may have reached A). */
function replyUncertain(to: RelayEndpoint): { relay: SessionRelay; payloadId: string; attemptId: string } {
  const taken = replyAttempting(to);
  expect(
    holdRelayPayloadDelivery(db, {
      relayId: taken.relay.id,
      payloadId: taken.payloadId,
      attemptId: taken.attemptId,
      reason: 'submit-unconfirmed',
      now: tick(),
    })
  ).toBe(true);
  return taken;
}

function rounds(endpoint: RelayEndpoint = A): number {
  return countRecentReplyRounds(db, endpoint, clock).count;
}

function relayCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM session_relays').get() as { n: number }).n;
}

function expectRoundsRefusal(result: OpenRelayResult): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
  expect(result.refusal.message).toContain(`the limit is ${MAX_RELAY_ROUNDS}`);
  expect(result.refusal.message).not.toMatch(/Relay chains stop at/);
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
  logged.info.length = 0;
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

describe('#4420 a parent behind more than the five-turn window is not seen (known limit Q-4)', () => {
  it('answers null once replies and echoes fill the five turns in front of the parent (fail-open, as develop)', () => {
    seedRequestFromX(2);
    const relays = [B, C, D].map((to) => mustOpen(A, to, true));
    for (const relay of relays) deliverReply(relay, { echo: true });

    // Six user rows in front of the parent: the window of five turns ends there.
    expect(findParentRelayHops(db, A)).toBeNull();
  });

  it('still sees it with two replies and their echoes in front (four rows)', () => {
    seedRequestFromX(2);
    const relays = [B, C].map((to) => mustOpen(A, to, true));
    for (const relay of relays) deliverReply(relay, { echo: true });

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
  });

  it('known limit (#2387 rule, unchanged): a person retyping the reply\'s exact body reads as its echo', () => {
    seedRequestFromX(2);
    const body = deliverReply(mustOpen(A, B, true));
    rowOnA(body, tick(30_000)); // unkeyed, as `/send` writes it

    expect(findParentRelayHops(db, A)).toBe(2);
  });

  it('a person typing anything else ends the chain', () => {
    seedRequestFromX(2);
    deliverReply(mustOpen(A, B, true));
    humanTypesOnA('a different body');

    expect(findParentRelayHops(db, A)).toBeNull();
  });
});

describe('#4420 round trips: replies within the window, capped at MAX_RELAY_ROUNDS (案 Q §2.1)', () => {
  it('lets the request after MAX_RELAY_ROUNDS - 1 replies through', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);

    expect(rounds()).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, B).ok).toBe(true);
  });

  it('refuses the request after MAX_RELAY_ROUNDS replies with RELAY_HOPS_EXCEEDED, flag or not, and opens nothing', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    const before = relayCount();

    expectRoundsRefusal(open(A, B));
    expectRoundsRefusal(open(A, B, true));
    expect(relayCount()).toBe(before);
  });

  it('says how many replies, over what window, and that waiting clears it', () => {
    roundTrips(MAX_RELAY_ROUNDS);

    const result = open(A, B);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.message).toBe(
      `This session received ${MAX_RELAY_ROUNDS} replies to its relays in the last `
      + `${RELAY_ROUNDS_WINDOW_MS / MINUTE} minutes; the limit is ${MAX_RELAY_ROUNDS}. `
      + 'Wait before opening another (the count clears as replies age out).'
    );
  });

  it('counts per requesting session, whoever it asks', () => {
    roundTrips(MAX_RELAY_ROUNDS, [B, C]);

    expectRoundsRefusal(open(A, D));
  });

  it('does not count a reply that left the window (W + 1 ms before), and counts one exactly W before', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    const oldest = countRecentReplyRounds(db, A, clock).oldestAt;
    if (oldest === null) throw new Error('setup');

    expect(countRecentReplyRounds(db, A, oldest + RELAY_ROUNDS_WINDOW_MS).count).toBe(MAX_RELAY_ROUNDS);
    expect(countRecentReplyRounds(db, A, oldest + RELAY_ROUNDS_WINDOW_MS + 1).count).toBe(MAX_RELAY_ROUNDS - 1);
  });

  it('does not count ten old replies at all once the window has passed them', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    tick(RELAY_ROUNDS_WINDOW_MS + 1);

    expect(rounds()).toBe(0);
    expect(open(A, B).ok).toBe(true);
  });

  it('opens again once the oldest reply ages out, and not a millisecond before', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    const oldest = countRecentReplyRounds(db, A, clock).oldestAt;
    if (oldest === null) throw new Error('setup');

    expectRoundsRefusal(openRelay(db, { from: A, to: B, now: oldest + RELAY_ROUNDS_WINDOW_MS }));
    expect(openRelay(db, { from: A, to: B, now: oldest + RELAY_ROUNDS_WINDOW_MS + 1 }).ok).toBe(true);
  });

  it('does not reset when a person types (known limit Q-3: nothing in the history is read)', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    humanTypesOnA();

    expect(rounds()).toBe(MAX_RELAY_ROUNDS);
    expectRoundsRefusal(open(A, B));
  });

  it('does not count echoes, notices or other rows in the history — only the ledger', () => {
    for (let i = 0; i < MAX_RELAY_ROUNDS - 1; i += 1) deliverReply(mustOpen(A, B), { echo: true });
    for (let i = 0; i < 60; i += 1) rowOnA(`[from Codex / wt-b] waiting ${i}`, tick(), { messageType: 'relay' });

    expect(rounds()).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, B).ok).toBe(true);
  });

  it('does not count an expired relay', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);
    const expiring = mustOpen(A, C);
    markRelayExpired(db, expiring.id, tick());

    expect(rounds()).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, B).ok).toBe(true);
  });

  it('does not count a cancelled relay', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);
    const cancelled = mustOpen(A, C);
    expect(withdrawRelay(db, cancelled.id, tick()).ok).toBe(true);

    expect(rounds()).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, C).ok).toBe(true);
  });

  it('counts a reply whose delivery is held uncertain, from when it was held', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);
    const held = replyUncertain(C);

    expect(rounds()).toBe(MAX_RELAY_ROUNDS);
    expect(getRelayById(db, held.relay.id)?.deliveryHold?.state).toBe('uncertain');
    expectRoundsRefusal(open(A, B));
  });

  it('does not count another instance of the same worktree', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    const sibling = { worktreeId: 'wt-a', instanceId: 'claude-2' };

    expect(rounds(sibling)).toBe(0);
    expect(openRelay(db, { from: sibling, to: B, now: tick() }).ok).toBe(true);
  });

  it('does not count the same instance id in another worktree', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    const elsewhere = { worktreeId: 'wt-x', instanceId: 'claude' };

    expect(rounds(elsewhere)).toBe(0);
    expect(openRelay(db, { from: elsewhere, to: B, now: tick() }).ok).toBe(true);
  });

  it('does not count replies to relays others opened to A', () => {
    for (let i = 0; i < MAX_RELAY_ROUNDS; i += 1) {
      const relay = openRelay(db, { from: B, to: A, now: tick() });
      if (!relay.ok) throw new Error('setup');
      markRelayDelivered(db, relay.relay.id, relayRequestId(relay.relay.id), tick());
    }

    expect(rounds(A)).toBe(0);
    expect(rounds(B)).toBe(MAX_RELAY_ROUNDS);
  });

  it('logs every refusal on the pace as relay-rounds-refused, with the session, n and the oldest and newest reply', () => {
    roundTrips(MAX_RELAY_ROUNDS);
    const { oldestAt, newestAt } = countRecentReplyRounds(db, A, clock);
    logged.info.length = 0;

    open(A, B);
    open(A, B, true);

    const refusals = logged.info.filter((entry) => entry.action === 'relay-rounds-refused');
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toEqual({
      module: 'relay-service',
      action: 'relay-rounds-refused',
      data: {
        session: 'wt-a/claude',
        n: MAX_RELAY_ROUNDS,
        oldestReplyAt: new Date(oldestAt as number).toISOString(),
        newestReplyAt: new Date(newestAt as number).toISOString(),
      },
    });
  });

  it('does not log relay-rounds-refused for a depth refusal', () => {
    seedRequestFromX(MAX_RELAY_HOPS);
    logged.info.length = 0;

    const result = open(A, B, true);
    expect(result.ok).toBe(false);
    expect(logged.info.filter((entry) => entry.action === 'relay-rounds-refused')).toHaveLength(0);
  });

  it('is read synchronously, in one call (#4466: openRelay stays one synchronous stretch)', () => {
    roundTrips(2);
    const answer = countRecentReplyRounds(db, A, clock);

    expect(answer).not.toBeInstanceOf(Promise);
    expect(answer.count).toBe(2);
  });

  it('leaves A\'s history as the delivery wrote it (sanity of the fixture)', () => {
    roundTrips(2);
    const users = getMessages(db, 'wt-a', { limit: 50, cliToolId: 'claude', instanceId: 'claude' })
      .filter((m) => m.role === 'user');
    expect(users.map((m) => m.messageType)).toEqual(['relay', 'relay']);
  });
});

describe('#4420 known limits pinned in the direction chosen (案 Q §2.3)', () => {
  it('Q-7: a reply still being typed (attempting) is not counted — 9 delivered + 1 attempting goes through', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);
    const taken = replyAttempting(C);

    expect(getRelayById(db, taken.relay.id)?.deliveryHold?.state).toBe('attempting');
    expect(rounds()).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, B).ok).toBe(true);
  });

  it('Q-8: a held reply a person discards stops counting', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);
    const held = replyUncertain(C);
    expect(rounds()).toBe(MAX_RELAY_ROUNDS);

    const resolved = resolveRelayHold(db, {
      relayId: held.relay.id,
      payloadId: held.payloadId,
      attemptId: held.attemptId,
      action: 'discard',
      now: tick(),
    });
    expect(resolved.ok).toBe(true);

    expect(rounds()).toBe(MAX_RELAY_ROUNDS - 1);
    expect(open(A, B).ok).toBe(true);
  });

  it('Q-9: a held reply a person confirms counts from the confirmation, not from the hold', () => {
    const held = replyUncertain(C);
    const heldAt = clock;
    const confirmAt = tick(20 * MINUTE);
    const resolved = resolveRelayHold(db, {
      relayId: held.relay.id,
      payloadId: held.payloadId,
      attemptId: held.attemptId,
      action: 'confirm',
      now: confirmAt,
    });
    expect(resolved.ok).toBe(true);
    expect(getRelayById(db, held.relay.id)?.deliveredAt).toBe(confirmAt);

    // Past the window of the hold, inside the window of the confirmation.
    expect(countRecentReplyRounds(db, A, heldAt + RELAY_ROUNDS_WINDOW_MS + 1).count).toBe(1);
    expect(countRecentReplyRounds(db, A, confirmAt + RELAY_ROUNDS_WINDOW_MS + 1).count).toBe(0);
  });

  it('Q-10: at nine, relays opened side by side to two peers both go (the count is of replies, not of opens)', () => {
    roundTrips(MAX_RELAY_ROUNDS - 1);

    expect(open(A, C).ok).toBe(true);
    expect(open(A, D).ok).toBe(true);
  });

  it('Q-6: deleting the peer\'s worktree removes its relays, and their replies leave the count', () => {
    roundTrips(MAX_RELAY_ROUNDS, [B, C]);
    expect(rounds()).toBe(MAX_RELAY_ROUNDS);

    db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-c');

    expect(rounds()).toBe(MAX_RELAY_ROUNDS / 2);
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

  it('asks the chain rule first and the duplicate rule after', () => {
    const chain = decideRelayCreation({ ...base, parentHops: 1, replyRounds: MAX_RELAY_ROUNDS });
    expect('code' in chain && chain.code).toBe('RELAY_CHAIN_BLOCKED');

    const dup = decideRelayCreation({ ...base, openBetween: 1, replyRounds: MAX_RELAY_ROUNDS });
    expect('code' in dup && dup.code).toBe('RELAY_HOPS_EXCEEDED');
  });
});
