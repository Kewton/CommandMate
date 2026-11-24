/**
 * Issue #4535 PR-A2, T11 (design `docs/design/send-outcome-4535.md` §3.3 I4, C6,
 * INV-S4; lead design §2.2 P2-2).
 *
 * The relay's settle is bookkeeping after the send. When it fails (it throws, or
 * its conditional UPDATE moves nothing) the send's fact stays what it was —
 * `sent` stays `sent`, `not_sent` stays `not_sent` — and the route's answer says
 * the ledger was not written (`relaySettled: false`), only then. The answer's
 * `sendOutcome` is the weaker of the body's own and the binding's (`unknown`
 * wins). The ledger says `failed` only for an attempt that can say nothing was
 * typed: none recorded, `not-sent`, or a boundary hook that refused — an attempt
 * recorded `indeterminate` before the boundary is `unknown`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { SendFenceOutcome } from '@/lib/session/send-fence-outcome';
import type { InputBoundaryHooks } from '@/lib/session/instance-input-lock';

const { settleSpy, realSettle } = vi.hoisted(() => ({
  settleSpy: vi.fn(),
  realSettle: { fn: null as null | ((...args: never[]) => unknown) },
}));
vi.mock('@/lib/db/relay-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/relay-db')>();
  realSettle.fn = actual.settleRelaySendState as (...args: never[]) => unknown;
  settleSpy.mockImplementation(actual.settleRelaySendState);
  return { ...actual, settleRelaySendState: (...args: Parameters<typeof actual.settleRelaySendState>) => settleSpy(...args) };
});

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return true; }
    async startSession() {}
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-codex-${id}`; }
  },
}));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'absent' })),
}));
vi.mock('@/app/api/worktrees/[id]/send/pane-shell', () => ({ isPaneBackAtShell: vi.fn(async () => false) }));
const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
const evaluateRelayAfterSend = vi.fn();
vi.mock('@/lib/relay/relay-delivery', () => ({
  evaluateRelayAfterSend: (...args: unknown[]) => evaluateRelayAfterSend(...args),
}));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));
let testDb: Database.Database | null = null;
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => {
    if (!testDb) throw new Error('no test db');
    return testDb;
  },
}));

import { cancelRelay, createRelay, getRelayById } from '@/lib/db/relay-db';
import { reserveRelaySend, type RelaySendBinding, type RelaySendResult } from '@/lib/relay/relay-bind';
import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import { clearSendAttempts } from '@/lib/session/send-attempt-state';

const WT = 'wt-4535-settle';
const ASKER = 'wt-4535-settle-asker';

let db: Database.Database;
let home = '';

interface SendParams {
  content: string;
  onAttempt?: (attempt: { state: string; reason: string }) => void;
  inputBoundary?: InputBoundaryHooks;
}

/** `finishSettled` is what this PR adds; `finish` keeps answering the outcome alone. */
type SettlingBinding = RelaySendBinding & {
  finishSettled?: (result: RelaySendResult) => { outcome: string; settled: boolean };
};

function boundRelay() {
  return createRelay(db, {
    from: { worktreeId: ASKER, instanceId: 'claude' },
    to: { worktreeId: WT, instanceId: 'codex' },
    hops: 1,
    expiresAt: Date.now() + 60_000,
    bindMode: 'bound',
  });
}

function reserve(relayId: string): SettlingBinding {
  const result = reserveRelaySend(db, {
    relayId,
    worktreeId: WT,
    cliToolId: 'codex',
    instanceId: 'codex',
    hooksReportTurns: false,
    readTurn: () => ({ open: false, generation: null }),
  });
  if (!result.ok) throw new Error(`reserve failed: ${JSON.stringify(result.refusal)}`);
  result.binding.begin(null);
  return result.binding as SettlingBinding;
}

function finishSettled(binding: SettlingBinding, result: RelaySendResult): { outcome: string; settled: boolean } {
  if (typeof binding.finishSettled !== 'function') throw new Error('RelaySendBinding.finishSettled is missing');
  return binding.finishSettled(result);
}

function settleThrows(): void {
  settleSpy.mockImplementationOnce(() => {
    throw new Error('SQLITE_BUSY: database is locked');
  });
}

