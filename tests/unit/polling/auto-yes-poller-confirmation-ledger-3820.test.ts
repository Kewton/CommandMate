/**
 * The poller's screen path writes the confirmation ledger (Issue #3820, design
 * `docs/design/auto-yes-measurement-3820.md` §7 PR 1), and the ledger never
 * changes how it answers.
 *
 * Drives the real `detectAndRespondToPrompt`, one call per tick. The screen
 * reading is stubbed as in `auto-yes-poller-withheld-by-policy-3724.test.ts`:
 * what is under test is what the poller does with a reading, not the reading.
 * For agy the stub keeps the one property the receipt gate gives the poller —
 * with `receiptScope` the dialog may be withheld (`gated`), without it the same
 * frame is a prompt (`ungated`).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { PromptData } from '@/types/models';

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

/** What the gated and the ungated readings return this tick. */
const screen = vi.hoisted(() => ({ gated: null as unknown, ungated: null as unknown }));
vi.mock('@/lib/polling/response-checker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/response-checker')>()),
  detectPromptOnCleanFrame: (
    _clean: string,
    _tool: string,
    _lines?: string[],
    _raw?: string,
    receiptScope?: unknown,
  ) => {
    const prompt = receiptScope === undefined ? screen.ungated : screen.gated;
    return prompt === null ? { isPrompt: false } : { isPrompt: true, promptData: prompt };
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

import { createTask } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { resetAntigravityPermissionReceiptsForTests } from '@/lib/polling/antigravity-permission-receipts';
import {
  clearAllPollerStates,
  detectAndRespondToPrompt,
  stopAutoYesPolling,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
  setAutoYesLedgerFaultForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WORKTREE_ID = 'wt-3820';
const T0 = new Date('2026-10-21T10:00:00.000Z').getTime();

let now = T0;

/** The same question, two different commands (`approvalTarget`). */
const proceed = (command: string): PromptData => ({
  type: 'yes_no',
  question: 'Do you want to proceed?',
  status: 'pending',
  options: ['yes', 'no'],
  approvalTarget: command,
});

/** A single-select approval the base rules answer with `1`. */
const SINGLE: PromptData = {
  type: 'multiple_choice',
  question: 'Allow this command?',
  status: 'pending',
  options: [
    { number: 1, label: 'Allow once', isDefault: true },
    { number: 2, label: 'Deny', isDefault: false },
  ],
};

function pollerState(cliToolId: CLIToolType): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId,
    instanceId: cliToolId,
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One tick over a pane whose gated and ungated readings are given. */
async function tickOn(
  cliToolId: CLIToolType,
  state: AutoYesPollerState,
  gated: PromptData | null,
  ungated: PromptData | null = gated,
): Promise<string> {
  screen.gated = gated;
  screen.ungated = ungated;
  return detectAndRespondToPrompt(WORKTREE_ID, state, cliToolId, 'pane', ['pane'], cliToolId);
}

const lines = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

function seedContract(cliToolId: CLIToolType, autoYes: string): void {
  createTask(db, {
    worktreeId: WORKTREE_ID,
    cliToolId,
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


/**
 * Issue #3822: an enforce tool's dialog gate refuses a `(y/n)` its own rules do
 * not vouch for, so the typed-answer path this file exercises (`y`, a wait,
 * Enter) is reached on claude only under the kill switch's `legacy` — the
 * setting an operator restores it with. What is pinned here is the send, not
 * the gate (the gate's refusal: `auto-yes-generic-yes-no-3822.test.ts`).
 */
const ORIGINAL_DIALOG_GATE_ENV = process.env.CM_AUTOYES_DIALOG_GATE;

beforeEach(() => {
  process.env.CM_AUTOYES_DIALOG_GATE = 'claude=legacy';
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  clearAllPollerStates();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  sendPromptAnswer.mockImplementation(async () => {});
  mockLogger.info.mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_DIALOG_GATE_ENV === undefined) delete process.env.CM_AUTOYES_DIALOG_GATE;
  else process.env.CM_AUTOYES_DIALOG_GATE = ORIGINAL_DIALOG_GATE_ENV;
  vi.restoreAllMocks();
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  db.close();
});

describe('[#3820] agy: the receipt window does not split a confirmation (必須 1)', () => {
  it('keeps one confirmation and one interval through in → out → out → in the window', async () => {
    seedContract('antigravity', "autoYes:\n  mode: 'off'\n");
    const state = pollerState('antigravity');

    // In the window: the gated reading sees it, the contract withholds it.
    expect(await tickOn('antigravity', state, SINGLE)).toBe('no_answer');
    now += 5_000;
    // Out of it: the gated reading says no prompt, the dialog is still up.
    expect(await tickOn('antigravity', state, null, SINGLE)).toBe('no_prompt');
    now += 5_000;
    expect(await tickOn('antigravity', state, null, SINGLE)).toBe('no_prompt');
    now += 5_000;
    expect(await tickOn('antigravity', state, SINGLE)).toBe('no_answer');
    now += 5_000;
    // Gone from both readings.
    expect(await tickOn('antigravity', state, null, null)).toBe('no_prompt');

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'mode-off', startedAtMs: T0 })]);
    expect(lines(EV.withholdReasonChanged)).toHaveLength(0);
    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'gone', withheldMs: 20_000 })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ cliToolId: 'antigravity', resolution: 'resolved-while-withheld', intervals: 1 }),
    ]);
  });

  it('closes it on the first tick neither reading sees it (negative control)', async () => {
    seedContract('antigravity', "autoYes:\n  mode: 'off'\n");
    const state = pollerState('antigravity');

    await tickOn('antigravity', state, SINGLE);
    now += 5_000;
    await tickOn('antigravity', state, null, null);

    expect(lines(EV.closed)).toHaveLength(1);
  });

  it('records the receipt gate withholding a dialog it never had a receipt for', async () => {
    const state = pollerState('antigravity');
    await tickOn('antigravity', state, null, SINGLE);
    now += 5_000;
    await tickOn('antigravity', state, null, SINGLE);

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'no-hook-receipt' })]);
    expect(lines(EV.closed)).toHaveLength(0);
  });
});

