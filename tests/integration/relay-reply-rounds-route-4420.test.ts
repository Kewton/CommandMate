/**
 * Issue #4420 through the real route: `POST /api/relays` → `openRelay`.
 *
 * - after the reply to A's own relay, the next relay is created (201, depth 1);
 * - after `MAX_RELAY_ROUNDS` replies within `RELAY_ROUNDS_WINDOW_MS` it is
 *   refused (409, `RELAY_HOPS_EXCEEDED`, the round-trip sentence), with or
 *   without `allowRelayChain` — and the refusal leaves nothing behind: no relay
 *   row, no chat row, no keystroke to tmux;
 * - once the clock has moved past the window, the same request is created
 *   (201) — waiting is the way out (案 Q, known limit Q-11).
 *
 * The clock is `Date` faked (`toFake: ['Date']`, timers stay real): the route
 * reads `Date.now()` for the window, as in production.
 *
 * The loop guard and the policy are not mocked. The database is a real file
 * under `os.tmpdir()` (removed after each test); the socket is mocked because
 * opening a relay publishes its line.
 *
 * What proves "nothing was sent" is the row counts: no `session_relays` row and
 * no `chat_messages` row (a send writes its user row). The tmux spy is a
 * supplementary check only — this route never reaches tmux on any path, so its
 * zero says little on its own; the CLI's own `/send` after a refusal is covered
 * by the CLI suites (`registerRelay` exits 2 before sending).
 *
 * @vitest-environment node
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmuxCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const spied: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    spied[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => {
            tmuxCalls.count += 1;
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return spied;
});

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

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

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, relayRequestId } from '@/lib/db/chat-db';
import { markRelayDelivered } from '@/lib/db/relay-db';
import { MAX_RELAY_ROUNDS, RELAY_ROUNDS_WINDOW_MS } from '@/lib/relay/relay-policy';

const NOW = Date.parse('2026-11-19T03:00:00.000Z');
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

let tmpDir: string;
let db: Database.Database;

function advance(ms: number): number {
  vi.setSystemTime(Date.now() + ms);
  return Date.now();
}

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  module.setMockDb(value);
}

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, path.join(tmpDir, id), cliToolId, NOW);
}

async function postRelay(body: unknown): Promise<Response> {
  const { POST } = await import('@/app/api/relays/route');
  return POST(
    new Request('http://localhost/api/relays', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );
}

/** Open A→B through the route and land B's reply in A's history, as `deliverOne` does. */
async function roundTrip(n: number): Promise<void> {
  const response = await postRelay({ from: A, to: B });
  expect(response.status).toBe(201);
  const { relay } = (await response.json()) as { relay: { id: string } };
  const clock = advance(1_000);
  createMessage(db, {
    worktreeId: 'wt-a',
    role: 'user',
    content: `[from Codex / wt-b] answer ${n}`,
    messageType: 'relay',
    timestamp: new Date(clock),
    requestId: relayRequestId(relay.id),
    cliToolId: 'claude',
    instanceId: 'claude',
  });
  markRelayDelivered(db, relay.id, relayRequestId(relay.id), clock);
}

function count(table: 'session_relays' | 'chat_messages'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rounds-4420-'));
  db = new Database(path.join(tmpDir, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  tmuxCalls.count = 0;
  await setMockDb(db);
});

afterEach(async () => {
  await setMockDb(null);
  vi.useRealTimers();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/relays after replies to my own relays (#4420)', () => {
  it('creates the next relay at depth 1 once the reply has landed', async () => {
    await roundTrip(1);

    const response = await postRelay({ from: A, to: B });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { relay: { hops: number } };
    expect(body.relay.hops).toBe(1);
  });

  it('refuses after MAX_RELAY_ROUNDS replies within the window, and leaves no relay, no row, no keystroke', async () => {
    for (let i = 0; i < MAX_RELAY_ROUNDS; i += 1) await roundTrip(i);
    const relaysBefore = count('session_relays');
    const rowsBefore = count('chat_messages');
    tmuxCalls.count = 0;

    for (const allowRelayChain of [false, true]) {
      const response = await postRelay({ from: A, to: B, allowRelayChain });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; error: string };
      expect(body.code).toBe('RELAY_HOPS_EXCEEDED');
      expect(body.error).toContain(`the limit is ${MAX_RELAY_ROUNDS}`);
    }

    expect(count('session_relays')).toBe(relaysBefore);
    expect(count('chat_messages')).toBe(rowsBefore);
    expect(tmuxCalls.count).toBe(0);
  });

  it('creates it (201) once the clock has moved the window past the replies', async () => {
    for (let i = 0; i < MAX_RELAY_ROUNDS; i += 1) await roundTrip(i);
    expect((await postRelay({ from: A, to: B })).status).toBe(409);

    advance(RELAY_ROUNDS_WINDOW_MS);

    const response = await postRelay({ from: A, to: B });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { relay: { hops: number } };
    expect(body.relay.hops).toBe(1);
  });
});
