/**
 * A relay delivery whose outcome is not known is never typed again (Issue #4064).
 *
 * `deliverOne` used to map every `!result.ok` but `prompt_waiting` to `failed`
 * and leave the payload queued, and a send that threw (after `sent`, or before
 * any state) left it queued too — so the next pump typed the same reply, prompt
 * notice or expiry notice into the requester's composer a second time. The
 * payload is now taken durably before the send (`attempting`), and a send whose
 * own attempt (`onAttempt`) is not `not-sent` is held as `uncertain`.
 *
 * Positive cases fail on the implementation before the fix (a second
 * `sendUserMessage`); the negative controls (not-sent, prompt_waiting, success)
 * pass both before and after.
 *
 * The database is a file under a fresh `fs.mkdtempSync(os.tmpdir())` directory,
 * removed in `afterEach`, so a "restart" reopens the same file.
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
  createRelay,
  getRelayBinding,
  getRelayById,
  getRelayPendingPayload,
  holdRelayPayloadDelivery,
  listRelaysWithPendingPayload,
  releaseRelayPayloadDelivery,
  stashRelayPayload,
} from '@/lib/db/relay-db';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import { withdrawRelay } from '@/lib/relay/relay-service';
import type { SendAttemptReason, SendAttemptState } from '@/lib/session/send-attempt-types';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const C = { worktreeId: 'wt-c', instanceId: 'gemini' };
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
  notifyRelayTurnCompleted,
  pumpRelayDeliveries,
  resetRelayDeliveryState,
  runRelayMaintenanceTick,
  sweepExpiredRelays,
} = await import('@/lib/relay/relay-delivery');

type Attempt = { state: SendAttemptState; reason: SendAttemptReason };
type SendParams = { content: string; onAttempt?: (attempt: Attempt) => void };

/** A send that reports `attempt` and then answers `result`. */
function sendReporting(attempt: Attempt, result: unknown) {
  return async (_db: unknown, params: SendParams) => {
    params.onAttempt?.(attempt);
    return result;
  };
}

/** A send that reports `attempt` (if any) and then throws. */
function sendThrowing(attempt: Attempt | null) {
  return async (_db: unknown, params: SendParams) => {
    if (attempt) params.onAttempt?.(attempt);
    throw new Error('history write failed');
  };
}

const OK = { ok: true, message: { id: 'm1' } };
const SEND_FAILED = { ok: false, stage: 'send', error: 'x' };
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

function legacyRelay(to = B, expiresAt = NOW + DAY_MS) {
  return createRelay(db, { from: A, to, hops: 1, expiresAt, now: NOW });
}

