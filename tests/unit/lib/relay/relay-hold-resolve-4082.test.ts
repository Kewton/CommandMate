/**
 * Resolving a relay delivery held as `uncertain` (Issue #4082).
 *
 * #4064 held a payload whose delivery outcome was not known and never sent it
 * again, but nothing could settle the hold. `POST /api/relays/:id/resolve`
 * (`resolveRelayDeliveryHold`) now confirms, retries or discards it, keyed on
 * the relay, the payload AND the delivery attempt, in one transaction. And a
 * late result of an older attempt (T1) no longer closes the relay or empties
 * the payload a retry's newer attempt (T2) holds — `completeRelayReplyDelivery`
 * used to close by relay id before it checked the attempt.
 *
 * Positive controls fail on the implementation before the fix (no resolve at
 * all; T1's late success closes the relay). Negative controls (refused
 * operations change nothing; the ordinary delivery is unchanged) pass both.
 *
 * The database is a file under a fresh `fs.mkdtempSync(os.tmpdir())`
 * directory, removed in `afterEach` — never the production database.
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
import { createMessage } from '@/lib/db/chat-db';
import { codexTurnRequestId } from '@/types/agent-transcript';
import {
  claimRelayPayloadDelivery,
  completeRelayPayloadDelivery,
  completeRelayPromptDelivery,
  completeRelayReplyDelivery,
  createRelay,
  getRelayBinding,
  getRelayById,
  getRelayPendingPayload,
  holdRelayPayloadDelivery,
  recoverInterruptedRelayDeliveries,
  releaseRelayPayloadDelivery,
  resolveRelayDeliveryHold,
  stashRelayPayload,
} from '@/lib/db/relay-db';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import { resolveRelayHold, withdrawRelay } from '@/lib/relay/relay-service';
import type { RelayHoldAction } from '@/lib/relay/types';
import type { SendAttemptReason, SendAttemptState } from '@/lib/session/send-attempt-types';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const CODEX_WORKER = { worktreeId: 'wt-b', cliToolId: 'codex' as const, instanceId: 'codex' };

let dir: string;
let dbPath: string;
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

const {
  evaluateRelayAfterSend,
  notifyRelayPromptWaiting,
  notifyRelayTurnCompleted,
  pumpRelayDeliveries,
  resetRelayDeliveryState,
  runRelayMaintenanceTick,
  sweepExpiredRelays,
} = await import('@/lib/relay/relay-delivery');

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
const SENT_ATTEMPT: Attempt = { state: 'sent', reason: 'submitted' };

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

function seedReply(content: string, at: number): void {
  createMessage(db, {
    worktreeId: 'wt-b',
    role: 'assistant',
    content,
    messageType: 'normal',
    timestamp: new Date(at),
    requestId: codexTurnRequestId(`turn-${at}`),
    cliToolId: 'codex',
    instanceId: 'codex',
  });
}

function seedDialog(question: string, at: number): void {
  createMessage(db, {
    worktreeId: 'wt-b',
    role: 'assistant',
    content: question,
    messageType: 'prompt',
    timestamp: new Date(at),
    cliToolId: 'codex',
    instanceId: 'codex',
  });
}

function legacyRelay(expiresAt = NOW + DAY_MS) {
  return createRelay(db, { from: A, to: B, hops: 1, expiresAt, now: NOW });
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

/** Every column of the row, for "nothing changed". */
function snapshot(relayId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM session_relays WHERE id = ?').get(relayId) as Record<string, unknown>;
}