describe('[#3820] claude: answers, retries and failures on the screen path', () => {
  it('answers and records the attempt, then closes it as resolved after the answer', async () => {
    const state = pollerState('claude');
    expect(await tickOn('claude', state, proceed('npm test'))).toBe('responded');
    now += 2_000;
    await tickOn('claude', state, null);

    expect(lines(EV.attemptSettled)).toEqual([
      expect.objectContaining({ result: 'ok', basis: 'L4', late: false, expired: false }),
    ]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({
        resolution: 'resolved-after-answer',
        resolvedBy: 'unknown',
        answeredAtClose: true,
        attempts: { ok: 1, partial: 0, noKeysSent: 0, failed: 0 },
      }),
    ]);
  });

  it('tells two commands under the same question apart (two confirmations)', async () => {
    const state = pollerState('claude');
    await tickOn('claude', state, proceed('npm test'));
    now += 2_000;
    // The duplicate guard reads type + question only, so it does not answer
    // this one inside its window — the ledger still sees another confirmation.
    await tickOn('claude', state, proceed('rm -rf build'));

    expect(lines(EV.opened)).toHaveLength(2);
    expect(lines(EV.closed)).toEqual([expect.objectContaining({ resolution: 'resolved-after-answer' })]);
  });

  it('counts the retry after the duplicate window as a second attempt at the same confirmation', async () => {
    const state = pollerState('claude');
    await tickOn('claude', state, proceed('npm test'));
    now += 11_000;
    expect(await tickOn('claude', state, proceed('npm test'))).toBe('responded');

    const confirmationId = String(lines(EV.opened)[0].confirmationId);
    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.attemptSettled).map((line) => line.attemptId)).toEqual([
      `${confirmationId}.1`,
      `${confirmationId}.2`,
    ]);
  });

  it('records a send that threw as failed, not answered', async () => {
    sendPromptAnswer.mockRejectedValueOnce(new Error('tmux gone'));
    const state = pollerState('claude');
    expect(await tickOn('claude', state, proceed('npm test'))).toBe('error');
    now += 2_000;
    await tickOn('claude', state, null);

    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'failed' })]);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'send-failed' })]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ answeredAtClose: false, resolution: 'resolved-while-withheld' }),
    ]);
  });

  it('records a send stopped with keys on the pane as partial', async () => {
    sendPromptAnswer.mockRejectedValueOnce(Object.assign(new Error('stopped'), { keysSent: true }));
    await tickOn('claude', pollerState('claude'), proceed('npm test'));

    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'partial' })]);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'partial-answer' })]);
  });
});

describe('[#3820] the duplicate guard is a withheld interval of its own (review P2-1)', () => {
  it('opens a new interval when the same confirmation is held by the duplicate guard after an ok', async () => {
    sendPromptAnswer.mockRejectedValueOnce(new Error('tmux gone'));
    const state = pollerState('claude');
    expect(await tickOn('claude', state, proceed('npm test'))).toBe('error');
    now += 2_000;
    expect(await tickOn('claude', state, proceed('npm test'))).toBe('responded');
    now += 2_000;
    // The answer has not landed yet: the guard holds it, nothing is sent.
    expect(await tickOn('claude', state, proceed('npm test'))).toBe('duplicate');
    now += 2_000;
    await tickOn('claude', state, null);

    const confirmationId = String(lines(EV.opened)[0].confirmationId);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(2);
    expect(lines(EV.withholdStarted).map((line) => [line.intervalId, line.reason])).toEqual([
      [`${confirmationId}#1`, 'send-failed'],
      [`${confirmationId}#2`, 'answered-recently'],
    ]);
    expect(lines(EV.withholdEnded).map((line) => line.end)).toEqual(['answered', 'gone']);
    // Waiting for its own answer to land is not "resolved while withheld".
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'resolved-after-answer', intervals: 2 }),
    ]);
  });
});