/** A relay carrying a payload of `kind`, ready for the pump. */
function relayWith(kind: 'reply' | 'prompt' | 'expired'): string {
  if (kind === 'expired') {
    const relay = legacyRelay(B, NOW - 1);
    expect(sweepExpiredRelays(db, NOW)).toBe(1);
    expect(getRelayPendingPayload(db, relay.id)?.kind).toBe('expired');
    return relay.id;
  }
  const relay = legacyRelay();
  expect(stashRelayPayload(db, relay.id, kind, `[from Codex] ${kind} body`, NOW)).toBe(true);
  return relay.id;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Pump a few times, the maintenance tick included. */
async function pumpRepeatedly(): Promise<void> {
  await pumpRelayDeliveries();
  await pumpRelayDeliveries();
  await runRelayMaintenanceTick();
  await pumpRelayDeliveries();
}

function deliveredBodies(): string[] {
  return sendUserMessage.mock.calls.map((call) => String((call[1] as SendParams).content));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-4064-'));
  dbPath = path.join(dir, 'cm.db');
  db = openDb();
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  insertWorktree('wt-c', 'gemini');
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

describe('path 1: an indeterminate send is held, not re-sent (Issue #4064)', () => {
  const kinds = ['reply', 'prompt', 'expired'] as const;
  const reasons: SendAttemptReason[] = ['prompt-unreported', 'submit-unconfirmed', 'send-error', 'composer-residue'];

  for (const kind of kinds) {
    for (const reason of reasons) {
      it(`${kind} / ${reason}: sendUserMessage is called once however often the pump runs`, async () => {
        const relayId = relayWith(kind);
        const before = getRelayPendingPayload(db, relayId);
        sendUserMessage.mockImplementation(sendReporting({ state: 'indeterminate', reason }, SEND_FAILED));

        await pumpRepeatedly();

        expect(sendUserMessage).toHaveBeenCalledTimes(1);
        expect(listRelaysWithPendingPayload(db)).toEqual([]);
        // The payload stays in its slot, readable, with its id and reason.
        const after = getRelayPendingPayload(db, relayId);
        expect(after).toMatchObject({ kind, body: before?.body, payloadId: before?.payloadId });
        expect(getRelayById(db, relayId)?.deliveryHold).toEqual({
          state: 'uncertain',
          payloadId: before?.payloadId,
          // Issue #4082: the attempt a resolve names (added field; the rest unchanged).
          attemptId: expect.any(String),
          kind,
          reason,
          at: expect.any(Number),
          checkCommand: 'commandmate capture wt-a --instance claude --pane',
        });
      });
    }
  }

  it('a reply held as uncertain leaves the relay open and undelivered', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(sendReporting({ state: 'indeterminate', reason: 'send-error' }, SEND_FAILED));
    await pumpRelayDeliveries();
    expect(getRelayById(db, relayId)).toMatchObject({ state: 'pending', deliveredAt: null });
  });

  it('a later completion of the same turn does not replace or re-queue the held reply', async () => {
    const relay = legacyRelay();
    seedReply('done', NOW + 1_000);
    sendUserMessage.mockImplementation(sendReporting({ state: 'indeterminate', reason: 'prompt-unreported' }, SEND_FAILED));
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await flush();
    await pumpRelayDeliveries();
    seedReply('done again', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await flush();
    await pumpRelayDeliveries();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relay.id)?.deliveryHold?.state).toBe('uncertain');
  });
});

