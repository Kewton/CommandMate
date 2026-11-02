/**
 * Issue #4082 (work item b): the requester is told about a hold, a closed
 * relay's waiting reply is kept by the sweep and discarded on settle, and the
 * held axis is counted.
 *
 * Positive controls fail on the implementation before this change (no `held`
 * line; the sweep emptied the second slot; no held count). Negative controls
 * pass before and after (a non-held sweep still supersedes the reply; a cancel
 * still empties it; `counts` keeps its five states).
 *
 * The database is a file under a fresh `fs.mkdtempSync(os.tmpdir())`
 * directory, removed in `afterEach`, so a "restart" reopens the same file.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, relaySystemRequestId, RELAY_SYSTEM_REQUEST_ID_PREFIX } from '@/lib/db/chat-db';
import { codexTurnRequestId } from '@/types/agent-transcript';
import {
  cancelRelay,
  countHeldRelays,
  countRelays,
  createRelay,
  getRelayBinding,
  getRelayById,
  getRelayPendingPayload,
  recoverInterruptedRelayDeliveryRefs,
  setRelayPendingReply,
  stashRelayPayload,
} from '@/lib/db/relay-db';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import { resolveRelayHold } from '@/lib/relay/relay-service';
import { findWorkerReply } from '@/lib/relay/relay-bound-reply';
import { replyCandidates } from '@/cli/utils/reply-ledger';
import type { RelayHoldAction } from '@/lib/relay/types';
import type { SendAttemptReason, SendAttemptState } from '@/lib/session/send-attempt-types';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

let dir: string;
let dbPath: string;
let db: Database.Database;

const sendUserMessage = vi.fn();
const findRelayHoldReason = vi.fn();
const broadcastMessage = vi.fn();

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: (...args: unknown[]) => broadcastMessage(...args) }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({
  findRelayHoldReason: (...args: unknown[]) => findRelayHoldReason(...args),
}));

const { pumpRelayDeliveries, resetRelayDeliveryState, runRelayMaintenanceTick, sweepExpiredRelays } =
  await import('@/lib/relay/relay-delivery');

type Attempt = { state: SendAttemptState; reason: SendAttemptReason };
type SendParams = { content: string; onAttempt?: (attempt: Attempt) => void };

function sendReporting(attempt: Attempt, result: unknown) {
  return async (_db: unknown, params: SendParams) => {
    params.onAttempt?.(attempt);
    return result;
  };
}

const OK = { ok: true, message: { id: 'm1' } };
const SEND_FAILED = { ok: false, stage: 'send', error: 'x' };
const INDETERMINATE: Attempt = { state: 'indeterminate', reason: 'submit-unconfirmed' };

function openDb(): Database.Database {
  const opened = new Database(dbPath);
  opened.pragma('foreign_keys = ON');
  runMigrations(opened);
  return opened;
}

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

function legacyRelay(expiresAt = NOW + DAY_MS, from = A, to = B) {
  return createRelay(db, { from, to, hops: 1, expiresAt, now: NOW });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function pumpRepeatedly(): Promise<void> {
  await pumpRelayDeliveries();
  await pumpRelayDeliveries();
  await runRelayMaintenanceTick();
  await pumpRelayDeliveries();
}

/** Every relay system row in `worktreeId`, oldest first. */
function systemRows(worktreeId = 'wt-a'): Array<{ request_id: string; content: string }> {
  return db
    .prepare(
      `SELECT request_id, content FROM chat_messages
       WHERE worktree_id = ? AND request_id LIKE ? ORDER BY timestamp ASC, rowid ASC`
    )
    .all(worktreeId, `${RELAY_SYSTEM_REQUEST_ID_PREFIX}%`) as Array<{ request_id: string; content: string }>;
}

const heldRows = (worktreeId = 'wt-a') => systemRows(worktreeId).filter((row) => row.request_id.includes(':held:'));