async function post(extra: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'review this', cliToolId: 'codex', ...extra }),
  });
  const response = (await sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: WT }),
  })) as unknown as Response;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relay-settle-4535-'));
  db = new Database(':memory:');
  runMigrations(db);
  testDb = db;
  vi.clearAllMocks();
  settleSpy.mockReset();
  settleSpy.mockImplementation(realSettle.fn as (...args: unknown[]) => unknown);
  clearSendAttempts();
  for (const id of [WT, ASKER]) {
    upsertWorktree(db, {
      id,
      name: id,
      path: join(home, id),
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    } as Worktree);
  }
});

afterEach(() => {
  testDb = null;
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe('T11: a failed settle does not change the fact (I4)', () => {
  it('a failed settle keeps sent as sent and not_sent as not_sent; relaySettled is false', async () => {
    // The binding: a settle that throws keeps the fact and says it did not settle.
    const sentRelay = boundRelay();
    const sentBinding = reserve(sentRelay.id);
    sentBinding.hooks().beforeInput(new Date(), 'input_start');
    settleThrows();
    expect(finishSettled(sentBinding, { kind: 'sent', messageId: 'm-1', generationAfter: null })).toEqual({ outcome: 'sent', settled: false });

    const refusedRelay = boundRelay();
    settleThrows();
    expect(finishSettled(reserve(refusedRelay.id), { kind: 'failed', attempt: 'not-sent' })).toEqual({ outcome: 'not_sent', settled: false });
    // `finish` answers the same fact.
    const refusedAgain = boundRelay();
    settleThrows();
    expect(reserve(refusedAgain.id).finish({ kind: 'failed', attempt: 'not-sent' })).toBe('not_sent');

    // An UPDATE that moved nothing (the relay was closed meanwhile) is not settled either.
    const closedRelay = boundRelay();
    const closedBinding = reserve(closedRelay.id);
    cancelRelay(db, closedRelay.id);
    expect(finishSettled(closedBinding, { kind: 'failed', attempt: 'not-sent' })).toEqual({ outcome: 'not_sent', settled: false });

    // The route: the fact as the binding gives it, `relaySettled: false` beside it.
    const routeRelay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.onAttempt?.({ state: 'not-sent', reason: 'prompt-waiting' });
      settleThrows();
      return { ok: false, stage: 'prompt_waiting', error: 'waiting' };
    });
    const refused = await post({ relayId: routeRelay.id });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'PROMPT_WAITING', relayId: routeRelay.id, sendOutcome: 'not_sent', relaySettled: false });

    const sentRouteRelay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.inputBoundary?.beforeInput(new Date(), 'input_start');
      params.onAttempt?.({ state: 'sent', reason: 'submitted' });
      settleThrows();
      return { ok: true, message: { id: 'm-own', worktreeId: WT, role: 'user', content: params.content } };
    });
    const sent = await post({ relayId: sentRouteRelay.id });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ id: 'm-own', relayId: sentRouteRelay.id, sendOutcome: 'sent', relaySettled: false });
    // Not settled: the ledger still says `input_started`, so nothing is evaluated now.
    expect(evaluateRelayAfterSend).not.toHaveBeenCalled();
  });

  it('negative control: a settle that took leaves the answer as before (no relaySettled), and the sent one is evaluated', async () => {
    const relay = boundRelay();
    expect(finishSettled(reserve(relay.id), { kind: 'failed', attempt: 'not-sent' })).toEqual({ outcome: 'not_sent', settled: true });
    expect(getRelayById(db, relay.id)?.sendState).toBe('failed');

    const routeRelay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.inputBoundary?.beforeInput(new Date(), 'input_start');
      params.onAttempt?.({ state: 'sent', reason: 'submitted' });
      return { ok: true, message: { id: 'm-own', worktreeId: WT, role: 'user', content: params.content } };
    });
    const sent = await post({ relayId: routeRelay.id });
    expect(sent.status).toBe(201);
    expect(Object.keys(sent.body)).toEqual(['id', 'worktreeId', 'role', 'content', 'relayId', 'sendOutcome']);
    expect(sent.body.sendOutcome).toBe('sent');
    expect(evaluateRelayAfterSend).toHaveBeenCalledWith(routeRelay.id);
  });
});

