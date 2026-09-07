/**
 * API Route tests — the relay ledger (Issue #2377).
 *
 * - GET  /api/relays
 * - POST /api/relays
 * - POST /api/relays/:relayId/cancel
 *
 * The loop guard is NOT mocked: the whole point of putting it behind the route
 * is that its input is `chat_messages`, which no CLI can read, and a mocked
 * policy would leave that seam untested. What IS mocked is the socket, because
 * opening a relay writes a system row and publishes it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, relayRequestId } from '@/lib/db/chat-db';
import { createRelay, getRelayById, markRelayDelivered } from '@/lib/db/relay-db';

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
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
let db: Database.Database;

const asReq = (req: Request) => req as unknown as NextRequest;

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

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

async function getRelays(query = '') {
  const { GET } = await import('@/app/api/relays/route');
  return GET(asReq(new Request(`http://localhost/api/relays${query}`)));
}

async function cancelRelayRoute(relayId: string) {
  const { POST } = await import('@/app/api/relays/[relayId]/cancel/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/relays/${relayId}/cancel`, { method: 'POST' })
    ),
    { params: Promise.resolve({ relayId }) }
  );
}

const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

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
  vi.clearAllMocks();
});

describe('POST /api/relays', () => {
  it('creates a pending relay and answers 201', async () => {
    const response = await postRelay({ from: A, to: B });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.relay.state).toBe('pending');
    expect(body.relay.from).toEqual(A);
    expect(body.relay.to).toEqual(B);
    expect(getRelayById(db, body.relay.id)).not.toBeNull();
  });

  it('rejects a body with no endpoints', async () => {
    const response = await postRelay({});

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('from.worktreeId');
  });

  it('rejects an instance id that could reach a shell', async () => {
    const response = await postRelay({
      from: { worktreeId: 'wt-a', instanceId: 'claude; rm -rf /' },
      to: B,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('instanceId');
  });

  it('answers 404 for a worktree that does not exist', async () => {
    const response = await postRelay({ from: A, to: { ...B, worktreeId: 'wt-nope' } });

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('RELAY_WORKTREE_NOT_FOUND');
  });

  it('answers 409 with a stable code when a chain is refused', async () => {
    // Put wt-a in the position of answering a relayed message.
    const parent = createRelay(db, {
      from: B,
      to: A,
      hops: 1,
      expiresAt: NOW + DAY_MS,
      now: NOW,
    });
    createMessage(db, {
      worktreeId: 'wt-a',
      role: 'user',
      content: '[from Codex / wt-b] please do this',
      messageType: 'relay',
      timestamp: new Date(NOW),
      requestId: relayRequestId(parent.id),
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    const response = await postRelay({ from: A, to: B });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('RELAY_CHAIN_BLOCKED');
  });

  it('lets the chain through with allowRelayChain', async () => {
    const parent = createRelay(db, {
      from: B,
      to: A,
      hops: 1,
      expiresAt: NOW + DAY_MS,
      now: NOW,
    });
    createMessage(db, {
      worktreeId: 'wt-a',
      role: 'user',
      content: '[from Codex / wt-b] please do this',
      messageType: 'relay',
      timestamp: new Date(NOW),
      requestId: relayRequestId(parent.id),
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    const response = await postRelay({ from: A, to: B, allowRelayChain: true });

    expect(response.status).toBe(201);
    expect((await response.json()).relay.hops).toBe(2);
  });

  it('answers 409 for a second open relay in the same direction', async () => {
    expect((await postRelay({ from: A, to: B })).status).toBe(201);

    const response = await postRelay({ from: A, to: B });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('RELAY_DUPLICATE_PENDING');
  });

  it('clamps an absurd ttl rather than refusing it', async () => {
    const response = await postRelay({ from: A, to: B, ttlMs: Number.MAX_SAFE_INTEGER });

    expect(response.status).toBe(201);
    const { relay } = await response.json();
    expect(relay.expiresAt - relay.createdAt).toBe(7 * DAY_MS);
  });
});

describe('GET /api/relays', () => {
  it('separates a session\'s two sides', async () => {
    await postRelay({ from: A, to: B });
    await postRelay({ from: B, to: A });

    const response = await getRelays('?worktree=wt-a&instance=claude');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.awaiting).toHaveLength(1);
    expect(body.owed).toHaveLength(1);
    expect(body.open).toHaveLength(2);
  });

  it('lists a worktree without naming an instance', async () => {
    await postRelay({ from: A, to: B });

    const body = await (await getRelays('?worktree=wt-a')).json();

    expect(body.open).toHaveLength(1);
    // The two-sided view is only meaningful for one session.
    expect(body.owed).toEqual([]);
    expect(body.awaiting).toEqual([]);
  });

  it('counts every state', async () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    markRelayDelivered(db, relay.id, relayRequestId(relay.id), NOW);

    const body = await (await getRelays()).json();

    expect(body.counts).toEqual({
      pending: 0,
      delivered: 1,
      prompt: 0,
      expired: 0,
      cancelled: 0,
    });
  });

  it('rejects a days window outside the supported range', async () => {
    expect((await getRelays('?days=0')).status).toBe(400);
    expect((await getRelays('?days=999')).status).toBe(400);
    expect((await getRelays('?days=7')).status).toBe(200);
  });

  it('rejects an instance parameter that could reach a shell', async () => {
    expect((await getRelays('?worktree=wt-a&instance=a;b')).status).toBe(400);
  });
});

describe('POST /api/relays/:relayId/cancel', () => {
  it('cancels an open relay', async () => {
    const { relay } = await (await postRelay({ from: A, to: B })).json();

    const response = await cancelRelayRoute(relay.id);

    expect(response.status).toBe(200);
    expect((await response.json()).relay.state).toBe('cancelled');
    expect(getRelayById(db, relay.id)?.state).toBe('cancelled');
  });

  it('rejects an id that was never a relay id', async () => {
    expect((await cancelRelayRoute('not-a-uuid')).status).toBe(400);
  });

  it('answers 404 for a relay nobody has heard of', async () => {
    const response = await cancelRelayRoute('11111111-2222-4333-8444-555555555555');

    expect(response.status).toBe(404);
  });

  it('refuses to report a delivered relay as cancelled', async () => {
    const { relay } = await (await postRelay({ from: A, to: B })).json();
    markRelayDelivered(db, relay.id, relayRequestId(relay.id), NOW);

    const response = await cancelRelayRoute(relay.id);

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('RELAY_ALREADY_CLOSED');
  });
});