/** A relay with `kind` stashed, then held as uncertain by one pump. */
async function heldRelay(kind: 'reply' | 'prompt', expiresAt = NOW + DAY_MS) {
  const relay = legacyRelay(expiresAt);
  expect(stashRelayPayload(db, relay.id, kind, `[from Codex] ${kind} body`, NOW)).toBe(true);
  sendUserMessage.mockImplementationOnce(sendReporting(INDETERMINATE, SEND_FAILED));
  await pumpRelayDeliveries();
  const hold = getRelayById(db, relay.id)?.deliveryHold;
  expect(hold?.state).toBe('uncertain');
  return { relayId: relay.id, payloadId: hold?.payloadId as string, attemptId: hold?.attemptId as string };
}

function resolve(held: { relayId: string; payloadId: string; attemptId: string }, action: RelayHoldAction, now = NOW + 50) {
  return resolveRelayHold(db, { ...held, action, now });
}

const WAITING_REPLY = { candidateId: 'c1', body: '[from Codex] the final reply', overlap: 'none', basis: 'x', payloadId: 'reply-p2' };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-4082b-'));
  dbPath = path.join(dir, 'cm.db');
  db = openDb();
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  resetRelayDeliveryState();
  resetRelayServerBootId();
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue(OK);
  findRelayHoldReason.mockReset();
  findRelayHoldReason.mockResolvedValue(null);
  broadcastMessage.mockReset();
});

afterEach(() => {
  resetRelayDeliveryState();
  resetRelayServerBootId();
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the requester is told once per held attempt (Issue #4082)', () => {
  for (const kind of ['reply', 'prompt'] as const) {
    it(`${kind}: one held line in A's history, keyed on relay+payload+attempt, however often the pump runs`, async () => {
      const held = await heldRelay(kind);
      await pumpRepeatedly();

      const rows = heldRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].request_id).toBe(
        relaySystemRequestId(held.relayId, 'held', `${held.payloadId}:${held.attemptId}`)
      );
      expect(rows[0].request_id.startsWith('relay-sys:')).toBe(true);
      expect(rows[0].content).toContain(`relay=${held.relayId}`);
      expect(rows[0].content).toContain(`payload=${kind}:${held.payloadId}`);
      expect(rows[0].content).toContain(`attempt=${held.attemptId}`);
      expect(rows[0].content).toContain('reason=submit-unconfirmed');
      // Nothing is written into the worker's transcript.
      expect(heldRows('wt-b')).toEqual([]);
      // The frame follows the committed row.
      expect(broadcastMessage).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({ worktreeId: 'wt-a', message: expect.objectContaining({ requestId: rows[0].request_id }) })
      );
    });
  }

  it('a throw after the send is told the same way (send-threw / threw-after-sent)', async () => {
    const relay = legacyRelay();
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] reply', NOW);
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.onAttempt?.({ state: 'sent', reason: 'submitted' });
      throw new Error('boom');
    });
    await pumpRelayDeliveries();

    expect(heldRows()).toHaveLength(1);
    expect(heldRows()[0].content).toContain('reason=threw-after-sent');
  });

  it('a retry whose new attempt is held again is told again (a second line), and a different payload too', async () => {
    const first = await heldRelay('prompt');
    expect(resolve(first, 'retry').ok).toBe(true);
    sendUserMessage.mockImplementationOnce(sendReporting(INDETERMINATE, SEND_FAILED));
    await pumpRelayDeliveries();
    const second = getRelayById(db, first.relayId)?.deliveryHold;
    expect(second?.attemptId).not.toBe(first.attemptId);

    // Another relay's payload, held too.
    const other = await heldRelay('reply');

    const keys = heldRows().map((row) => row.request_id);
    expect(keys).toEqual([
      relaySystemRequestId(first.relayId, 'held', `${first.payloadId}:${first.attemptId}`),
      relaySystemRequestId(first.relayId, 'held', `${second?.payloadId}:${second?.attemptId}`),
      relaySystemRequestId(other.relayId, 'held', `${other.payloadId}:${other.attemptId}`),
    ]);
  });

  it('negative control: a delivered, a not-sent and a prompt_waiting send leave no held line', async () => {
    const delivered = legacyRelay();
    stashRelayPayload(db, delivered.id, 'reply', '[from Codex] ok', NOW);
    await pumpRelayDeliveries();
    const notSent = legacyRelay();
    stashRelayPayload(db, notSent.id, 'reply', '[from Codex] later', NOW);
    sendUserMessage.mockImplementationOnce(
      sendReporting({ state: 'not-sent', reason: 'prompt-not-ready' }, SEND_FAILED)
    );
    await pumpRelayDeliveries();

    expect(heldRows()).toEqual([]);
  });

  it('a hold that did not take (stale attempt) writes no line', async () => {
    const relay = legacyRelay();
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] reply', NOW);
    // The send settles the attempt underneath (as another boot's recovery would).
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      db.prepare("UPDATE session_relays SET delivery_state = 'uncertain', delivery_reason = 'other' WHERE id = ?").run(relay.id);
      params.onAttempt?.(INDETERMINATE);
      return SEND_FAILED;
    });
    await pumpRelayDeliveries();

    expect(getRelayById(db, relay.id)?.deliveryHold?.reason).toBe('other');
    expect(heldRows()).toEqual([]);
  });

  it('a failed line write (and a failed frame) never changes the hold', async () => {
    db.exec(`
      CREATE TRIGGER refuse_held_line BEFORE INSERT ON chat_messages
      WHEN NEW.request_id LIKE 'relay-sys:%:held:%'
      BEGIN SELECT RAISE(ABORT, 'refused'); END;
    `);
    const held = await heldRelay('reply');
    expect(heldRows()).toEqual([]);
    expect(getRelayById(db, held.relayId)?.deliveryHold).toMatchObject({ state: 'uncertain', attemptId: held.attemptId });
    // Not retried: dropping the trigger and pumping again writes nothing.
    db.exec('DROP TRIGGER refuse_held_line');
    await pumpRepeatedly();
    expect(heldRows()).toEqual([]);

    broadcastMessage.mockImplementation(() => {
      throw new Error('no socket');
    });
    const second = await heldRelay('prompt');
    expect(heldRows()).toHaveLength(1);
    expect(getRelayById(db, second.relayId)?.deliveryHold?.state).toBe('uncertain');
  });

  it('the held line is never read as a reply (relay delivery, CLI reply ledger)', async () => {
    // A is also a worker: C → A. Its newest row must not be the held line.
    await heldRelay('reply');
    const worker = { worktreeId: 'wt-a', cliToolId: 'claude' as const, instanceId: 'claude' };
    expect(findWorkerReply(db, worker, 0)).toBeNull();

    const [row] = heldRows();
    const candidates = replyCandidates(
      [{ role: 'assistant', messageType: 'normal', content: row.content, timestamp: new Date(NOW + 10).toISOString(), requestId: row.request_id } as never],
      0
    );
    expect(candidates).toEqual([]);
  });
});