function systemLines(kind: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE request_id LIKE ?`)
    .get(`%:${kind}`) as { n: number };
  return row.n;
}

interface Held {
  relayId: string;
  payloadId: string;
  attemptId: string;
  body: string;
}

/** Read the uncertain hold back, and let later sends succeed. */
function readHold(relayId: string, body: string): Held {
  const hold = getRelayById(db, relayId)?.deliveryHold;
  expect(hold?.state).toBe('uncertain');
  expect(hold?.attemptId).toEqual(expect.any(String));
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue(OK);
  return { relayId, payloadId: hold?.payloadId as string, attemptId: hold?.attemptId as string, body };
}

/** Hold the relay's current payload as `uncertain` through a real delivery, and read the hold back. */
async function holdCurrent(relayId: string): Promise<Held> {
  const body = getRelayPendingPayload(db, relayId)?.body as string;
  sendUserMessage.mockImplementation(sendReporting(INDETERMINATE, SEND_FAILED));
  await pumpRelayDeliveries();
  return readHold(relayId, body);
}

/** B stops on a dialog; the notice told to A through the real path is held as uncertain. */
async function holdPromptNotice(relayId: string, question: string, at: number): Promise<Held> {
  sendUserMessage.mockImplementation(sendReporting(INDETERMINATE, SEND_FAILED));
  seedDialog(question, at);
  notifyRelayPromptWaiting(CODEX_WORKER);
  await flush();
  const body = String((sendUserMessage.mock.calls.at(-1)?.[1] as SendParams).content);
  expect(body).toContain(question);
  return readHold(relayId, body);
}

/** A relay whose `kind` payload is held as uncertain. */
async function heldRelay(kind: 'reply' | 'prompt' | 'expired'): Promise<Held> {
  if (kind === 'expired') {
    const relay = legacyRelay(NOW - 1);
    expect(sweepExpiredRelays(db, NOW)).toBe(1);
    return holdCurrent(relay.id);
  }
  const relay = legacyRelay();
  expect(stashRelayPayload(db, relay.id, kind, `[from Codex] ${kind} body`, NOW)).toBe(true);
  return holdCurrent(relay.id);
}

/** A prompt notice held as uncertain, with a reply finished behind it in the second slot. */
async function heldPromptWithReply(): Promise<Held & { replyPayloadId: string }> {
  const relay = legacyRelay();
  const held = await holdPromptNotice(relay.id, 'Proceed?', NOW + 500);
  expect(getRelayPendingPayload(db, relay.id)?.kind).toBe('prompt');
  seedReply('the final answer', NOW + 1_000);
  await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
  await flush();
  const pendingReply = getRelayBinding(db, relay.id)?.pendingReply;
  expect(pendingReply?.body).toContain('the final answer');
  return { ...held, replyPayloadId: pendingReply?.payloadId as string };
}

function resolve(held: Held, action: RelayHoldAction, overrides: Partial<{ payloadId: string; attemptId: string | null; now: number }> = {}) {
  return resolveRelayHold(db, {
    relayId: held.relayId,
    payloadId: overrides.payloadId ?? held.payloadId,
    attemptId: overrides.attemptId === undefined ? held.attemptId : overrides.attemptId,
    action,
    now: overrides.now,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-4082-'));
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
});

afterEach(() => {
  resetRelayDeliveryState();
  resetRelayServerBootId();
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The nine cells
// ---------------------------------------------------------------------------

describe('reply / prompt / expired × confirm / retry / discard (Issue #4082)', () => {
  it('reply · confirm: closed as delivered, slots emptied, no keystroke', async () => {
    const held = await heldRelay('reply');
    const result = resolve(held, 'confirm');
    expect(result).toMatchObject({ ok: true, requeued: false, promoted: false });
    expect(getRelayById(db, held.relayId)).toMatchObject({
      state: 'delivered',
      sentRequestId: `relay:${held.relayId}`,
      pendingKind: null,
      deliveryHold: null,
    });
    expect(getRelayPendingPayload(db, held.relayId)).toBeNull();
    await pumpRepeatedly();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('reply · retry: the same payload is queued again, and the next delivery sends it once', async () => {
    const held = await heldRelay('reply');
    const result = resolve(held, 'retry');
    expect(result).toMatchObject({ ok: true, requeued: true });
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'pending', deliveryHold: null });
    expect(getRelayPendingPayload(db, held.relayId)).toMatchObject({ kind: 'reply', body: held.body, payloadId: held.payloadId });
    // Nothing typed by the resolve itself.
    expect(sendUserMessage).not.toHaveBeenCalled();

    await pumpRepeatedly();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][1]).toMatchObject({ content: held.body });
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'delivered', deliveryHold: null });
  });

  it('reply · discard: closed as cancelled, both slots emptied, no keystroke', async () => {
    const held = await heldRelay('reply');
    expect(resolve(held, 'discard')).toMatchObject({ ok: true });
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'cancelled', pendingKind: null, deliveryHold: null, sentRequestId: null });
    expect(getRelayBinding(db, held.relayId)?.pendingReply).toBeNull();
    await pumpRepeatedly();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  for (const action of ['confirm', 'discard'] as const) {
    it(`prompt · ${action}: slot emptied, the waiting reply promoted in the same write, the relay stays open, signature kept`, async () => {
      const held = await heldPromptWithReply();
      const signature = snapshot(held.relayId).prompt_signature;
      const result = resolve(held, action);
      expect(result).toMatchObject({ ok: true, promoted: true, requeued: false });
      expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'prompt', deliveryHold: null });
      expect(getRelayPendingPayload(db, held.relayId)).toMatchObject({
        kind: 'reply',
        payloadId: held.replyPayloadId,
        body: expect.stringContaining('the final answer'),
      });
      expect(getRelayBinding(db, held.relayId)?.pendingReply).toBeNull();
      expect(snapshot(held.relayId).prompt_signature).toBe(signature);
      // The resolve typed nothing; the promoted reply (another payload) is the pump's.
      expect(sendUserMessage).not.toHaveBeenCalled();
      await pumpRepeatedly();
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(String((sendUserMessage.mock.calls[0][1] as SendParams).content)).toContain('the final answer');
      expect(getRelayById(db, held.relayId)?.state).toBe('delivered');
    });
  }

  it('prompt · confirm without a waiting reply: slot emptied, relay open, nothing to promote', async () => {
    const held = await heldRelay('prompt');
    expect(resolve(held, 'confirm')).toMatchObject({ ok: true, promoted: false });
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'pending', pendingKind: null, deliveryHold: null });
    await pumpRepeatedly();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('prompt · retry: queued again with the second slot untouched; sent once, then the reply follows', async () => {
    const held = await heldPromptWithReply();
    expect(resolve(held, 'retry')).toMatchObject({ ok: true, requeued: true });
    expect(getRelayPendingPayload(db, held.relayId)).toMatchObject({ kind: 'prompt', payloadId: held.payloadId, body: held.body });
    expect(getRelayBinding(db, held.relayId)?.pendingReply?.payloadId).toBe(held.replyPayloadId);

    await pumpRepeatedly();
    const bodies = sendUserMessage.mock.calls.map((call) => String((call[1] as SendParams).content));
    expect(bodies.filter((body) => body === held.body)).toHaveLength(1);
    expect(bodies.filter((body) => body.includes('the final answer'))).toHaveLength(1);
  });

  it('expired · confirm: the closed relay stays expired, the notice slot is emptied', async () => {
    const held = await heldRelay('expired');
    expect(resolve(held, 'confirm')).toMatchObject({ ok: true });
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'expired', pendingKind: null, deliveryHold: null });
    await pumpRepeatedly();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('expired · retry: still closed, the notice queued again and sent once', async () => {
    const held = await heldRelay('expired');
    expect(resolve(held, 'retry')).toMatchObject({ ok: true, requeued: true });
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'expired', pendingKind: 'expired', deliveryHold: null });
    await pumpRepeatedly();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'expired', pendingKind: null, deliveryHold: null });
  });

  it('expired · discard: the closed relay stays expired, the notice slot is emptied', async () => {
    const held = await heldRelay('expired');
    expect(resolve(held, 'discard')).toMatchObject({ ok: true });
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'expired', pendingKind: null, deliveryHold: null });
    await pumpRepeatedly();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Closed relays and passed deadlines
// ---------------------------------------------------------------------------

describe('a closed relay or a passed deadline (Issue #4082)', () => {
  for (const kind of ['reply', 'prompt'] as const) {
    for (const close of ['cancel', 'expiry'] as const) {
      const closedState = close === 'cancel' ? 'cancelled' : 'expired';

      it(`${kind} held, relay ${closedState}: confirm/discard empty the slot and keep the state`, async () => {
        for (const action of ['confirm', 'discard'] as const) {
          const held = await heldRelay(kind);
          if (close === 'cancel') expect(withdrawRelay(db, held.relayId).ok).toBe(true);
          else expect(sweepExpiredRelays(db, NOW + 2 * DAY_MS)).toBe(1);
          expect(getRelayById(db, held.relayId)?.deliveryHold?.state).toBe('uncertain');

          expect(resolve(held, action)).toMatchObject({ ok: true });
          expect(getRelayById(db, held.relayId)).toMatchObject({ state: closedState, pendingKind: null, deliveryHold: null });
        }
        await pumpRepeatedly();
        expect(sendUserMessage).not.toHaveBeenCalled();
      });

      it(`${kind} held, relay ${closedState}: retry is refused and nothing changes (not reopened)`, async () => {
        const held = await heldRelay(kind);
        if (close === 'cancel') expect(withdrawRelay(db, held.relayId).ok).toBe(true);
        else expect(sweepExpiredRelays(db, NOW + 2 * DAY_MS)).toBe(1);
        const before = snapshot(held.relayId);

        expect(resolve(held, 'retry')).toMatchObject({ ok: false, refusal: 'not_allowed' });
        expect(snapshot(held.relayId)).toEqual(before);
        await pumpRepeatedly();
        expect(sendUserMessage).not.toHaveBeenCalled();
      });
    }

    it(`${kind} held on an open relay past its deadline: retry refused, confirm still allowed`, async () => {
      const held = await heldRelay(kind);
      const before = snapshot(held.relayId);
      expect(resolve(held, 'retry', { now: NOW + 2 * DAY_MS })).toMatchObject({ ok: false, refusal: 'not_allowed' });
      expect(snapshot(held.relayId)).toEqual(before);
      expect(resolve(held, 'confirm', { now: NOW + 2 * DAY_MS })).toMatchObject({ ok: true });
    });
  }

  it('a cancel after a retry was accepted stops the queued payload (the expiry sweep likewise)', async () => {
    const held = await heldRelay('reply');
    expect(resolve(held, 'retry')).toMatchObject({ ok: true });
    expect(withdrawRelay(db, held.relayId).ok).toBe(true);
    await pumpRepeatedly();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'cancelled', pendingKind: null });
  });
});

// ---------------------------------------------------------------------------
// Refusals change nothing
// ---------------------------------------------------------------------------

describe('stale, double and in-progress operations are refused with every column unchanged (Issue #4082)', () => {
  it('a wrong payload id or attempt id: stale', async () => {
    const held = await heldRelay('reply');
    const before = snapshot(held.relayId);
    expect(resolve(held, 'confirm', { payloadId: 'other-payload' })).toMatchObject({ ok: false, refusal: 'stale' });
    expect(resolve(held, 'retry', { attemptId: 'other-attempt' })).toMatchObject({ ok: false, refusal: 'stale' });
    expect(snapshot(held.relayId)).toEqual(before);
  });

  for (const [first, second] of [
    ['confirm', 'confirm'],
    ['confirm', 'retry'],
    ['discard', 'retry'],
    ['retry', 'retry'],
    ['retry', 'confirm'],
  ] as const) {
    it(`${first} then ${second} on the same hold: only the first wins`, async () => {
      const held = await heldRelay('reply');
      expect(resolve(held, first)).toMatchObject({ ok: true });
      const after = snapshot(held.relayId);
      expect(resolve(held, second)).toMatchObject({ ok: false, refusal: 'no_hold' });
      expect(snapshot(held.relayId)).toEqual(after);
    });
  }

  it('a second database connection racing the same operation loses (it sees the first one committed)', async () => {
    const held = await heldRelay('reply');
    const other = new Database(dbPath);
    try {
      expect(resolveRelayDeliveryHold(other, {
        relayId: held.relayId, payloadId: held.payloadId, attemptId: held.attemptId,
        action: 'retry', sentRequestId: `relay:${held.relayId}`,
      })).toMatchObject({ ok: true });
      const after = snapshot(held.relayId);
      expect(resolve(held, 'confirm')).toMatchObject({ ok: false, refusal: 'no_hold' });
      expect(snapshot(held.relayId)).toEqual(after);
    } finally {
      other.close();
    }
  });

  it('a retry, a new attempt, and the old screen\'s operation: refused as stale', async () => {
    const held = await heldRelay('reply');
    expect(resolve(held, 'retry')).toMatchObject({ ok: true });
    // The retried delivery is uncertain again: a NEW attempt id.
    sendUserMessage.mockImplementation(sendReporting(INDETERMINATE, SEND_FAILED));
    await pumpRepeatedly();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const again = getRelayById(db, held.relayId)?.deliveryHold;
    expect(again).toMatchObject({ state: 'uncertain', payloadId: held.payloadId });
    expect(again?.attemptId).not.toBe(held.attemptId);

    const before = snapshot(held.relayId);
    expect(resolve(held, 'confirm')).toMatchObject({ ok: false, refusal: 'stale' });
    expect(snapshot(held.relayId)).toEqual(before);
    // The current attempt's id settles it.
    expect(resolve({ ...held, attemptId: again?.attemptId as string }, 'confirm')).toMatchObject({ ok: true });
  });

  it('attempting (a delivery is typing it): refused, nothing changes', () => {
    const relay = legacyRelay();
    expect(stashRelayPayload(db, relay.id, 'reply', 'body', NOW)).toBe(true);
    const payload = getRelayPendingPayload(db, relay.id);
    const payloadId = claimRelayPayloadDelivery(db, {
      relayId: relay.id, payloadId: payload?.payloadId ?? null, kind: 'reply', body: 'body',
      attemptId: 'T1', owner: 'boot', mintPayloadId: 'minted',
    });
    expect(payloadId).toBeTruthy();
    const before = snapshot(relay.id);
    for (const action of ['confirm', 'retry', 'discard'] as const) {
      expect(resolveRelayHold(db, { relayId: relay.id, payloadId: payloadId as string, attemptId: 'T1', action }))
        .toMatchObject({ ok: false, refusal: 'attempting' });
    }
    expect(snapshot(relay.id)).toEqual(before);
  });

  it('no hold (queued): refused', () => {
    const relay = legacyRelay();
    expect(stashRelayPayload(db, relay.id, 'reply', 'body', NOW)).toBe(true);
    const before = snapshot(relay.id);
    const payloadId = getRelayPendingPayload(db, relay.id)?.payloadId as string;
    expect(resolveRelayHold(db, { relayId: relay.id, payloadId, attemptId: 'x', action: 'confirm' }))
      .toMatchObject({ ok: false, refusal: 'no_hold' });
    expect(snapshot(relay.id)).toEqual(before);
  });

  it('a hold without an attempt id (written before #4082 could read it) cannot be resolved; null never matches', async () => {
    const held = await heldRelay('reply');
    db.prepare('UPDATE session_relays SET delivery_attempt_id = NULL WHERE id = ?').run(held.relayId);
    expect(getRelayById(db, held.relayId)?.deliveryHold).toMatchObject({ state: 'uncertain', attemptId: null });
    const before = snapshot(held.relayId);
    expect(resolve(held, 'confirm', { attemptId: null })).toMatchObject({ ok: false, refusal: 'not_allowed' });
    expect(resolve(held, 'confirm')).toMatchObject({ ok: false, refusal: 'not_allowed' });
    expect(snapshot(held.relayId)).toEqual(before);
  });

  it('a relay that does not exist: not_found', () => {
    expect(resolveRelayHold(db, { relayId: 'nope', payloadId: 'p', attemptId: 't', action: 'confirm' }))
      .toMatchObject({ ok: false, refusal: 'not_found', relay: null });
  });
});

// ---------------------------------------------------------------------------
// One transaction
// ---------------------------------------------------------------------------

describe('every write of a resolve commits together (Issue #4082)', () => {
  it('a refused promotion rolls back the emptied prompt slot and the dropped hold', async () => {
    const held = await heldPromptWithReply();
    const before = snapshot(held.relayId);
    db.exec(`CREATE TRIGGER refuse_promotion BEFORE UPDATE ON session_relays
      WHEN NEW.pending_kind = 'reply' BEGIN SELECT RAISE(ABORT, 'promotion refused'); END`);
    expect(() => resolve(held, 'confirm')).toThrow('promotion refused');
    expect(snapshot(held.relayId)).toEqual(before);
  });

  it('a refused close rolls back a reply confirm', async () => {
    const held = await heldRelay('reply');
    const before = snapshot(held.relayId);
    db.exec(`CREATE TRIGGER refuse_close BEFORE UPDATE ON session_relays
      WHEN NEW.state = 'delivered' BEGIN SELECT RAISE(ABORT, 'close refused'); END`);
    expect(() => resolve(held, 'confirm')).toThrow('close refused');
    expect(snapshot(held.relayId)).toEqual(before);
  });

  it('a refused hold drop rolls back a retry', async () => {
    const held = await heldRelay('reply');
    const before = snapshot(held.relayId);
    db.exec(`CREATE TRIGGER refuse_drop BEFORE UPDATE ON session_relays
      WHEN OLD.delivery_state = 'uncertain' AND NEW.delivery_state IS NULL BEGIN SELECT RAISE(ABORT, 'drop refused'); END`);
    expect(() => resolve(held, 'retry')).toThrow('drop refused');
    expect(snapshot(held.relayId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Not captured again
// ---------------------------------------------------------------------------

describe('a confirmed or discarded payload is not captured again (Issue #4082)', () => {
  for (const action of ['confirm', 'discard'] as const) {
    it(`reply · ${action}: the next completion, send-after evaluation and maintenance capture nothing`, async () => {
      const relay = legacyRelay();
      seedReply('done', NOW + 1_000);
      sendUserMessage.mockImplementation(sendReporting(INDETERMINATE, SEND_FAILED));
      await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
      await flush();
      await pumpRelayDeliveries();
      const hold = getRelayById(db, relay.id)?.deliveryHold;
      expect(hold?.state).toBe('uncertain');
      sendUserMessage.mockReset();
      sendUserMessage.mockResolvedValue(OK);

      expect(resolveRelayHold(db, {
        relayId: relay.id, payloadId: hold?.payloadId as string, attemptId: hold?.attemptId as string, action,
      })).toMatchObject({ ok: true });
      const after = snapshot(relay.id);

      seedReply('done again', NOW + 2_000);
      await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
      evaluateRelayAfterSend(relay.id);
      await flush();
      await pumpRepeatedly();

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(getRelayPendingPayload(db, relay.id)).toBeNull();
      expect(snapshot(relay.id).state).toBe(after.state);
    });
  }

  for (const action of ['confirm', 'discard'] as const) {
    it(`prompt · ${action}: the same dialog is not told again; a new dialog and the final reply are`, async () => {
      const relay = legacyRelay();
      const held = await holdPromptNotice(relay.id, 'Proceed?', NOW + 500);
      expect(resolve(held, action)).toMatchObject({ ok: true });

      // Same dialog again (every poll of a long wait): nothing.
      notifyRelayPromptWaiting(CODEX_WORKER);
      await flush();
      await pumpRepeatedly();
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(getRelayPendingPayload(db, relay.id)).toBeNull();

      // A new dialog: told.
      seedDialog('Overwrite file?', NOW + 800);
      notifyRelayPromptWaiting(CODEX_WORKER);
      await flush();
      await pumpRepeatedly();
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(String((sendUserMessage.mock.calls[0][1] as SendParams).content)).toContain('Overwrite file?');

      // The final reply: delivered.
      seedReply('all done', NOW + 1_500);
      await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
      await flush();
      await pumpRepeatedly();
      expect(sendUserMessage).toHaveBeenCalledTimes(2);
      expect(String((sendUserMessage.mock.calls[1][1] as SendParams).content)).toContain('all done');
      expect(getRelayById(db, relay.id)?.state).toBe('delivered');
    });
  }
});

// ---------------------------------------------------------------------------
// An older attempt's late result
// ---------------------------------------------------------------------------

describe('a late result of the older attempt (T1) leaves the retry\'s attempt (T2) alone (Issue #4082)', () => {
  /** T1 queued → claimed → held → retried → T2 claimed. */
  async function retriedWithT2(kind: 'reply' | 'prompt') {
    const held = kind === 'prompt' ? await heldPromptWithReply() : await heldRelay('reply');
    expect(resolve(held, 'retry')).toMatchObject({ ok: true });
    const t2 = claimRelayPayloadDelivery(db, {
      relayId: held.relayId, payloadId: held.payloadId, kind, body: held.body,
      attemptId: 'T2', owner: 'other-boot', mintPayloadId: 'unused',
    });
    expect(t2).toBe(held.payloadId);
    return held;
  }

  it('reply: T1\'s late success does not close the relay or empty T2\'s payload', async () => {
    const held = await retriedWithT2('reply');
    const before = snapshot(held.relayId);
    const t1 = { relayId: held.relayId, payloadId: held.payloadId, attemptId: held.attemptId };
    expect(completeRelayReplyDelivery(db, { ...t1, sentRequestId: `relay:${held.relayId}` }))
      .toEqual({ closed: false, completed: false });
    expect(completeRelayPayloadDelivery(db, t1)).toBe(false);
    expect(releaseRelayPayloadDelivery(db, t1)).toBe(false);
    expect(holdRelayPayloadDelivery(db, { ...t1, reason: 'late' })).toBe(false);
    expect(snapshot(held.relayId)).toEqual(before);
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'pending', deliveryHold: { state: 'attempting', attemptId: 'T2' } });

    // Negative control: T2's own success closes it.
    expect(completeRelayReplyDelivery(db, { ...t1, attemptId: 'T2', sentRequestId: `relay:${held.relayId}` }))
      .toEqual({ closed: true, completed: true });
  });

  it('prompt: T1\'s late success does not promote the waiting reply or end T2', async () => {
    const held = await retriedWithT2('prompt');
    const before = snapshot(held.relayId);
    const t1 = { relayId: held.relayId, payloadId: held.payloadId, attemptId: held.attemptId };
    expect(completeRelayPromptDelivery(db, t1)).toEqual({ completed: false, promoted: false });
    expect(snapshot(held.relayId)).toEqual(before);
    expect(completeRelayPromptDelivery(db, { ...t1, attemptId: 'T2' })).toEqual({ completed: true, promoted: true });
  });

  const lateResults: Array<[string, (params: SendParams) => Promise<unknown>]> = [
    ['success', async (params) => { params.onAttempt?.(SENT_ATTEMPT); return OK; }],
    ['indeterminate failure', async (params) => { params.onAttempt?.(INDETERMINATE); return SEND_FAILED; }],
    ['not-sent failure', async (params) => { params.onAttempt?.({ state: 'not-sent', reason: 'prompt-not-ready' }); return SEND_FAILED; }],
    ['throw after sent', async (params) => { params.onAttempt?.(SENT_ATTEMPT); throw new Error('late throw'); }],
  ];

  for (const [label, finish] of lateResults) {
    it(`through the pump: T1's ${label}, after another boot held it and a retry let T2 take it, changes nothing`, async () => {
      const relay = legacyRelay();
      expect(stashRelayPayload(db, relay.id, 'reply', 'the reply', NOW)).toBe(true);
      let before: Record<string, unknown> = {};
      sendUserMessage.mockImplementation(async (_db: unknown, params: SendParams) => {
        // While T1 is typing: another boot's recovery holds it, an operator
        // retries it, and that boot's pump takes it as T2.
        expect(recoverInterruptedRelayDeliveries(db, 'other-boot')).toBe(1);
        const hold = getRelayById(db, relay.id)?.deliveryHold;
        expect(resolveRelayHold(db, {
          relayId: relay.id, payloadId: hold?.payloadId as string, attemptId: hold?.attemptId as string, action: 'retry',
        })).toMatchObject({ ok: true });
        expect(claimRelayPayloadDelivery(db, {
          relayId: relay.id, payloadId: hold?.payloadId as string, kind: 'reply', body: 'the reply',
          attemptId: 'T2', owner: 'other-boot', mintPayloadId: 'unused',
        })).toBe(hold?.payloadId);
        before = snapshot(relay.id);
        return finish(params);
      });

      await pumpRelayDeliveries();

      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(snapshot(relay.id)).toEqual(before);
      expect(getRelayById(db, relay.id)).toMatchObject({
        state: 'pending',
        deliveryHold: { state: 'attempting', attemptId: 'T2' },
      });
      expect(systemLines('replied')).toBe(0);
    });
  }

  it('negative control: an ordinary delivery still closes the relay and writes the replied line', async () => {
    const relay = legacyRelay();
    expect(stashRelayPayload(db, relay.id, 'reply', 'the reply', NOW)).toBe(true);
    await pumpRelayDeliveries();
    expect(getRelayById(db, relay.id)).toMatchObject({ state: 'delivered', deliveryHold: null });
    expect(systemLines('replied')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

describe('a restart after a resolve (Issue #4082)', () => {
  function restart(): void {
    db.close();
    resetRelayDeliveryState();
    resetRelayServerBootId();
    db = openDb();
  }

  it('retry accepted, stopped before any delivery took it: still queued, sent once after the restart', async () => {
    const held = await heldRelay('reply');
    expect(resolve(held, 'retry')).toMatchObject({ ok: true });
    restart();
    expect(getRelayById(db, held.relayId)?.deliveryHold).toBeNull();
    await pumpRepeatedly();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, held.relayId)?.state).toBe('delivered');
  });

  it('retry taken by T2, stopped mid-send: only T2 is held after the restart', async () => {
    const held = await heldRelay('reply');
    expect(resolve(held, 'retry')).toMatchObject({ ok: true });
    claimRelayPayloadDelivery(db, {
      relayId: held.relayId, payloadId: held.payloadId, kind: 'reply', body: held.body,
      attemptId: 'T2', owner: 'dead-boot', mintPayloadId: 'unused',
    });
    restart();
    await pumpRepeatedly();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, held.relayId)?.deliveryHold).toMatchObject({ state: 'uncertain', attemptId: 'T2', reason: 'server-restarted' });
  });

  it('confirmed or discarded: nothing comes back after the restart', async () => {
    const confirmed = await heldRelay('reply');
    const discarded = await heldRelay('prompt');
    expect(resolve(confirmed, 'confirm')).toMatchObject({ ok: true });
    expect(resolve(discarded, 'discard')).toMatchObject({ ok: true });
    restart();
    await pumpRepeatedly();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, confirmed.relayId)).toMatchObject({ state: 'delivered', deliveryHold: null });
    expect(getRelayById(db, discarded.relayId)).toMatchObject({ pendingKind: null, deliveryHold: null });
  });
});

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

