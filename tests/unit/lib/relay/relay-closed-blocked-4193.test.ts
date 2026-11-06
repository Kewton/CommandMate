/**
 * An expiry notice stopped by the requester's dialog stays readable after the
 * relay closed (Issue #4193).
 *
 * `lastDeliveryBlock` (#4105) is recorded for the expiry notice too, but the
 * list's `open` / `awaiting` leave expired relays out, so the reason was
 * readable through `relays --id` only. `GET /api/relays` now carries those
 * relays as `closedBlocked` — never in `open` / `awaiting`, never counted.
 *
 * Driven through the real pump, the real ledger (a file DB under
 * `fs.mkdtempSync(os.tmpdir())`, removed in `afterEach`) and the real route
 * handler; the CLI reads the route's actual answer. Positive cases fail before
 * the fix (no `closedBlocked`, no CLI line); the negative controls — delivered,
 * not stopped, restart, counts — hold before and after.
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
import { createRelay, getRelayById } from '@/lib/db/relay-db';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import type { SendAttemptReason, SendAttemptState } from '@/lib/session/send-attempt-types';
import type { SessionRelay } from '@/lib/relay/types';
import { restoreFetch } from '../../../helpers/mock-api';

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

let dir: string;
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
const { GET: listRoute } = await import('@/app/api/relays/route');

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

interface ListAnswer {
  owed: SessionRelay[];
  awaiting: SessionRelay[];
  open: SessionRelay[];
  held: SessionRelay[];
  closedBlocked?: SessionRelay[];
  counts: Record<string, number>;
  heldCount: number;
}

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

async function readList(query = 'worktree=wt-a&instance=claude'): Promise<ListAnswer> {
  const response = await listRoute(new NextRequest(`http://localhost/api/relays?${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as ListAnswer;
}

/** An expired relay whose expiry notice waits in the slot for A. */
function expiredRelay(): string {
  const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW - 1, now: NOW - DAY_MS });
  expect(sweepExpiredRelays(db, NOW)).toBe(1);
  expect(getRelayById(db, relay.id)).toMatchObject({ state: 'expired', pendingKind: 'expired' });
  return relay.id;
}

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

/** Run `relays` against the route's actual answer. */
async function relaysCli(answer: ListAnswer, argv: string[] = []): Promise<{ out: string; err: string }> {
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  global.fetch = vi.fn().mockImplementation((url: string) => {
    const data = String(url).includes('/api/relays') ? answer : {};
    return Promise.resolve({
      ok: true,
      status: 200,
      redirected: false,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }) as unknown as typeof fetch;
  const { createRelaysCommand } = await import('@/cli/commands/relays');
  await createRelaysCommand().parseAsync(['node', 'relays', ...argv]);
  return {
    out: mockConsoleLog.mock.calls.map((call) => String(call[0])).join('\n'),
    err: mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n'),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-4193-'));
  db = new Database(path.join(dir, 'cm.db'));
  db.pragma('foreign_keys = ON');
  runMigrations(db);
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
  restoreFetch();
  resetRelayDeliveryState();
  resetRelayServerBootId();
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('an expiry notice stopped by the requester dialog (Issue #4193)', () => {
  it('is in `closedBlocked` with its reason, not in open / awaiting (positive)', async () => {
    const relayId = expiredRelay();
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();

    const expected = { reason: 'prompt_waiting', kind: 'expired' };
    for (const query of ['worktree=wt-a&instance=claude', 'worktree=wt-a', '']) {
      const list = await readList(query);
      const row = list.closedBlocked?.find((relay) => relay.id === relayId);
      expect(row?.state, query).toBe('expired');
      expect(row?.lastDeliveryBlock, query).toMatchObject(expected);
      expect(list.open.some((relay) => relay.id === relayId), query).toBe(false);
      expect(list.awaiting.some((relay) => relay.id === relayId), query).toBe(false);
    }
    // Scoped by the requester: the worker's side does not list A's notice.
    expect((await readList('worktree=wt-b&instance=codex')).closedBlocked).toEqual([]);
    expect((await readList('worktree=wt-b')).closedBlocked).toEqual([]);
  });

  it('relays (text and --json) read the reason from the route\'s answer (positive)', async () => {
    const relayId = expiredRelay();
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    const answer = await readList();

    const text = await relaysCli(answer);
    expect(text.err).toContain('# closed, notice not delivered yet (1)');
    const line = text.out.split('\n').find((l) => l.startsWith(relayId));
    expect(line).toContain('\texpired\t');
    expect(line).toContain('pending=expired');
    expect(line).toMatch(/blocked=prompt_waiting@\d{4}-/);

    const json = await relaysCli(answer, ['--json']);
    const parsed = JSON.parse(json.out) as ListAnswer;
    expect(parsed.closedBlocked?.[0]).toMatchObject({
      id: relayId,
      lastDeliveryBlock: { reason: 'prompt_waiting', kind: 'expired' },
    });
  });

  it('changes no count: counts and heldCount are those of the ledger (negative)', async () => {
    expiredRelay();
    const before = await readList();
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    const after = await readList();

    expect(after.closedBlocked).toHaveLength(1);
    expect(after.counts).toEqual(before.counts);
    expect(after.heldCount).toBe(before.heldCount);
    expect(after.heldCount).toBe(0);
    expect(after.held).toEqual([]);
    expect(after.open).toEqual([]);
  });

  it('goes away once the notice is delivered (negative)', async () => {
    const relayId = expiredRelay();
    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    expect((await readList()).closedBlocked).toHaveLength(1);

    sendUserMessage.mockReset();
    sendUserMessage.mockResolvedValue(OK);
    await pumpRelayDeliveries();

    expect(getRelayById(db, relayId)?.pendingKind).toBeNull();
    const answer = await readList();
    expect(answer.closedBlocked).toEqual([]);
    const text = await relaysCli(answer);
    expect(text.err).not.toContain('# closed');
    expect(text.out).not.toContain(relayId);
  });

  it('an expired relay not stopped (no attempt, or after a restart) is not listed (negative)', async () => {
    expiredRelay();
    // Nothing attempted yet.
    expect((await readList()).closedBlocked).toEqual([]);

    sendUserMessage.mockImplementation(PROMPT_WAITING);
    await pumpRelayDeliveries();
    expect((await readList()).closedBlocked).toHaveLength(1);
    // A restart forgets the observation: not listed (null is not "deliverable").
    resetRelayDeliveryState();
    expect((await readList()).closedBlocked).toEqual([]);
  });

  it('an expired relay whose notice was already delivered is not listed (negative)', async () => {
    expiredRelay();
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect((await readList()).closedBlocked).toEqual([]);
  });
});