describe('the restart recovery tells exactly the attempts it held (Issue #4082)', () => {
  async function crashMidSend(): Promise<void> {
    sendUserMessage.mockImplementationOnce(() => new Promise(() => {}));
    void pumpRelayDeliveries();
    await flush();
    db.close();
    resetRelayDeliveryState();
    resetRelayServerBootId();
    db = openDb();
  }

  it('one line per recovered attempt, and none on a second run', async () => {
    const relay = legacyRelay();
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] reply', NOW);
    await crashMidSend();

    await pumpRepeatedly();
    await runRelayMaintenanceTick();

    const hold = getRelayById(db, relay.id)?.deliveryHold;
    expect(hold?.reason).toBe('server-restarted');
    const rows = heldRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].request_id).toBe(relaySystemRequestId(relay.id, 'held', `${hold?.payloadId}:${hold?.attemptId}`));
    expect(rows[0].content).toContain('reason=server-restarted');
  });

  it('recoverInterruptedRelayDeliveryRefs answers only rows it moved: not this boot, not already uncertain', () => {
    const mine = legacyRelay();
    const theirs = legacyRelay();
    const settled = legacyRelay();
    for (const [relay, owner, state] of [
      [mine, 'boot-now', 'attempting'],
      [theirs, 'boot-old', 'attempting'],
      [settled, 'boot-old', 'uncertain'],
    ] as const) {
      stashRelayPayload(db, relay.id, 'reply', `[from Codex] ${relay.id}`, NOW);
      db.prepare(
        `UPDATE session_relays SET delivery_state = ?, delivery_attempt_id = ?, delivery_owner = ? WHERE id = ?`
      ).run(state, `att-${relay.id}`, owner, relay.id);
    }

    const refs = recoverInterruptedRelayDeliveryRefs(db, 'boot-now', NOW + 5);
    expect(refs.map((ref) => ref.relayId)).toEqual([theirs.id]);
    expect(refs[0].attemptId).toBe(`att-${theirs.id}`);
    expect(recoverInterruptedRelayDeliveryRefs(db, 'boot-now', NOW + 6)).toEqual([]);
    expect(getRelayById(db, mine.id)?.deliveryHold?.state).toBe('attempting');
  });
});

