/**
 * agy's call in the Auto-Yes confirmation ledger (Issue #3820, design
 * `docs/design/auto-yes-measurement-3820.md` §2.1・§2.4・§2.6, PR 3): the
 * `PreToolUse` hook request names its call (`<conversationId>:<stepIdx>`), the
 * receipt that lets the dialog through carries it, and the screen's
 * confirmation is tied to it; the call's `PostToolUse` closes it.
 *
 * Drives the real `detectAndRespondToPrompt` over the live agy captures of
 * #2364, as `auto-yes-poller-ledger-basis-3820.test.ts` does. The hook route's
 * half is driven through the ledger's own entry points, the way the route and
 * the decision service call them (their wiring is pinned by
 * `tests/unit/api/hooks-agy-call-ledger-3820.test.ts`).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
}));

vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (tool: string) => ({ getSessionName: (id: string) => `cm-${id}-${tool}`, name: tool }),
    }),
  },
}));

const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import {
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import { clearAllPollerStates, detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  beginLedgerHookRequest,
  closeLedgerHookRequest,
  decideLedgerHookRequest,
  getAutoYesLedgerErrorCountForTests,
  noteLedgerToolCallEnded,
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
  setAutoYesLedgerFaultForTests,
  type LedgerScope,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const WORKTREE_ID = 'wt-3820-agy-call';
const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');
const T0 = new Date('2026-10-22T10:00:00.000Z').getTime();
const SCOPE: LedgerScope = { worktreeId: WORKTREE_ID, cliToolId: 'antigravity', instanceId: 'antigravity' };
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const call = (stepIdx: number): string => `${CONVERSATION}:${stepIdx}`;

const asPollerSees = (name: string): string =>
  stripBoxDrawing(stripAnsi(readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8')));
const DIALOG = asPollerSees('dialog-bash-wrapped');
const IDLE = asPollerSees('idle-after-deny');

/** One poller, kept across ticks as the real loop keeps it. */
let state: AutoYesPollerState;

async function tick(clean: string): Promise<string> {
  return detectAndRespondToPrompt(WORKTREE_ID, state, 'antigravity', clean, clean.split('\n'), 'antigravity');
}

/**
 * agy's `PreToolUse` as the permission route records it: the receipt (with the
 * call) and the hook request, decided `allow` — which on agy still draws the
 * dialog — and replied to.
 */
function preToolUse(callId: string | null, at = Date.now()): string | null {
  recordAntigravityPermissionReceipt(WORKTREE_ID, 'antigravity', 'antigravity', 'run_command', at, callId);
  const id = beginLedgerHookRequest({ worktreeId: WORKTREE_ID, cliToolId: 'antigravity', instanceId: 'antigravity' }, at);
  decideLedgerHookRequest(id, {
    outcome: 'allow',
    allowSuppressesDialog: false,
    promptType: 'permission_request',
    ...(callId !== null ? { callId } : {}),
  });
  closeLedgerHookRequest(id, { delivered: true });
  return id;
}

const lines = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

const at = (ms: number): void => {
  vi.setSystemTime(T0 + ms);
};

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  clearAllPollerStates();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  state = {
    timerId: null,
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
});

afterEach(() => {
  vi.useRealTimers();
  clearAllPollerStates();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  db.close();
});

describe('[#3820 PR 3] PreToolUse(allow, stepIdx=25) → the dialog → answered → PostToolUse(25)', () => {
  it('is one hook request and one confirmation tied to it by the call, at L3', async () => {
    const hookRequestId = preToolUse(call(25));
    at(1_000);
    expect(await tick(DIALOG)).toBe('responded');
    at(2_000);
    noteLedgerToolCallEnded(SCOPE, call(25));

    expect(lines(EV.hookRequestClosed)).toEqual([
      expect.objectContaining({ hookRequestId, outcome: 'allow', allowSuppressesDialog: false, callId: call(25) }),
    ]);
    expect(lines(EV.opened)).toEqual([
      expect.objectContaining({ source: 'screen', cliToolId: 'antigravity', callId: call(25), hookRequestId }),
    ]);
    const [opened] = lines(EV.opened);
    expect(lines(EV.attemptSettled)).toEqual([
      expect.objectContaining({ confirmationId: opened.confirmationId, result: 'ok', basis: 'L3', receiptAccepted: true }),
    ]);
    // Closed by the call ending, before any tick saw the screen clear.
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({
        confirmationId: opened.confirmationId,
        resolution: 'resolved-after-answer',
        resolvedBy: 'unknown',
        answeredAtClose: true,
        openMs: 1_000,
      }),
    ]);
    expect(lines(EV.hookRequestDialogUnobserved)).toHaveLength(0);
  });

  it('does not reopen it on a stale frame still showing the dialog, nor close it twice when the screen clears', async () => {
    preToolUse(call(25));
    at(1_000);
    await tick(DIALOG);
    at(1_500);
    noteLedgerToolCallEnded(SCOPE, call(25));
    at(3_000);
    await tick(DIALOG);
    at(5_000);
    await tick(IDLE);

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.closed)).toHaveLength(1);
  });

  it('closes on the screen clearing first, and the late PostToolUse writes nothing', async () => {
    preToolUse(call(25));
    at(1_000);
    await tick(DIALOG);
    at(3_000);
    await tick(IDLE);
    at(4_000);
    noteLedgerToolCallEnded(SCOPE, call(25));

    expect(lines(EV.closed)).toEqual([expect.objectContaining({ resolution: 'resolved-after-answer', resolvedBy: 'unknown' })]);
    expect(lines(EV.hookRequestDialogUnobserved)).toHaveLength(0);
  });
});