describe('T11: the answer\'s sendOutcome is the weaker of the body\'s and the binding\'s', () => {
  it('the weaker of the body\'s and the binding\'s outcome wins', async () => {
    // The fence says the body may have gone in (`unknown`); the binding saw no boundary.
    const fence: SendFenceOutcome = {
      kind: 'target-changed',
      state: 'indeterminate',
      order: 1,
      refusal: { reason: 'dispatch-changed', requestId: 'req-4535-weaker' },
    };
    const relay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.onAttempt?.({ state: 'indeterminate', reason: 'target-changed' });
      return { ok: false, stage: 'send', error: 'send target changed: dispatch-changed', fence };
    });
    const { status, body } = await post({ relayId: relay.id });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'SEND_TARGET_CHANGED', relayId: relay.id, sendOutcome: 'unknown' });
    expect(getRelayById(db, relay.id)?.sendState).toBe('unknown');

    // The same fence answer when the service handed over no attempt: the binding alone
    // says `not_sent` (nothing recorded, no boundary), the body says `unknown` — the
    // body's wins. With the binding's outcome taking over the body's, this is `not_sent`.
    const silent = boundRelay();
    sendUserMessage.mockImplementationOnce(async () => ({
      ok: false,
      stage: 'send',
      error: 'send target changed: dispatch-changed',
      fence,
    }));
    const silentAnswer = await post({ relayId: silent.id });
    expect(silentAnswer.status).toBe(409);
    expect(silentAnswer.body).toMatchObject({ code: 'SEND_TARGET_CHANGED', relayId: silent.id, sendOutcome: 'unknown' });
  });

  it('negative control: the binding\'s unknown wins over a body that says not_sent', async () => {
    const fence: SendFenceOutcome = {
      kind: 'target-changed',
      state: 'not-sent',
      order: 1,
      refusal: { reason: 'target-gone', requestId: 'req-4535-weaker-2' },
    };
    const relay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.inputBoundary?.beforeInput(new Date(), 'dispatch');
      params.inputBoundary?.onDispatchFailed?.('unknown');
      params.onAttempt?.({ state: 'not-sent', reason: 'target-changed' });
      return { ok: false, stage: 'send', error: 'send target changed: target-gone', fence };
    });
    const { body } = await post({ relayId: relay.id });
    expect(body).toMatchObject({ code: 'SEND_TARGET_CHANGED', sendOutcome: 'unknown' });
  });
});

describe('T11: the ledger says failed only for an attempt that typed nothing (P2-2)', () => {
  it('a failed attempt recorded indeterminate before the boundary leaves the relay unknown, not failed', async () => {
    const relay = boundRelay();
    expect(reserve(relay.id).finish({ kind: 'failed', attempt: 'indeterminate' })).toBe('unknown');
    expect(getRelayById(db, relay.id)).toMatchObject({ sendState: 'unknown', holdReason: 'send_unknown' });

    // The same through the route: the answer and the ledger.
    const routeRelay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.onAttempt?.({ state: 'indeterminate', reason: 'send-error' });
      return { ok: false, stage: 'send', error: 'the dispatch answer was lost' };
    });
    const { status, body } = await post({ relayId: routeRelay.id });
    expect(status).toBe(500);
    expect(body.sendOutcome).toBe('unknown');
    expect(getRelayById(db, routeRelay.id)?.sendState).toBe('unknown');
  });

  it.each([
    { name: 'no attempt recorded, before the boundary', attempt: null, boundary: false },
    { name: 'recorded not-sent, before the boundary', attempt: 'not-sent' as const, boundary: false },
    { name: 'recorded not-sent, after the boundary', attempt: 'not-sent' as const, boundary: true },
  ])('negative control: $name — failed, not_sent', ({ attempt, boundary }) => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    if (boundary) binding.hooks().beforeInput(new Date(), 'input_start');
    expect(binding.finish({ kind: 'failed', attempt })).toBe('not_sent');
    expect(getRelayById(db, relay.id)?.sendState).toBe('failed');
  });

  it('negative control: a boundary hook that refused is failed, not_sent, whatever was recorded', () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    // The boundary write itself refuses: the relay was cancelled before the first key.
    cancelRelay(db, relay.id);
    expect(() => binding.hooks().beforeInput(new Date(), 'input_start')).toThrow();
    expect(binding.finish({ kind: 'failed', attempt: 'indeterminate' })).toBe('not_sent');
    expect(settleSpy).toHaveBeenCalledWith(db, expect.objectContaining({ to: 'failed' }));
  });

  it('negative control: indeterminate after the boundary stays unknown', () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    binding.hooks().beforeInput(new Date(), 'input_start');
    expect(binding.finish({ kind: 'failed', attempt: 'indeterminate' })).toBe('unknown');
    expect(getRelayById(db, relay.id)).toMatchObject({ sendState: 'unknown', holdReason: 'send_unknown' });
  });
});