describe('expiry while held: the waiting reply is kept, then discarded on settle (Issue #4082)', () => {
  async function heldPromptWithWaitingReply(expiresAt = NOW + 10) {
    const held = await heldRelay('prompt', expiresAt);
    expect(setRelayPendingReply(db, held.relayId, WAITING_REPLY as never, NOW + 3)).toBe(true);
    return held;
  }

  it('the sweep closes the relay and keeps the reply behind the held notice', async () => {
    const held = await heldPromptWithWaitingReply();

    expect(sweepExpiredRelays(db, NOW + 20)).toBe(1);
    await pumpRepeatedly();

    expect(getRelayById(db, held.relayId)?.state).toBe('expired');
    expect(getRelayBinding(db, held.relayId)?.pendingReply?.payloadId).toBe('reply-p2');
    expect(getRelayPendingPayload(db, held.relayId)?.kind).toBe('prompt');
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  for (const action of ['confirm', 'discard'] as const) {
    it(`${action} on the closed notice drops the waiting reply too, tells A once, and sends nothing`, async () => {
      const held = await heldPromptWithWaitingReply();
      sweepExpiredRelays(db, NOW + 20);

      const result = resolve(held, action, NOW + 30);
      expect(result).toMatchObject({ ok: true, requeued: false, promoted: false, discardedReply: { payloadId: 'reply-p2' } });
      // Settling again is refused and writes no second line.
      expect(resolve(held, action, NOW + 31).ok).toBe(false);
      await pumpRepeatedly();

      expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'expired', deliveryHold: null });
      expect(getRelayBinding(db, held.relayId)?.pendingReply).toBeNull();
      expect(getRelayPendingPayload(db, held.relayId)).toBeNull();
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      const discarded = systemRows().filter((row) => row.request_id.includes(':reply-discarded'));
      expect(discarded).toHaveLength(1);
      expect(discarded[0].request_id).toBe(relaySystemRequestId(held.relayId, 'reply-discarded', 'reply-p2'));
      // The expiry is told by the existing line; no new expiry notice is queued.
      expect(systemRows().filter((row) => row.request_id.endsWith(':expired'))).toHaveLength(1);
    });
  }

  it('retry on the closed notice is refused and leaves the waiting reply where it was', async () => {
    const held = await heldPromptWithWaitingReply();
    sweepExpiredRelays(db, NOW + 20);

    expect(resolve(held, 'retry', NOW + 30)).toMatchObject({ ok: false, refusal: 'not_allowed' });
    expect(getRelayBinding(db, held.relayId)?.pendingReply?.payloadId).toBe('reply-p2');
  });

  it('resolve before the sweep (deadline not yet passed): the reply is promoted and delivered, as before', async () => {
    const held = await heldPromptWithWaitingReply(NOW + DAY_MS);

    expect(resolve(held, 'confirm', NOW + 30)).toMatchObject({ ok: true, promoted: true, discardedReply: null });
    await pumpRelayDeliveries();

    expect(getRelayById(db, held.relayId)?.state).toBe('delivered');
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
  });

  /** What either order leaves behind: closed, both slots empty, one expired line, no new notice. */
  async function expectSettledAsExpired(relayId: string, discardedLines: number): Promise<void> {
    await pumpRepeatedly();
    expect(getRelayById(db, relayId)).toMatchObject({ state: 'expired', deliveryHold: null });
    expect(getRelayPendingPayload(db, relayId)).toBeNull();
    expect(getRelayBinding(db, relayId)?.pendingReply).toBeNull();
    // Only the first (held) notice was ever typed: no expiry notice after the settle.
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(systemRows().filter((row) => row.request_id.endsWith(':expired'))).toHaveLength(1);
    expect(systemRows().filter((row) => row.request_id.includes(':reply-discarded'))).toHaveLength(discardedLines);
  }

  for (const action of ['confirm', 'discard'] as const) {
    it(`deadline passed but not yet swept: ${action} closes it as expired and drops the waiting reply, as sweep-then-${action} does`, async () => {
      const held = await heldPromptWithWaitingReply(NOW + 10);

      expect(resolve(held, action, NOW + 30)).toMatchObject({
        ok: true,
        promoted: false,
        expired: true,
        discardedReply: { payloadId: 'reply-p2' },
      });
      // The sweep that runs afterwards finds nothing open to expire.
      expect(sweepExpiredRelays(db, NOW + 40)).toBe(0);

      await expectSettledAsExpired(held.relayId, 1);
    });

    it(`sweep-then-${action} ends in the same place (order control)`, async () => {
      const held = await heldPromptWithWaitingReply(NOW + 10);
      expect(sweepExpiredRelays(db, NOW + 20)).toBe(1);

      expect(resolve(held, action, NOW + 30)).toMatchObject({ ok: true, expired: false, discardedReply: { payloadId: 'reply-p2' } });

      await expectSettledAsExpired(held.relayId, 1);
    });
  }

  it('deadline passed but not yet swept, nothing waiting: closed as expired, no expiry notice queued', async () => {
    const held = await heldRelay('prompt', NOW + 10);

    expect(resolve(held, 'confirm', NOW + 30)).toMatchObject({ ok: true, expired: true, discardedReply: null });
    expect(sweepExpiredRelays(db, NOW + 40)).toBe(0);

    await expectSettledAsExpired(held.relayId, 0);
  });

  it('negative control: a held reply past its deadline is still closed by confirm as delivered (not expired)', async () => {
    const held = await heldRelay('reply', NOW + 10);

    expect(resolve(held, 'confirm', NOW + 30)).toMatchObject({ ok: true, expired: false });
    expect(getRelayById(db, held.relayId)?.state).toBe('delivered');
  });

  it('negative control: without a hold, the sweep still supersedes the waiting reply', () => {
    const relay = legacyRelay(NOW + 10);
    stashRelayPayload(db, relay.id, 'prompt', '[from Codex] notice', NOW);
    setRelayPendingReply(db, relay.id, WAITING_REPLY as never, NOW + 3);

    expect(sweepExpiredRelays(db, NOW + 20)).toBe(1);

    expect(getRelayBinding(db, relay.id)?.pendingReply).toBeNull();
    expect(getRelayPendingPayload(db, relay.id)?.kind).toBe('expired');
  });

  it('negative control: a cancel still empties the waiting reply of a held notice (stops later deliveries)', async () => {
    const held = await heldPromptWithWaitingReply(NOW + DAY_MS);

    expect(cancelRelay(db, held.relayId, NOW + 30)).toBe(true);

    expect(getRelayBinding(db, held.relayId)?.pendingReply).toBeNull();
    expect(resolve(held, 'discard', NOW + 40)).toMatchObject({ ok: true, discardedReply: null });
  });
});