describe('[#3820 PR 3] negative controls', () => {
  it('counts two calls of the same command (stepIdx 25 and 27) as two, with no clear read between', async () => {
    preToolUse(call(25));
    at(1_000);
    expect(await tick(DIALOG)).toBe('responded');
    // agy asks again about the same command; the pane never showed it clear.
    at(13_000);
    preToolUse(call(27));
    at(14_000);
    expect(await tick(DIALOG)).toBe('responded');

    expect(lines(EV.opened)).toEqual([
      expect.objectContaining({ callId: call(25) }),
      expect.objectContaining({ callId: call(27) }),
    ]);
    // The first closed when the second call's dialog replaced it.
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ confirmationId: lines(EV.opened)[0].confirmationId, resolution: 'resolved-after-answer' }),
    ]);
  });

  it('keeps one confirmation for the same screen without a call (as before PR 3)', async () => {
    preToolUse(null);
    at(1_000);
    expect(await tick(DIALOG)).toBe('responded');
    at(3_000);
    await tick(DIALOG);

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.opened)[0]).not.toHaveProperty('callId');
    expect(lines(EV.hookRequestClosed)[0]).not.toHaveProperty('callId');
  });

  it('"No": no PostToolUse comes, so it closes when the dialog goes, by nobody known', async () => {
    preToolUse(call(25));
    at(1_000);
    await tick(DIALOG);
    // The human chose "No" at the terminal: the dialog goes, and agy sends no
    // `PostToolUse` (nor `Stop`) for that call.
    at(3_000);
    await tick(IDLE);

    expect(lines(EV.closed)).toEqual([expect.objectContaining({ resolvedBy: 'unknown' })]);
    expect(lines(EV.hookRequestDialogUnobserved)).toHaveLength(0);
  });

  it('marks the request dialogUnobserved when the call ends with no confirmation seen, and opens none', () => {
    const hookRequestId = preToolUse(call(25));
    at(2_000);
    noteLedgerToolCallEnded(SCOPE, call(25));
    noteLedgerToolCallEnded(SCOPE, call(25));

    expect(lines(EV.hookRequestDialogUnobserved)).toEqual([
      expect.objectContaining({ hookRequestId, cliToolId: 'antigravity', callId: call(25), dialogUnobserved: true }),
    ]);
    expect(lines(EV.opened)).toHaveLength(0);
    expect(lines(EV.closed)).toHaveLength(0);
  });

  it('writes nothing for a PostToolUse with no call, or with a call no request named', () => {
    preToolUse(null);
    noteLedgerToolCallEnded(SCOPE, null);
    noteLedgerToolCallEnded(SCOPE, undefined);
    noteLedgerToolCallEnded(SCOPE, call(99));

    expect(lines(EV.hookRequestDialogUnobserved)).toHaveLength(0);
    expect(lines(EV.closed)).toHaveLength(0);
  });

  it('answers the same whether or not the ledger throws (recording only)', async () => {
    preToolUse(call(25));
    setAutoYesLedgerFaultForTests(new Error('ledger down'));
    at(1_000);
    expect(await tick(DIALOG)).toBe('responded');
    expect(() => noteLedgerToolCallEnded(SCOPE, call(25))).not.toThrow();
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(getAutoYesLedgerErrorCountForTests()).toBeGreaterThan(0);
  });
});