describe('POST /api/relays/:id/resolve and the public attemptId (Issue #4082)', () => {
  async function post(relayId: string, body: unknown, raw = false) {
    const { POST } = await import('@/app/api/relays/[relayId]/resolve/route');
    const request = new Request(`http://localhost/api/relays/${relayId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ? String(body) : JSON.stringify(body),
    });
    const response = await POST(request as unknown as NextRequest, { params: Promise.resolve({ relayId }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('200 with the relay; a retry is "queued", and the pump (not the route) sends it', async () => {
    const held = await heldRelay('reply');
    const response = await post(held.relayId, { payloadId: held.payloadId, attemptId: held.attemptId, action: 'retry' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ action: 'retry', requeued: true, promoted: false, relay: { id: held.relayId, deliveryHold: null } });
    await flush();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('200 for confirm types nothing', async () => {
    const held = await heldRelay('reply');
    const response = await post(held.relayId, { payloadId: held.payloadId, attemptId: held.attemptId, action: 'confirm' });
    expect(response).toMatchObject({ status: 200, body: { relay: { state: 'delivered' }, requeued: false } });
    await flush();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('400 for a malformed id or body', async () => {
    const held = await heldRelay('reply');
    const good = { payloadId: held.payloadId, attemptId: held.attemptId, action: 'confirm' };
    expect((await post('not-a-relay', good)).status).toBe(400);
    expect((await post(held.relayId, '{oops', true)).status).toBe(400);
    expect((await post(held.relayId, { ...good, payloadId: undefined })).status).toBe(400);
    expect((await post(held.relayId, { ...good, payloadId: '' })).status).toBe(400);
    expect((await post(held.relayId, { ...good, attemptId: 7 })).status).toBe(400);
    expect((await post(held.relayId, { ...good, attemptId: undefined })).status).toBe(400);
    expect((await post(held.relayId, { ...good, action: 'cancel' })).status).toBe(400);
    expect(getRelayById(db, held.relayId)?.deliveryHold?.state).toBe('uncertain');
  });

  it('404 for a relay that does not exist', async () => {
    const response = await post('11111111-2222-4333-8444-555555555555', { payloadId: 'p', attemptId: 't', action: 'confirm' });
    expect(response.status).toBe(404);
  });

  it('409 with a stable code: stale, null attempt, double, attempting, not allowed', async () => {
    const held = await heldRelay('reply');
    expect(await post(held.relayId, { payloadId: held.payloadId, attemptId: 'old', action: 'confirm' }))
      .toMatchObject({ status: 409, body: { code: 'RELAY_HOLD_STALE' } });
    expect(await post(held.relayId, { payloadId: held.payloadId, attemptId: null, action: 'confirm' }))
      .toMatchObject({ status: 409, body: { code: 'RELAY_HOLD_NOT_ALLOWED' } });
    expect(withdrawRelay(db, held.relayId).ok).toBe(true);
    expect(await post(held.relayId, { payloadId: held.payloadId, attemptId: held.attemptId, action: 'retry' }))
      .toMatchObject({ status: 409, body: { code: 'RELAY_HOLD_NOT_ALLOWED' } });
    expect((await post(held.relayId, { payloadId: held.payloadId, attemptId: held.attemptId, action: 'discard' })).status).toBe(200);
    expect(await post(held.relayId, { payloadId: held.payloadId, attemptId: held.attemptId, action: 'discard' }))
      .toMatchObject({ status: 409, body: { code: 'RELAY_HOLD_NOT_FOUND' } });

    const relay = legacyRelay();
    expect(stashRelayPayload(db, relay.id, 'reply', 'b', NOW)).toBe(true);
    const payloadId = claimRelayPayloadDelivery(db, {
      relayId: relay.id, payloadId: getRelayPendingPayload(db, relay.id)?.payloadId ?? null, kind: 'reply', body: 'b',
      attemptId: 'T1', owner: 'boot', mintPayloadId: 'm',
    });
    expect(await post(relay.id, { payloadId, attemptId: 'T1', action: 'confirm' }))
      .toMatchObject({ status: 409, body: { code: 'RELAY_HOLD_ATTEMPTING' } });
  });

  it('500 when the database refuses the write, and nothing is committed', async () => {
    const held = await heldRelay('reply');
    const before = snapshot(held.relayId);
    db.exec(`CREATE TRIGGER refuse_close BEFORE UPDATE ON session_relays
      WHEN NEW.state = 'delivered' BEGIN SELECT RAISE(ABORT, 'close refused'); END`);
    const response = await post(held.relayId, { payloadId: held.payloadId, attemptId: held.attemptId, action: 'confirm' });
    expect(response.status).toBe(500);
    expect(snapshot(held.relayId)).toEqual(before);
  });

  it('deliveryHold.attemptId is the same value on every REST read (list, one relay, cancel)', async () => {
    const held = await heldRelay('reply');
    expect(snapshot(held.relayId).delivery_attempt_id).toBe(held.attemptId);

    const { GET: list } = await import('@/app/api/relays/route');
    const listed = (await (await list(new Request('http://localhost/api/relays?worktree=wt-a&instance=claude') as unknown as NextRequest)).json()) as {
      held: Array<{ deliveryHold: { attemptId: string } }>;
      awaiting: Array<{ deliveryHold: { attemptId: string } }>;
      open: Array<{ deliveryHold: { attemptId: string } }>;
    };
    expect(listed.held[0].deliveryHold.attemptId).toBe(held.attemptId);
    expect(listed.awaiting[0].deliveryHold.attemptId).toBe(held.attemptId);
    expect(listed.open[0].deliveryHold.attemptId).toBe(held.attemptId);

    const { GET: one } = await import('@/app/api/relays/[relayId]/route');
    const single = (await (await one(new Request(`http://localhost/api/relays/${held.relayId}`) as unknown as NextRequest, {
      params: Promise.resolve({ relayId: held.relayId }),
    })).json()) as { relay: { deliveryHold: { attemptId: string } } };
    expect(single.relay.deliveryHold.attemptId).toBe(held.attemptId);

    const { POST: cancel } = await import('@/app/api/relays/[relayId]/cancel/route');
    const cancelled = (await (await cancel(new Request(`http://localhost/api/relays/${held.relayId}/cancel`, { method: 'POST' }) as unknown as NextRequest, {
      params: Promise.resolve({ relayId: held.relayId }),
    })).json()) as { relay: { deliveryHold: { attemptId: string } } };
    expect(cancelled.relay.deliveryHold.attemptId).toBe(held.attemptId);
  });

  it('negative control: no hold, no attemptId (deliveryHold stays null); the send binding id is not exposed', async () => {
    const relay = legacyRelay();
    expect(getRelayById(db, relay.id)?.deliveryHold).toBeNull();
    const held = await heldRelay('reply');
    expect(JSON.stringify(getRelayById(db, held.relayId))).not.toContain('bindAttemptId');
  });
});