describe('path 2: a send that throws is held, not re-sent (Issue #4064)', () => {
  for (const kind of ['reply', 'prompt', 'expired'] as const) {
    it(`${kind}: onAttempt(sent) then reject — called once`, async () => {
      const relayId = relayWith(kind);
      sendUserMessage.mockImplementation(sendThrowing(SENT_ATTEMPT));

      await pumpRepeatedly();

      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(getRelayById(db, relayId)?.deliveryHold).toMatchObject({ state: 'uncertain', reason: 'threw-after-sent' });
    });
  }

  it('a reject before any attempt was reported is held too (state unknown)', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(sendThrowing(null));

    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)?.deliveryHold).toMatchObject({ state: 'uncertain', reason: 'send-threw' });
  });

  it('the send succeeded but closing its attempt failed: never re-sent', async () => {
    const relayId = relayWith('prompt');
    db.exec(`CREATE TRIGGER refuse_attempt_close BEFORE UPDATE ON session_relays
      WHEN OLD.delivery_state = 'attempting' AND NEW.delivery_state IS NULL
      BEGIN SELECT RAISE(ABORT, 'attempt close refused'); END`);

    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)?.deliveryHold?.state).toBe('attempting');
  });

  it('a reply sent but whose attempt could not be closed keeps its body and payload id across a restart', async () => {
    const relayId = relayWith('reply');
    const before = getRelayPendingPayload(db, relayId);
    db.exec(`CREATE TRIGGER refuse_attempt_close BEFORE UPDATE ON session_relays
      WHEN OLD.delivery_state = 'attempting' AND NEW.delivery_state IS NULL
      BEGIN SELECT RAISE(ABORT, 'attempt close refused'); END`);

    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    // The relay's close rolled back with the attempt's end: still open, payload kept.
    const held = getRelayById(db, relayId);
    expect(held?.state).not.toBe('delivered');
    expect(held?.deliveryHold).toMatchObject({ state: 'attempting', kind: 'reply' });
    expect(held?.deliveryHold?.payloadId).toBeTruthy();
    const payloadId = held?.deliveryHold?.payloadId;

    // Restart: the interrupted attempt is labelled, still identifiable, not re-sent.
    db.exec('DROP TRIGGER refuse_attempt_close');
    db.close();
    resetRelayDeliveryState();
    resetRelayServerBootId();
    db = openDb();
    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)?.deliveryHold).toMatchObject({
      state: 'uncertain',
      kind: 'reply',
      payloadId,
      reason: 'server-restarted',
    });
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'reply', body: before?.body });
  });

  it('a reply sent but whose relay close the database refused keeps its hold, and a later completion does not capture it again', async () => {
    const relay = legacyRelay();
    seedReply('done', NOW + 1_000);
    db.exec(`CREATE TRIGGER refuse_relay_close BEFORE UPDATE ON session_relays
      WHEN NEW.state = 'delivered'
      BEGIN SELECT RAISE(ABORT, 'relay close refused'); END`);

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await flush();
    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const held = getRelayById(db, relay.id);
    expect(held?.state).not.toBe('delivered');
    expect(held?.deliveryHold).toMatchObject({ state: 'attempting', kind: 'reply' });
    const payloadId = held?.deliveryHold?.payloadId;
    expect(payloadId).toBeTruthy();
    expect(getRelayPendingPayload(db, relay.id)).toMatchObject({ kind: 'reply', body: expect.stringContaining('done') });

    // The next completion of B finds the slot still held: nothing new is captured or sent.
    seedReply('done again', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await flush();
    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relay.id)?.deliveryHold).toMatchObject({ state: 'attempting', kind: 'reply', payloadId });
    expect(getRelayPendingPayload(db, relay.id)?.body).not.toContain('done again');
  });

  it('negative control: a reply whose attempt closes is delivered once and leaves nothing held', async () => {
    const relayId = relayWith('reply');

    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const relay = getRelayById(db, relayId);
    expect(relay?.state).toBe('delivered');
    expect(relay?.deliveryHold).toBeNull();
    expect(getRelayPendingPayload(db, relayId)).toBeNull();
  });
});

describe('negative controls: what is retried and what is held stay as before', () => {
  for (const reason of ['prompt-not-ready', 'session-starting', 'input-lock-timeout'] as SendAttemptReason[]) {
    it(`not-sent (${reason}) is retried by the next pump`, async () => {
      const relayId = relayWith('reply');
      sendUserMessage.mockImplementationOnce(sendReporting({ state: 'not-sent', reason }, SEND_FAILED));

      await pumpRelayDeliveries();
      expect(getRelayById(db, relayId)?.deliveryHold).toBeNull();
      expect(listRelaysWithPendingPayload(db)).toHaveLength(1);
      await pumpRelayDeliveries();

      expect(sendUserMessage).toHaveBeenCalledTimes(2);
      expect(getRelayById(db, relayId)?.state).toBe('delivered');
    });
  }

  it('prompt_waiting is held (queued) and retried, not marked uncertain', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementationOnce(
      sendReporting({ state: 'not-sent', reason: 'prompt-waiting' }, { ok: false, stage: 'prompt_waiting', error: 'x' })
    );

    await pumpRelayDeliveries();
    expect(getRelayById(db, relayId)).toMatchObject({ state: 'pending', deliveryHold: null });
    expect(listRelaysWithPendingPayload(db)).toHaveLength(1);
    await pumpRelayDeliveries();

    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    expect(getRelayById(db, relayId)?.state).toBe('delivered');
  });

  it('a successful send is made once and leaves no hold', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(sendReporting(SENT_ATTEMPT, OK));
    await pumpRepeatedly();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)).toMatchObject({ state: 'delivered', deliveryHold: null });
  });

  it('another relay is delivered while one is held', async () => {
    const held = relayWith('reply');
    const other = legacyRelay(C);
    stashRelayPayload(db, other.id, 'reply', '[from Gemini] other', NOW + 5);
    sendUserMessage.mockImplementationOnce(sendReporting({ state: 'indeterminate', reason: 'send-error' }, SEND_FAILED));

    await pumpRepeatedly();

    expect(deliveredBodies()).toEqual(['[from Codex] reply body', '[from Gemini] other']);
    expect(getRelayById(db, held)?.deliveryHold?.state).toBe('uncertain');
    expect(getRelayById(db, other.id)?.state).toBe('delivered');
  });
});

