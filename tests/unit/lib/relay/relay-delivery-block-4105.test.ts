/**
 * Why the last delivery attempt stopped is readable (Issue #4105).
 *
 * While the requester A shows a confirmation dialog the pump's send is refused
 * (`prompt_waiting`) every tick, and nothing said so: the relay read like one
 * simply queued. The pump now keeps, in the process, what the LAST attempt of
 * the CURRENT payload stopped for, and the relay APIs attach it as
 * `lastDeliveryBlock`.
 *
 * Driven through the real pump, the real ledger (a file DB under
 * `fs.mkdtempSync(os.tmpdir())`, removed in `afterEach`) and the real route
 * handlers; only the send and the readiness probe are stubbed. Positive cases
 * fail before the fix (no field at all); the negative controls — success,
 * uncertain, counts, the send path's single GET — hold before and after.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  countHeldRelays,
  countRelays,
  createRelay,
  getRelayById,
  getRelayPendingPayload,
  stashRelayPayload,
} from '@/lib/db/relay-db';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import { withdrawRelay } from '@/lib/relay/relay-service';
import type { SendAttemptReason, SendAttemptState } from '@/lib/session/send-attempt-types';
import type { SessionRelay } from '@/lib/relay/types';

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

let dir: string;
let db: Database.Database;

const sendUserMessage = vi.fn();
const findRelayHoldReason = vi.fn();
const releaseFails = vi.hoisted(() => ({ on: false }));

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({
  findRelayHoldReason: (...args: unknown[]) => findRelayHoldReason(...args),
}));
vi.mock('@/lib/db/relay-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/relay-db')>();
  return {
    ...actual,
    releaseRelayPayloadDelivery: (...args: Parameters<typeof actual.releaseRelayPayloadDelivery>) => {
      if (releaseFails.on) throw new Error('database is locked');
      return actual.releaseRelayPayloadDelivery(...args);
    },
  };
});

const { pumpRelayDeliveries, resetRelayDeliveryState, sweepExpiredRelays } = await import(
  '@/lib/relay/relay-delivery'
);
const { GET: listRoute } = await import('@/app/api/relays/route');
const { GET: oneRoute } = await import('@/app/api/relays/[relayId]/route');

type Attempt = { state: SendAttemptState; reason: SendAttemptReason };
type SendParams = { content: string; onAttempt?: (attempt: Attempt) => void };

function sendReporting(attempt: Attempt, result: unknown) {
  return async (_db: unknown, params: SendParams) => {
    params.onAttempt?.(attempt);
    return result;
  };
}

const OK = { ok: true, message: { id: 'm1' } };
const PROMPT_WAITING = sendReporting(
  { state: 'not-sent', reason: 'prompt-waiting' },
  { ok: false, stage: 'prompt_waiting', error: 'prompt open' }
);

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

function relayWith(kind: 'reply' | 'prompt', body = `[from Codex] ${kind} body`): string {
  const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
  expect(stashRelayPayload(db, relay.id, kind, body, NOW)).toBe(true);
  return relay.id;
}

interface ListAnswer {
  owed: SessionRelay[];
  awaiting: SessionRelay[];
  open: SessionRelay[];
  held: SessionRelay[];
  counts: Record<string, number>;
  heldCount: number;
}

async function readList(query = 'worktree=wt-a&instance=claude'): Promise<ListAnswer> {
  const response = await listRoute(new NextRequest(`http://localhost/api/relays?${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as ListAnswer;
}

async function readOne(relayId: string): Promise<SessionRelay> {
  const response = await oneRoute(new NextRequest(`http://localhost/api/relays/${relayId}`), {
    params: Promise.resolve({ relayId }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { relay: SessionRelay }).relay;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-4105-'));
  db = new Database(path.join(dir, 'cm.db'));
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  resetRelayDeliveryState();
  resetRelayServerBootId();
  releaseFails.on = false;
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

describe('the requester dialog refuses the delivery (Issue #4105)', () => {
  it('every reader sees prompt_waiting, tied to the payload and its time (positive)', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    const before = Date.now();

    await pumpRelayDeliveries();

    const payload = getRelayPendingPayload(db, relayId);
    expect(payload?.kind).toBe('reply');
    const expected = {
      reason: 'prompt_waiting',
      kind: 'reply',
      payloadId: payload?.payloadId,
      observedAt: expect.any(Number),
    };
    const list = await readList();
    for (const field of ['awaiting', 'open'] as const) {
      const row = list[field].find((relay) => relay.id === relayId);
      expect(row?.lastDeliveryBlock, field).toEqual(expected);
      expect(row?.lastDeliveryBlock?.observedAt).toBeGreaterThanOrEqual(before);
    }
    // The worker's side (`owed`) reads the same relay the same way.
    const owed = await readList('worktree=wt-b&instance=codex');
    expect(owed.owed.find((relay) => relay.id === relayId)?.lastDeliveryBlock).toEqual(expected);
    expect((await readOne(relayId)).lastDeliveryBlock).toEqual(expected);
  });

  it('changes no ledger axis: payload kept, not held, counts and heldCount unchanged (negative)', async () => {
    const relayId = relayWith('reply');
    const countsBefore = countRelays(db, {});
    sendUserMessage.mockImplementation(PROMPT_WAITING);

    await pumpRelayDeliveries();
    await pumpRelayDeliveries();

    const relay = getRelayById(db, relayId);
    expect(relay).toMatchObject({ state: 'pending', deliveryHold: null, holdReason: null, pendingKind: 'reply' });
    expect(countRelays(db, {})).toEqual(countsBefore);
    expect(countHeldRelays(db, {})).toBe(0);
    const list = await readList();
    expect(list.heldCount).toBe(0);
    expect(list.held).toEqual([]);
    // Each refused attempt is one send call that typed nothing (the send path's own refusal).
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('is cleared once the dialog is closed and the next pass delivers', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    expect((await readOne(relayId)).lastDeliveryBlock?.reason).toBe('prompt_waiting');

    sendUserMessage.mockReset();
    sendUserMessage.mockResolvedValue(OK);
    await pumpRelayDeliveries();

    const after = await readOne(relayId);
    expect(after.state).toBe('delivered');
    expect(after.lastDeliveryBlock).toBeNull();
  });

  it('follows the requester into another reason (generating) rather than keeping the dialog', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    findRelayHoldReason.mockResolvedValue('generating');
    await pumpRelayDeliveries();

    expect((await readOne(relayId)).lastDeliveryBlock?.reason).toBe('generating');
  });

  it('a send refused for another not-sent reason clears it (no stale dialog)', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    sendUserMessage.mockImplementation(
      sendReporting({ state: 'not-sent', reason: 'prompt-not-ready' }, { ok: false, stage: 'send', error: 'x' })
    );
    await pumpRelayDeliveries();

    expect((await readOne(relayId)).lastDeliveryBlock).toBeNull();
  });

  it('a restart forgets it: null, which is not "deliverable"', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    resetRelayDeliveryState();

    const relay = await readOne(relayId);
    expect(relay.lastDeliveryBlock).toBeNull();
    expect(relay.pendingKind).toBe('reply');
  });

  it('a requeue that failed leaves `attempting` and is not shown as waiting for the dialog', async () => {
    const relayId = relayWith('reply');
    releaseFails.on = true;
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();

    const relay = await readOne(relayId);
    expect(relay.deliveryHold?.state).toBe('attempting');
    expect(relay.lastDeliveryBlock).toBeNull();
  });

  it('an uncertain send is not relabelled (negative control)', async () => {
    const relayId = relayWith('reply');
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    sendUserMessage.mockImplementation(
      sendReporting({ state: 'indeterminate', reason: 'send-error' }, { ok: false, stage: 'send', error: 'x' })
    );
    await pumpRelayDeliveries();

    const relay = await readOne(relayId);
    expect(relay.deliveryHold?.state).toBe('uncertain');
    expect(relay.lastDeliveryBlock).toBeNull();
    expect((await readList()).heldCount).toBe(1);
  });
});

describe('the payload the observation is for (Issue #4105)', () => {
  it('a cancel while the readiness read is pending: the late result labels nothing', async () => {
    const relayId = relayWith('reply');
    let release: (reason: string) => void = () => {};
    findRelayHoldReason.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      })
    );
    const pump = pumpRelayDeliveries();
    await new Promise((resolve) => setImmediate(resolve));
    expect(withdrawRelay(db, relayId).ok).toBe(true);
    release('generating');
    await pump;

    expect((await readOne(relayId)).lastDeliveryBlock).toBeNull();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('a payload replaced while the readiness read is pending: the new payload carries no old reason', async () => {
    const relayId = relayWith('prompt');
    let release: (reason: string) => void = () => {};
    findRelayHoldReason.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      })
    );
    const pump = pumpRelayDeliveries();
    await new Promise((resolve) => setImmediate(resolve));
    db.prepare(`UPDATE session_relays SET pending_kind = 'reply', pending_body = 'new', payload_id = 'p-new' WHERE id = ?`).run(relayId);
    release('generating');
    await pump;

    expect((await readOne(relayId)).lastDeliveryBlock).toBeNull();
  });

  it('a recorded reason disappears when the payload is replaced afterwards', async () => {
    const relayId = relayWith('prompt');
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    expect((await readOne(relayId)).lastDeliveryBlock).toMatchObject({ reason: 'prompt_waiting', kind: 'prompt' });

    db.prepare(`UPDATE session_relays SET pending_kind = 'reply', pending_body = 'new', payload_id = 'p-new' WHERE id = ?`).run(relayId);

    expect((await readOne(relayId)).lastDeliveryBlock).toBeNull();
  });

  it('the expiry notice of a closed relay carries its own observation', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW - 1, now: NOW - DAY_MS });
    expect(sweepExpiredRelays(db, NOW)).toBe(1);
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();

    const one = await readOne(relay.id);
    expect(one.state).toBe('expired');
    expect(one.lastDeliveryBlock).toMatchObject({ reason: 'prompt_waiting', kind: 'expired' });
  });
});