describe('[#3820] two bodies are two confirmations (review P2-2)', () => {
  /** agy's legacy gate hands any reading back as ours; the contract withholds it. */
  const approval = (body: string): PromptData => ({ ...SINGLE, approvalTarget: body });

  it('counts `> file` and `file` under the same question and options as two confirmations', async () => {
    seedContract('antigravity', "autoYes:\n  mode: 'off'\n");
    const state = pollerState('antigravity');
    await tickOn('antigravity', state, approval('cat > file'));
    now += 2_000;
    await tickOn('antigravity', state, approval('cat file'));
    now += 2_000;
    await tickOn('antigravity', state, approval('> file'));
    now += 2_000;
    await tickOn('antigravity', state, approval('file'));

    expect(lines(EV.opened)).toHaveLength(4);
    expect(lines(EV.closed)).toHaveLength(3);
  });

  it('keeps one confirmation when only the cursor moved between its option rows (negative control)', async () => {
    seedContract('antigravity', "autoYes:\n  mode: 'off'\n");
    const state = pollerState('antigravity');
    await tickOn('antigravity', state, approval('rm -rf build\n❯ 1. Allow once\n  2. Deny'));
    now += 2_000;
    await tickOn('antigravity', state, approval('rm -rf build\n  1. Allow once\n❯ 2. Deny'));

    expect(lines(EV.opened)).toHaveLength(1);
  });
});

describe('[#3820] Auto-Yes off and on again through the poller (必須 2)', () => {
  it('keeps the confirmation over a disable and splits its intervals by enabled period', async () => {
    seedContract('claude', "autoYes:\n  mode: 'off'\n");
    await tickOn('claude', pollerState('claude'), proceed('npm test'));
    now += 3_000;
    stopAutoYesPolling(`${WORKTREE_ID}:claude`, 'manual');
    now += 60_000;
    await tickOn('claude', pollerState('claude'), proceed('npm test'));
    now += 3_000;
    stopAutoYesPolling(`${WORKTREE_ID}:claude`, 'session-killed');

    expect(lines(EV.opened)).toHaveLength(1);
    expect(lines(EV.withholdEnded).map((line) => [line.end, line.withheldMs])).toEqual([
      ['unobservable', 3_000],
      ['abandoned', 3_000],
    ]);
    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'abandoned', abandonReason: 'session-killed', unobservableMs: 60_000 }),
    ]);
  });
});

describe('[#3820] a failing ledger changes nothing the poller does (故障注入)', () => {
  /** The same ticks, with the ledger working; what the poller did, without the ledger's own lines. */
  async function run(): Promise<{ results: string[]; sent: unknown[]; poller: unknown[]; suppression: unknown }> {
    const state = pollerState('claude');
    const results = [await tickOn('claude', state, proceed('npm test'))];
    now += 2_000;
    results.push(await tickOn('claude', state, null));
    seedContract('claude', "autoYes:\n  mode: 'off'\n");
    clearAutoYesPolicyCache();
    results.push(await tickOn('claude', pollerState('claude'), proceed('rm -rf build')));
    const { at: _at, ...suppression } = getLastPolicySuppression(WORKTREE_ID, 'claude', 'claude') ?? { at: 0 };
    return {
      results,
      sent: sendPromptAnswer.mock.calls.map(([params]) => params),
      poller: mockLogger.info.mock.calls.filter(([name]) => !String(name).startsWith('auto-yes-')),
      suppression,
    };
  }

  it('answers, logs and records the suppression the same when every ledger entry point throws', async () => {
    const baseline = await run();
    expect(lines(EV.opened).length).toBeGreaterThan(0);

    db.close();
    db = new Database(':memory:');
    runMigrations(db);
    vi.clearAllMocks();
    mockLogger.info.mockImplementation(() => {});
    sendPromptAnswer.mockImplementation(async () => {});
    clearAllPollerStates();
    clearPolicySuppressions();
    clearAutoYesPolicyCache();
    resetAutoYesConfirmationLedgerForTests();
    now = T0;
    setAutoYesLedgerFaultForTests(new Error('ledger down'));

    const faulty = await run();
    setAutoYesLedgerFaultForTests(null);
    expect(lines(EV.opened)).toHaveLength(0);
    expect(faulty).toEqual(baseline);
  });

  it('answers, logs and records the suppression the same when the logger throws on ledger lines', async () => {
    const baseline = await run();

    db.close();
    db = new Database(':memory:');
    runMigrations(db);
    vi.clearAllMocks();
    sendPromptAnswer.mockImplementation(async () => {});
    clearAllPollerStates();
    clearPolicySuppressions();
    clearAutoYesPolicyCache();
    resetAutoYesConfirmationLedgerForTests();
    now = T0;
    mockLogger.info.mockImplementation((name: string) => {
      if (String(name).startsWith('auto-yes-')) throw new Error('logger down');
    });

    const faulty = await run();
    expect(faulty).toEqual(baseline);
  });
});
