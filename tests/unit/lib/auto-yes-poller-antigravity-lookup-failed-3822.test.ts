/**
 * Issue #3822: past agy's receipt window the receipt-log
 * (`polling/auto-yes-poller-receipt-log`) re-judges the dialog still up against
 * the contract. While the contract lookup fails it read the failure as "no
 * contract" and dropped the `policy-lookup-failed` record the tick had just
 * made, so `cmate wait` lost why the dialog was left alone. Same harness as
 * auto-yes-poller-antigravity-window-3796: the real `detectAndRespondToPrompt`,
 * one call per tick, the clock moved between ticks, the database layer made to
 * throw.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Issue #2865: the poller answers only a session created in the worktree's own
// directory. Ownership itself is covered by tests/unit/tmux/session-ownership.test.ts.
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
let taskLookupFailure: Error | null = null;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    getActiveTaskForInstance: (...args: Parameters<typeof actual.getActiveTaskForInstance>) => {
      if (taskLookupFailure) throw taskLookupFailure;
      return actual.getActiveTaskForInstance(...args);
    },
  };
});

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
      getTool: () => ({ getSessionName: (id: string) => `cm-${id}-antigravity`, name: 'Antigravity' }),
    }),
  },
}));

// The one logger every module gets, so the poller's `info` lines can be read.
// `withContext` is part of the logger contract and the detection layer uses it: a
// mock missing it throws inside the poller's catch and every assertion here would
// read `'error'` instead of the verdict under test.
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
import {
  clearAllPollerStates,
  detectAndRespondToPrompt,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { createTask } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';

const WORKTREE_ID = 'wt-3822-agy';
const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');
const T0 = new Date('2026-10-17T10:00:00.000Z').getTime();
const WITHHELD_BY_POLICY_LOG = 'antigravity-autoyes-withheld-by-policy';

const frame = (name: string): string => readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');

/**
 * The frame exactly as `captureAndCleanOutput` hands it to
 * `detectAndRespondToPrompt`: ANSI and box drawing removed, nothing else.
 */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

function pollerState(instanceId = 'antigravity'): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'antigravity',
    instanceId,
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** Drive the real poller over one fixture (or a built frame), the way `pollAutoYes` does. */
async function respondTo(
  name: string,
  instanceId = 'antigravity',
  raw: string = frame(name),
): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  const clean = asPollerSees(raw);
  return detectAndRespondToPrompt(
    WORKTREE_ID,
    pollerState(instanceId),
    'antigravity',
    clean,
    clean.split('\n'),
    instanceId,
  );
}

/** agy asked CommandMate about a tool call for this instance, right now. */
const receiptFor = (instanceId = 'antigravity'): void =>
  recordAntigravityPermissionReceipt(WORKTREE_ID, 'antigravity', instanceId, 'run_command', Date.now());


beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  taskLookupFailure = null;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  clearAllPollerStates();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  vi.useRealTimers();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  resetAntigravityPermissionReceiptsForTests();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  db.close();
});

const IDLE = 'idle-after-deny';
const DIALOG = 'dialog-bash-wrapped';

/** One poller tick at `T0 + ms` over the named fixture. */
async function tickAt(ms: number, name: string): Promise<string> {
  vi.setSystemTime(T0 + ms);
  return respondTo(name);
}

/** A receipt for this instance at `T0 + ms`. */
function receiptAt(ms: number): void {
  vi.setSystemTime(T0 + ms);
  receiptFor();
}

const suppression = () => getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity');
const withheldByPolicyLines = (): Array<[string, Record<string, unknown>]> =>
  mockLogger.info.mock.calls.filter(([name]) => name === WITHHELD_BY_POLICY_LOG) as Array<[string, Record<string, unknown>]>;

function seedContract(autoYes: string): void {
  createTask(db, {
    worktreeId: WORKTREE_ID,
    cliToolId: 'antigravity',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
${autoYes}`,
      'task.yaml',
    ),
    status: 'running',
  });
}

/** The lookup fails from 5s: the dialog accepted then is withheld for it, inside the window. */
async function lookupFailureRecordedInsideTheWindow(): Promise<void> {
  receiptAt(0);
  expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
  taskLookupFailure = new Error('SQLITE_IOERR');
  expect(await tickAt(5_000, DIALOG)).toBe('no_answer');
  expect(suppression()).toMatchObject({ reason: 'policy-lookup-failed', mode: null, at: T0 + 5_000 });
}

describe('[#3822] past the receipt window, a failed lookup keeps its record', () => {
  it.each([
    ["mode: 'off'", "autoYes:\n  mode: 'off'\n"],
    ['no contract', ''],
  ])('positive (%s): every tick while the lookup fails keeps policy-lookup-failed, re-stamped', async (_label, autoYes) => {
    if (autoYes) seedContract(autoYes);
    await lookupFailureRecordedInsideTheWindow();
    for (const ms of [10_000, 15_000, 20_000, 25_000, 30_000]) {
      expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
      // Before #3822's second fix the receipt-log read the failure as no contract
      // and dropped this record on the first tick past the window.
      expect(suppression()).toMatchObject({ reason: 'policy-lookup-failed', mode: null, at: T0 + ms });
    }
    expect(withheldByPolicyLines().at(-1)?.[1]).toMatchObject({ reason: 'policy-lookup-failed', taskId: null });
    expect(withheldByPolicyLines().at(-1)?.[1].hint).toContain('照会に失敗');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('negative: the lookup recovers and finds no contract — the record goes', async () => {
    await lookupFailureRecordedInsideTheWindow();
    expect(await tickAt(10_000, DIALOG)).toBe('no_prompt');
    taskLookupFailure = null;
    expect(await tickAt(15_000, DIALOG)).toBe('no_prompt');
    expect(suppression()).toBeNull();
    // The receipt is spent: the lookup recovering does not make Auto-Yes answer the dialog.
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it("negative: the lookup recovers and finds mode: 'off' — the record takes that reason", async () => {
    seedContract("autoYes:\n  mode: 'off'\n");
    await lookupFailureRecordedInsideTheWindow();
    expect(await tickAt(10_000, DIALOG)).toBe('no_prompt');
    taskLookupFailure = null;
    expect(await tickAt(15_000, DIALOG)).toBe('no_prompt');
    expect(suppression()).toMatchObject({ reason: 'mode-off', mode: 'off', at: T0 + 15_000 });
  });

  it("control: a lookup that never fails keeps the mode: 'off' record as before", async () => {
    seedContract("autoYes:\n  mode: 'off'\n");
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(5_000, DIALOG)).toBe('no_answer');
    for (const ms of [10_000, 15_000]) {
      expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
      expect(suppression()).toMatchObject({ reason: 'mode-off', at: T0 + ms });
    }
    expect(withheldByPolicyLines().at(-1)?.[1].hint).toContain('契約の autoYes が答えを止めている');
  });
});