describe('the durable claim before the send (Issue #4064)', () => {
  it('a claim the database refuses means no send', async () => {
    const relayId = relayWith('reply');
    db.exec(`CREATE TRIGGER refuse_claim BEFORE UPDATE ON session_relays
      WHEN NEW.delivery_state = 'attempting'
      BEGIN SELECT RAISE(ABORT, 'claim refused'); END`);

    await pumpRelayDeliveries();

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relayId)?.deliveryHold).toBeNull();
  });

  it('only one claim of a payload succeeds; a stale attempt cannot write the result', () => {
    const relayId = relayWith('reply');
    const current = getRelayPendingPayload(db, relayId);
    const claim = (attemptId: string) =>
      claimRelayPayloadDelivery(db, {
        relayId,
        payloadId: current?.payloadId ?? null,
        kind: 'reply',
        body: current?.body ?? '',
        attemptId,
        owner: 'boot-1',
        mintPayloadId: 'minted',
      });
    const payloadId = claim('attempt-1');
    expect(payloadId).toBe(current?.payloadId);
    expect(claim('attempt-2')).toBeNull();

    const stale = { relayId, payloadId: payloadId as string, attemptId: 'attempt-2' };
    expect(completeRelayPayloadDelivery(db, stale)).toBe(false);
    expect(releaseRelayPayloadDelivery(db, stale)).toBe(false);
    expect(holdRelayPayloadDelivery(db, { ...stale, reason: 'x' })).toBe(false);
    expect(getRelayPendingPayload(db, relayId)?.payloadId).toBe(payloadId);
    expect(getRelayById(db, relayId)?.deliveryHold?.state).toBe('attempting');
  });

  it('a payload stashed without an id (before v62) is delivered and gets an id for its hold', async () => {
    const relayId = relayWith('reply');
    db.prepare('UPDATE session_relays SET payload_id = NULL WHERE id = ?').run(relayId);
    sendUserMessage.mockImplementation(sendReporting({ state: 'indeterminate', reason: 'send-error' }, SEND_FAILED));

    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)?.deliveryHold?.payloadId).toEqual(expect.any(String));
  });

  it('a payload replaced while the readiness check awaited is not sent', async () => {
    const relayId = relayWith('reply');
    let release: (value: string | null) => void = () => {};
    findRelayHoldReason.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pump = pumpRelayDeliveries();
    await flush();
    // Same kind and body, a new payload id: only the id tells them apart.
    const body = getRelayPendingPayload(db, relayId)?.body as string;
    db.prepare("UPDATE session_relays SET payload_id = 'replaced' WHERE id = ?").run(relayId);
    release(null);
    await pump;

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ body, payloadId: 'replaced' });
  });
});

