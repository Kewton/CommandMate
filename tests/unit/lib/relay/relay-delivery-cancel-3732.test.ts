/**
 * A cancel that answered success must not be followed by a delivery (Issue #3732).
 *
 * `deliverOne` used to send the body the pump LISTED, after awaiting the
 * readiness check and without reading the row again — so a relay withdrawn
 * during that await, or during an earlier relay's send, was still typed into the
 * requester's composer, and an expiry notice stashed in between was sent over by
 * the stale reply and then wiped. Each case below parks the delivery on a
 * deferred promise at the await in question, does the competing thing, and
 * releases it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  clearRelayPending,
  createRelay,
  getRelayById,
  listRelaysWithPendingPayload,
  stashRelayPayload,
} from '@/lib/db/relay-db';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const C = { worktreeId: 'wt-c', instanceId: 'gemini' };

let db: Database.Database;

const sendUserMessage = vi.fn();
const findRelayHoldReason = vi.fn();

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({
  findRelayHoldReason: (...args: unknown[]) => findRelayHoldReason(...args),
}));

const { pumpRelayDeliveries, resetRelayDeliveryState, sweepExpiredRelays } = await import(
  '@/lib/relay/relay-delivery'
);
const { withdrawRelay } = await import('@/lib/relay/relay-service');

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let the pump run up to its next pending await. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function relaySystemLines(relayId: string): string[] {
  const rows = db
    .prepare(`SELECT request_id FROM chat_messages WHERE request_id LIKE ?`)
    .all(`relay-sys:${relayId}:%`) as Array<{ request_id: string }>;
  return rows.map((row) => row.request_id);
}

const SENT_OK = { ok: true, message: { id: 'm1' } };

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  insertWorktree('wt-c', 'gemini');

  resetRelayDeliveryState();
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue(SENT_OK);
  findRelayHoldReason.mockReset();
  findRelayHoldReason.mockResolvedValue(null);
});

afterEach(() => {
  resetRelayDeliveryState();
  db.close();
});

describe('a cancel that succeeded is honoured (Issue #3732)', () => {
  it('does not send when the relay is withdrawn while the readiness check is pending', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] done', NOW);
    const hold = deferred<string | null>();
    findRelayHoldReason.mockReturnValueOnce(hold.promise);

    const pump = pumpRelayDeliveries();
    await flush();
    const withdrawn = withdrawRelay(db, relay.id, NOW + 1);
    hold.resolve(null);
    await pump;

    expect(withdrawn.ok).toBe(true);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.state).toBe('cancelled');
    expect(relaySystemLines(relay.id).filter((id) => /:(replied|waiting)$/.test(id))).toEqual([]);
  });

  it('does not send a prompt notice for a relay withdrawn while the check is pending', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    stashRelayPayload(db, relay.id, 'prompt', '[from Codex] waiting on a dialog', NOW);
    const hold = deferred<string | null>();
    findRelayHoldReason.mockReturnValueOnce(hold.promise);

    const pump = pumpRelayDeliveries();
    await flush();
    expect(withdrawRelay(db, relay.id, NOW + 1).ok).toBe(true);
    hold.resolve(null);
    await pump;

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(relaySystemLines(relay.id).filter((id) => id.endsWith(':waiting'))).toEqual([]);
  });

  it('does not send the second relay when it is withdrawn while the first is being sent', async () => {
    const first = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    const second = createRelay(db, { from: A, to: C, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    stashRelayPayload(db, first.id, 'reply', '[from Codex] first', NOW);
    stashRelayPayload(db, second.id, 'reply', '[from Gemini] second', NOW + 1);
    const send = deferred<typeof SENT_OK>();
    sendUserMessage.mockReturnValueOnce(send.promise);

    const pump = pumpRelayDeliveries();
    await flush();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const withdrawn = withdrawRelay(db, second.id, NOW + 2);
    send.resolve(SENT_OK);
    await pump;

    expect(withdrawn.ok).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(String(sendUserMessage.mock.calls[0][1].content)).toContain('first');
    expect(getRelayById(db, first.id)?.state).toBe('delivered');
    expect(getRelayById(db, second.id)?.state).toBe('cancelled');
  });

  it('does not send a stale reply over an expiry notice stashed after the listing', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + 10, now: NOW });
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] too late', NOW);
    const hold = deferred<string | null>();
    findRelayHoldReason.mockReturnValueOnce(hold.promise);

    const pump = pumpRelayDeliveries();
    await flush();
    expect(sweepExpiredRelays(db, NOW + 20)).toBe(1);
    hold.resolve(null);
    await pump;

    expect(sendUserMessage).not.toHaveBeenCalled();
    const pending = listRelaysWithPendingPayload(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('expired');

    // The notice itself still goes out on the next pass.
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(String(sendUserMessage.mock.calls[0][1].content)).not.toContain('too late');
    expect(listRelaysWithPendingPayload(db)).toHaveLength(0);
  });
});

describe('a cancel during the send itself (Issue #3732)', () => {
  it('answers delivering, and the delivery completes and is recorded', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] done', NOW);
    const send = deferred<typeof SENT_OK>();
    sendUserMessage.mockReturnValueOnce(send.promise);

    const pump = pumpRelayDeliveries();
    await flush();
    const during = withdrawRelay(db, relay.id, NOW + 1);
    send.resolve(SENT_OK);
    await pump;

    expect(during).toMatchObject({ ok: false, reason: 'delivering' });
    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
    expect(relaySystemLines(relay.id).some((id) => id.endsWith(':replied'))).toBe(true);
    // Once delivered, the honest answer is "already closed".
    expect(withdrawRelay(db, relay.id, NOW + 2)).toMatchObject({
      ok: false,
      reason: 'already_closed',
    });
  });

  it('does not expire a relay whose reply is being sent', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + 10, now: NOW });
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] just in time', NOW);
    const send = deferred<typeof SENT_OK>();
    sendUserMessage.mockReturnValueOnce(send.promise);

    const pump = pumpRelayDeliveries();
    await flush();
    expect(sweepExpiredRelays(db, NOW + 20)).toBe(0);
    send.resolve(SENT_OK);
    await pump;

    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
    expect(relaySystemLines(relay.id).some((id) => id.endsWith(':expired'))).toBe(false);
    expect(sweepExpiredRelays(db, NOW + 20)).toBe(0);
  });

  it('releases the claim after a prompt notice, which leaves the relay open', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    stashRelayPayload(db, relay.id, 'prompt', '[from Codex] waiting on a dialog', NOW);
    const send = deferred<typeof SENT_OK>();
    sendUserMessage.mockReturnValueOnce(send.promise);

    const pump = pumpRelayDeliveries();
    await flush();
    expect(withdrawRelay(db, relay.id, NOW + 1)).toMatchObject({ ok: false, reason: 'delivering' });
    send.resolve(SENT_OK);
    await pump;

    expect(withdrawRelay(db, relay.id, NOW + 2).ok).toBe(true);
  });
});

describe('what is unchanged (Issue #3732)', () => {
  it('delivers an expiry notice whether or not a cancel was attempted', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW - 1, now: NOW - 10 });
    sweepExpiredRelays(db, NOW);

    expect(withdrawRelay(db, relay.id, NOW + 1)).toMatchObject({
      ok: false,
      reason: 'already_closed',
    });
    await pumpRelayDeliveries();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relay.id)?.state).toBe('expired');
  });

  it('releases the claim when the send is held on prompt_waiting, so a cancel succeeds', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] done', NOW);
    sendUserMessage.mockResolvedValueOnce({ ok: false, stage: 'prompt_waiting', error: 'x' });

    await pumpRelayDeliveries();

    expect(withdrawRelay(db, relay.id, NOW + 1).ok).toBe(true);
    expect(getRelayById(db, relay.id)?.state).toBe('cancelled');
  });

  it('releases the claim when the send fails, so a cancel succeeds', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] done', NOW);
    sendUserMessage.mockResolvedValueOnce({ ok: false, stage: 'session', error: 'gone' });

    await pumpRelayDeliveries();

    expect(withdrawRelay(db, relay.id, NOW + 1).ok).toBe(true);
  });

  it('releases the claim when the send throws, so a cancel succeeds', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] done', NOW);
    sendUserMessage.mockRejectedValueOnce(new Error('boom'));

    await pumpRelayDeliveries();

    expect(withdrawRelay(db, relay.id, NOW + 1).ok).toBe(true);
  });
});

describe('a payload whose body alone changed meanwhile (Issue #3749)', () => {
  it('does not send the listed body, and the next pass sends the new one', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] first draft', NOW);
    const hold = deferred<string | null>();
    findRelayHoldReason.mockReturnValueOnce(hold.promise);

    const pump = pumpRelayDeliveries();
    await flush();
    // Same kind, same relay, different body: only the body comparison tells
    // the listed payload from the one the row carries now.
    clearRelayPending(db, relay.id, NOW + 1);
    expect(stashRelayPayload(db, relay.id, 'reply', '[from Codex] final answer', NOW + 2)).toBe(true);
    hold.resolve(null);
    await pump;

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.state).toBe('pending');

    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(String(sendUserMessage.mock.calls[0][1].content)).toContain('final answer');
    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
  });
});