// ---------------------------------------------------------------------------
// Review follow-ups: the waiting reply goes first; the answer's read is part
// of the transaction
// ---------------------------------------------------------------------------

describe('a prompt hold retried, then a later reply arrives before the pump takes the notice (Issue #4082)', () => {
  it('the reply that waited (R1) takes the slot, the later one (R2) is dropped, the second slot is emptied; A gets R1 once', async () => {
    const held = await heldPromptWithReply();
    expect(resolve(held, 'retry')).toMatchObject({ ok: true, requeued: true });
    expect(sendUserMessage).not.toHaveBeenCalled();

    // R2 finishes after the retry, before any delivery took the queued notice
    // (nothing pumps in between: the stash is called directly).
    seedReply('a later answer', NOW + 2_000);
    const { stashReplyForOpenRelays } = await import('@/lib/relay/relay-bound-reply');
    expect(stashReplyForOpenRelays(db, CODEX_WORKER, NOW + 2_100)).toBe(1);

    expect(getRelayPendingPayload(db, held.relayId)).toMatchObject({
      kind: 'reply',
      payloadId: held.replyPayloadId,
      body: expect.stringContaining('the final answer'),
    });
    expect(getRelayBinding(db, held.relayId)?.pendingReply).toBeNull();

    sendUserMessage.mockReset();
    sendUserMessage.mockResolvedValue(OK);
    await pumpRepeatedly();
    const bodies = sendUserMessage.mock.calls.map((call) => String((call[1] as SendParams).content));
    expect(bodies.filter((body) => body.includes('the final answer'))).toHaveLength(1);
    expect(bodies.some((body) => body.includes('a later answer'))).toBe(false);
    expect(bodies.some((body) => body === held.body)).toBe(false);
    expect(getRelayById(db, held.relayId)).toMatchObject({ state: 'delivered', pendingKind: null });
    expect(getRelayBinding(db, held.relayId)?.pendingReply).toBeNull();
  });

  it('negative control: with no reply waiting, the later reply replaces the retried notice as before', async () => {
    const relay = legacyRelay();
    const held = await holdPromptNotice(relay.id, 'Proceed?', NOW + 500);
    expect(resolve(held, 'retry')).toMatchObject({ ok: true, requeued: true });
    seedReply('a later answer', NOW + 2_000);
    const { stashReplyForOpenRelays } = await import('@/lib/relay/relay-bound-reply');
    expect(stashReplyForOpenRelays(db, CODEX_WORKER, NOW + 2_100)).toBe(1);
    expect(getRelayPendingPayload(db, relay.id)).toMatchObject({ kind: 'reply', body: expect.stringContaining('a later answer') });
    expect(getRelayBinding(db, relay.id)?.pendingReply).toBeNull();
  });
});