describe('the two slots while a prompt notice is uncertain (Issue #4064)', () => {
  it('a reply that finishes after the notice was held waits in the second slot, undelivered', async () => {
    const relayId = relayWith('prompt');
    const notice = getRelayPendingPayload(db, relayId);
    sendUserMessage.mockImplementation(sendReporting({ state: 'indeterminate', reason: 'prompt-unreported' }, SEND_FAILED));
    await pumpRelayDeliveries();

    seedReply('finished', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await flush();
    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'prompt', payloadId: notice?.payloadId });
    expect(getRelayBinding(db, relayId)?.pendingReply?.body).toContain('finished');
  });

  it('a reply that finished while the notice was being typed is not promoted over it', async () => {
    const relayId = relayWith('prompt');
    let release: (value: unknown) => void = () => {};
    sendUserMessage.mockImplementationOnce(
      (_db: unknown, params: SendParams) =>
        new Promise((resolve) => {
          release = (value) => {
            params.onAttempt?.({ state: 'indeterminate', reason: 'submit-unconfirmed' });
            resolve(value);
          };
        })
    );
    const pump = pumpRelayDeliveries();
    await flush();
    seedReply('finished', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    expect(getRelayBinding(db, relayId)?.pendingReply).not.toBeNull();
    release(SEND_FAILED);
    await pump;
    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayPendingPayload(db, relayId)?.kind).toBe('prompt');
    expect(getRelayBinding(db, relayId)?.pendingReply).not.toBeNull();
  });

  it('negative control: a not-sent notice is still replaced by the waiting reply, which goes out', async () => {
    const relayId = relayWith('prompt');
    let release: (value: unknown) => void = () => {};
    sendUserMessage.mockImplementationOnce(
      (_db: unknown, params: SendParams) =>
        new Promise((resolve) => {
          release = (value) => {
            params.onAttempt?.({ state: 'not-sent', reason: 'prompt-not-ready' });
            resolve(value);
          };
        })
    );
    const pump = pumpRelayDeliveries();
    await flush();
    seedReply('finished', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    release(SEND_FAILED);
    await pump;
    await pumpRelayDeliveries();

    const bodies = deliveredBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('finished');
    expect(getRelayById(db, relayId)?.state).toBe('delivered');
  });
});

describe('expiry and cancel keep a held payload readable (Issue #4064)', () => {
  it('the sweep closes the relay, keeps the held reply, and queues no expiry notice', async () => {
    const relay = legacyRelay(B, NOW + 10);
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] reply body', NOW);
    const before = getRelayPendingPayload(db, relay.id);
    sendUserMessage.mockImplementation(sendReporting({ state: 'indeterminate', reason: 'send-error' }, SEND_FAILED));
    await pumpRelayDeliveries();

    expect(sweepExpiredRelays(db, NOW + 20)).toBe(1);
    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relay.id)).toMatchObject({
      state: 'expired',
      deliveryHold: { state: 'uncertain', payloadId: before?.payloadId, kind: 'reply', reason: 'send-error' },
    });
    expect(getRelayPendingPayload(db, relay.id)).toMatchObject({ kind: 'reply', body: before?.body });
  });

  it('negative control: a queued payload is still superseded by the expiry notice, sent once', async () => {
    const relay = legacyRelay(B, NOW + 10);
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] reply body', NOW);
    findRelayHoldReason.mockResolvedValue('generating');
    await pumpRelayDeliveries();
    findRelayHoldReason.mockResolvedValue(null);

    expect(sweepExpiredRelays(db, NOW + 20)).toBe(1);
    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(deliveredBodies()[0]).not.toContain('reply body');
    expect(getRelayById(db, relay.id)).toMatchObject({ state: 'expired', deliveryHold: null, pendingKind: null });
  });

  it('a cancel succeeds, stops later deliveries, and keeps the held payload', async () => {
    const relayId = relayWith('prompt');
    sendUserMessage.mockImplementation(sendReporting({ state: 'indeterminate', reason: 'send-error' }, SEND_FAILED));
    await pumpRelayDeliveries();

    expect(withdrawRelay(db, relayId, NOW + 5).ok).toBe(true);
    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)).toMatchObject({
      state: 'cancelled',
      deliveryHold: { state: 'uncertain', kind: 'prompt' },
    });
  });

  it('an expiry notice that is itself uncertain is held, not re-sent', async () => {
    const relayId = relayWith('expired');
    sendUserMessage.mockImplementation(sendReporting({ state: 'indeterminate', reason: 'submit-unconfirmed' }, SEND_FAILED));
    await pumpRepeatedly();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)?.deliveryHold).toMatchObject({ kind: 'expired', reason: 'submit-unconfirmed' });
  });
});