describe('the held axis is counted apart from the states (Issue #4082)', () => {
  it('uncertain only, closed relays included, once per row, never narrowed by a period', async () => {
    const openHeld = await heldRelay('reply');
    const closedHeld = await heldRelay('prompt');
    cancelRelay(db, closedHeld.relayId, NOW + 5);
    // attempting: still pending, not held.
    const attempting = legacyRelay();
    stashRelayPayload(db, attempting.id, 'reply', '[from Codex] typing', NOW);
    db.prepare("UPDATE session_relays SET delivery_state = 'attempting', delivery_attempt_id = 'a', delivery_owner = 'x' WHERE id = ?").run(attempting.id);
    // Another worktree's hold.
    insertWorktree('wt-c', 'gemini');
    const elsewhere = legacyRelay(NOW + DAY_MS, { worktreeId: 'wt-c', instanceId: 'gemini' }, B);
    stashRelayPayload(db, elsewhere.id, 'reply', '[from Codex] elsewhere', NOW);
    db.prepare("UPDATE session_relays SET delivery_state = 'uncertain', delivery_attempt_id = 'e' WHERE id = ?").run(elsewhere.id);
    // An old relay held today is still counted: no `since`.
    db.prepare('UPDATE session_relays SET created_at = ? WHERE id = ?').run(NOW - 400 * DAY_MS, openHeld.relayId);

    expect(countHeldRelays(db)).toBe(3);
    expect(countHeldRelays(db, { worktreeId: 'wt-a' })).toBe(2);
    expect(countHeldRelays(db, { worktreeId: 'wt-a', instanceId: 'claude' })).toBe(2);
    expect(countHeldRelays(db, { worktreeId: 'wt-a', instanceId: 'claude-2' })).toBe(0);
    expect(countHeldRelays(db, { worktreeId: 'wt-b' })).toBe(3);
    // The per-state counts keep their five keys and are not changed by it.
    expect(Object.keys(countRelays(db)).sort()).toEqual(['cancelled', 'delivered', 'expired', 'pending', 'prompt']);

    expect(resolve(openHeld, 'confirm').ok).toBe(true);
    expect(countHeldRelays(db, { worktreeId: 'wt-a' })).toBe(1);
  });

  it('GET /api/relays answers heldCount beside counts, without days narrowing it', async () => {
    const held = await heldRelay('reply');
    db.prepare('UPDATE session_relays SET created_at = ? WHERE id = ?').run(Date.now() - 30 * DAY_MS, held.relayId);
    const { GET } = await import('@/app/api/relays/route');

    const body = await (
      await GET(new Request('http://localhost/api/relays?worktree=wt-a&days=7') as unknown as NextRequest)
    ).json();

    expect(body.heldCount).toBe(1);
    expect(body.counts.pending).toBe(0);
    expect(body.counts).not.toHaveProperty('held');
  });

  it('the resolve route answers replyDiscarded', async () => {
    const held = await heldRelay('prompt', NOW + 10);
    setRelayPendingReply(db, held.relayId, WAITING_REPLY as never, NOW + 3);
    sweepExpiredRelays(db, NOW + 20);
    const { POST } = await import('@/app/api/relays/[relayId]/resolve/route');

    const response = await POST(
      new Request(`http://localhost/api/relays/${held.relayId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payloadId: held.payloadId, attemptId: held.attemptId, action: 'discard' }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ relayId: held.relayId }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replyDiscarded: true, requeued: false, promoted: false });
  });
});

describe('the system-line key is built once (Issue #4082)', () => {
  it('relaySystemRequestId keeps the once-per-relay key and adds a scope only when given', () => {
    expect(relaySystemRequestId('r1', 'expired')).toBe('relay-sys:r1:expired');
    expect(relaySystemRequestId('r1', 'held', 'p:a')).toBe('relay-sys:r1:held:p:a');
  });

  it('a seeded reply row in A is still a reply (the exclusion is by prefix only)', () => {
    createMessage(db, {
      worktreeId: 'wt-a',
      role: 'assistant',
      content: 'a real answer',
      messageType: 'normal',
      timestamp: new Date(NOW + 1),
      requestId: codexTurnRequestId('t1'),
      cliToolId: 'claude',
      instanceId: 'claude',
    });
    const worker = { worktreeId: 'wt-a', cliToolId: 'claude' as const, instanceId: 'claude' };
    expect(findWorkerReply(db, worker, 0)?.content).toBe('a real answer');
  });
});
