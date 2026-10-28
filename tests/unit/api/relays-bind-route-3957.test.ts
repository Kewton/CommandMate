/**
 * The relay ledger's binding surface (Issue #3957, PR 2).
 *
 * - `POST /api/relays` with `bind: true` opens a bound relay and says so in
 *   `bindMode`; without it the relay is legacy, as every relay was before.
 * - `GET /api/relays/:id` reads one relay, closed ones included.
 * - The ledger statements the send route relies on: one reservation per relay,
 *   writes only under the attempt's token, never a closed relay moved back,
 *   held candidates kept in arrival order.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  appendRelayHeldCandidate,
  cancelRelay,
  createRelay,
  explainRelayBindRefusal,
  getRelayBinding,
  getRelayById,
  markRelayDelivered,
  recordRelayInputBoundary,
  reserveRelayBind,
  settleRelaySendState,
} from '@/lib/db/relay-db';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
  };
});

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
let db: Database.Database;

const asReq = (req: Request) => req as unknown as NextRequest;

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    id,
    `/tmp/${id}`,
    cliToolId,
    NOW
  );
}

function bound(expiresAt = NOW + DAY_MS) {
  return createRelay(db, { from: A, to: B, hops: 1, expiresAt, now: NOW, bindMode: 'bound' });
}

const reserve = (relayId: string, attemptId: string, to = B, now = NOW + 1) =>
  reserveRelayBind(db, { relayId, attemptId, owner: 'boot-1', worktreeId: to.worktreeId, instanceId: to.instanceId, now });

const boundary = (relayId: string, attemptId: string, replaceDispatch = false, at = NOW + 2) =>
  recordRelayInputBoundary(db, {
    relayId,
    attemptId,
    at,
    kind: 'input_start',
    turnOpenAtSend: false,
    obsState: 'valid',
    obsSource: 'boot-1#-',
    replaceDispatch,
    now: NOW + 2,
  });

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  const dbInstance = await import('@/lib/db/db-instance');
  dbInstance.setMockDb(db);
});

afterEach(() => {
  if (db.open) db.close();
});

describe('POST /api/relays: bind (Issue #3957)', () => {
  async function postRelay(body: unknown) {
    const { POST } = await import('@/app/api/relays/route');
    return POST(
      asReq(
        new Request('http://localhost/api/relays', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      )
    );
  }

  it('bind: true opens a bound relay, awaiting its send', async () => {
    const response = await postRelay({ from: A, to: B, bind: true });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.bindMode).toBe('bound');
    expect(body.relay).toMatchObject({ bindMode: 'bound', sendState: 'awaiting' });
  });

  it('negative control: without bind the relay is legacy with no send state', async () => {
    const body = await (await postRelay({ from: A, to: B })).json();
    expect(body.bindMode).toBe('legacy');
    expect(body.relay).toMatchObject({ bindMode: 'legacy', sendState: null });
  });
});

describe('GET /api/relays/:relayId (Issue #3957)', () => {
  async function getRelay(relayId: string) {
    const { GET } = await import('@/app/api/relays/[relayId]/route');
    return GET(asReq(new Request(`http://localhost/api/relays/${relayId}`)), {
      params: Promise.resolve({ relayId }),
    });
  }

  it('reads a closed relay too, with its overlap', async () => {
    const relay = bound();
    db.prepare("UPDATE session_relays SET overlap = 'later' WHERE id = ?").run(relay.id);
    markRelayDelivered(db, relay.id, `relay:${relay.id}`, NOW + 5);
    const response = await getRelay(relay.id);
    expect(response.status).toBe(200);
    expect((await response.json()).relay).toMatchObject({ id: relay.id, state: 'delivered', overlap: 'later' });
  });

  it('400 for a malformed id, 404 for an unknown one', async () => {
    expect((await getRelay('nope')).status).toBe(400);
    expect((await getRelay('11111111-2222-4333-8444-555555555555')).status).toBe(404);
  });
});

describe('the binding statements', () => {
  it('reserves a relay once: a second attempt is refused, and explained as a conflict', () => {
    const relay = bound();
    expect(reserve(relay.id, 'att-1')).toBe(true);
    expect(reserve(relay.id, 'att-2')).toBe(false);
    expect(explainRelayBindRefusal(db, relay.id, B.worktreeId, B.instanceId, NOW + 1)).toMatchObject({
      status: 409,
      code: 'RELAY_BIND_CONFLICT',
    });
    expect(getRelayBinding(db, relay.id)).toMatchObject({ bindAttemptId: 'att-1', bindOwner: 'boot-1' });
  });

  it('refuses another destination (400), an expired relay (409) and a legacy one (400)', () => {
    const relay = bound();
    const elsewhere = { worktreeId: 'wt-b', instanceId: 'codex-2' };
    expect(reserve(relay.id, 'att', elsewhere)).toBe(false);
    expect(explainRelayBindRefusal(db, relay.id, elsewhere.worktreeId, elsewhere.instanceId)).toMatchObject({ status: 400 });

    const expired = bound(NOW + 10);
    expect(reserve(expired.id, 'att', B, NOW + 10)).toBe(false);
    expect(explainRelayBindRefusal(db, expired.id, B.worktreeId, B.instanceId, NOW + 10)).toMatchObject({ status: 409 });

    const legacy = createRelay(db, { from: A, to: { worktreeId: 'wt-b', instanceId: 'codex-3' }, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    expect(reserveRelayBind(db, { relayId: legacy.id, attemptId: 'att', owner: 'b', worktreeId: 'wt-b', instanceId: 'codex-3', now: NOW + 1 })).toBe(false);
    expect(explainRelayBindRefusal(db, legacy.id, 'wt-b', 'codex-3')).toMatchObject({ status: 400 });
  });

  it('records the boundary only under the reserving token, once', () => {
    const relay = bound();
    reserve(relay.id, 'att-1');
    expect(boundary(relay.id, 'att-other')).toBe(false);
    expect(boundary(relay.id, 'att-1')).toBe(true);
    expect(boundary(relay.id, 'att-1')).toBe(false);
    expect(getRelayById(db, relay.id)).toMatchObject({ sendState: 'input_started', inputBoundaryAt: NOW + 2 });
  });

  it('does not record a boundary on a relay cancelled after the reservation', () => {
    const relay = bound();
    reserve(relay.id, 'att-1');
    cancelRelay(db, relay.id, NOW + 1);
    expect(boundary(relay.id, 'att-1')).toBe(false);
  });

  it('never moves a cancelled relay back to sent', () => {
    const relay = bound();
    reserve(relay.id, 'att-1');
    boundary(relay.id, 'att-1');
    cancelRelay(db, relay.id, NOW + 3);
    expect(
      settleRelaySendState(db, { relayId: relay.id, attemptId: 'att-1', from: ['input_started'], to: 'sent' })
    ).toBe(false);
    expect(getRelayById(db, relay.id)).toMatchObject({ state: 'cancelled', sendState: 'input_started' });
  });

  it('keeps held candidates in arrival order and never twice', () => {
    const relay = bound();
    const c1 = { messageId: 'm1', timestamp: NOW + 10, requestId: null };
    const c2 = { messageId: 'm2', timestamp: NOW + 20, requestId: null };
    expect(appendRelayHeldCandidate(db, relay.id, c1)).toBe(true);
    expect(appendRelayHeldCandidate(db, relay.id, c2)).toBe(true);
    expect(appendRelayHeldCandidate(db, relay.id, c1)).toBe(false);
    expect(getRelayBinding(db, relay.id)?.heldCandidates.map((c) => c.messageId)).toEqual(['m1', 'm2']);
  });
});