describe('a restart in the middle of a send (Issue #4064)', () => {
  /** Park a send forever, then "restart": new boot, same database file. */
  async function crashMidSend(): Promise<void> {
    sendUserMessage.mockImplementationOnce(() => new Promise(() => {}));
    void pumpRelayDeliveries();
    await flush();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    db.close();
    resetRelayDeliveryState();
    resetRelayServerBootId();
    db = openDb();
  }

  for (const kind of ['reply', 'prompt', 'expired'] as const) {
    it(`${kind}: the interrupted attempt is held as uncertain and not re-sent`, async () => {
      const relayId = relayWith(kind);
      await crashMidSend();

      await pumpRepeatedly();

      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(getRelayById(db, relayId)?.deliveryHold).toMatchObject({
        state: 'uncertain',
        kind,
        reason: 'server-restarted',
      });
    });
  }

  it('a bound relay is held the same way, and its recovery does not promote a waiting reply', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW, bindMode: 'bound' });
    db.prepare("UPDATE session_relays SET send_state = 'sent' WHERE id = ?").run(relay.id);
    stashRelayPayload(db, relay.id, 'prompt', '[from Codex] waiting', NOW);
    await crashMidSend();
    db.prepare(
      `UPDATE session_relays SET pending_reply = ? WHERE id = ?`
    ).run(JSON.stringify({ candidateId: 'c1', body: 'reply', overlap: 'none', basis: 'x', payloadId: 'p2' }), relay.id);

    await pumpRepeatedly();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayPendingPayload(db, relay.id)?.kind).toBe('prompt');
    expect(getRelayById(db, relay.id)?.deliveryHold?.reason).toBe('server-restarted');
  });

  it('negative control: a queued payload (never claimed) is delivered after a restart', async () => {
    const relayId = relayWith('reply');
    db.close();
    resetRelayDeliveryState();
    resetRelayServerBootId();
    db = openDb();

    await pumpRelayDeliveries();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)?.state).toBe('delivered');
  });
});

describe('the hold is readable on the public relay reads (Issue #4064)', () => {
  async function getRelays(query: string): Promise<Record<string, unknown>> {
    const { GET } = await import('@/app/api/relays/route');
    const response = await GET(new Request(`http://localhost/api/relays${query}`) as unknown as NextRequest);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it('GET /api/relays lists the held relay (even after it closed) with the payload id, reason and pane', async () => {
    const relayId = relayWith('reply');
    const payloadId = getRelayPendingPayload(db, relayId)?.payloadId;
    sendUserMessage.mockImplementation(sendReporting({ state: 'indeterminate', reason: 'prompt-unreported' }, SEND_FAILED));
    await pumpRelayDeliveries();
    expect(withdrawRelay(db, relayId, NOW + 5).ok).toBe(true);

    const body = await getRelays('?worktree=wt-a&instance=claude');

    expect(body.awaiting).toEqual([]);
    expect(body.held).toEqual([
      expect.objectContaining({
        id: relayId,
        state: 'cancelled',
        deliveryHold: expect.objectContaining({
          payloadId,
          reason: 'prompt-unreported',
          checkCommand: 'commandmate capture wt-a --instance claude --pane',
        }),
      }),
    ]);
  });

  it('GET /api/relays/:id carries the hold', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(sendThrowing(SENT_ATTEMPT));
    await pumpRelayDeliveries();
    const { GET } = await import('@/app/api/relays/[relayId]/route');
    const response = await GET(new Request(`http://localhost/api/relays/${relayId}`) as unknown as NextRequest, {
      params: Promise.resolve({ relayId }),
    });
    const body = (await response.json()) as { relay: { deliveryHold: unknown } };
    expect(body.relay.deliveryHold).toMatchObject({ state: 'uncertain', reason: 'threw-after-sent' });
  });

  it('negative control: nothing is listed as held when no delivery is held', async () => {
    relayWith('reply');
    expect((await getRelays('?worktree=wt-a&instance=claude')).held).toEqual([]);
  });
});