describe('the relay the resolve answers with is read before the commit (Issue #4082)', () => {
  /** Fail only the full-row read of the relay (getRelayById), `times` times. */
  function failRelayRead(times: number): () => void {
    const original = db.prepare.bind(db);
    let left = times;
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (left > 0 && sql.includes('from_worktree_id, from_instance_id') && /WHERE id = \?\s*$/.test(sql)) {
        left -= 1;
        throw new Error('relay read refused');
      }
      return original(sql);
    }) as typeof db.prepare);
    return () => spy.mockRestore();
  }

  for (const action of ['confirm', 'retry', 'discard'] as const) {
    it(`${action}: a failing read answers an error and commits nothing; the same operation then succeeds`, async () => {
      const held = await heldRelay('reply');
      const before = snapshot(held.relayId);
      const restore = failRelayRead(1);
      try {
        expect(() => resolve(held, action)).toThrow('relay read refused');
      } finally {
        restore();
      }
      expect(snapshot(held.relayId)).toEqual(before);
      expect(resolve(held, action)).toMatchObject({ ok: true });
    });
  }

  it('through the route: 500, nothing committed, the pump not asked to send', async () => {
    const held = await heldRelay('reply');
    const before = snapshot(held.relayId);
    const { POST } = await import('@/app/api/relays/[relayId]/resolve/route');
    const restore = failRelayRead(1);
    let status: number;
    try {
      const request = new Request(`http://localhost/api/relays/${held.relayId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payloadId: held.payloadId, attemptId: held.attemptId, action: 'retry' }),
      });
      status = (await POST(request as unknown as NextRequest, { params: Promise.resolve({ relayId: held.relayId }) })).status;
    } finally {
      restore();
    }
    expect(status).toBe(500);
    expect(snapshot(held.relayId)).toEqual(before);
    await flush();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, held.relayId)?.deliveryHold?.state).toBe('uncertain');
  });
});
