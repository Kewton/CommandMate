/**
 * Issue #3796 items 1 and 2: an agy answer cut short before `noteAnswerSent`,
 * and a reason recorded inside the receipt window that froze once the window
 * closed. Same harness as auto-yes-poller-antigravity-receipt-leftovers-3789:
 * the real `detectAndRespondToPrompt`, one call per tick, the clock moved
 * between ticks.
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
  startAutoYesPolling,
  stopAutoYesPolling,
  type AutoYesPollerState,
  type AutoYesTickGeneration,
} from '@/lib/auto-yes-poller';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { getLastPolicySuppression, recordPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS } from '@/lib/polling/antigravity-receipt-episodes';
import { checkWorktreeSessionOwnership } from '@/lib/cli-tools/worktree-session-ownership';
import {
  buildCompositeKey,
  clearAllAutoYesStates,
  getAutoYesState,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import { getEnterFallbackSessionEpoch } from '@/lib/polling/auto-yes-enter-fallback-state';
import { createTask, type Task } from '@/lib/db';
// Fixtures place a task in a state directly; production writes go through applyTaskEvent.
import { updateTaskStatus } from '@/lib/db/tasks-db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';

const WORKTREE_ID = 'wt-3796';
const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');
const T0 = new Date('2026-10-17T10:00:00.000Z').getTime();
const WITHHELD_LOG = 'antigravity-autoyes-withheld-no-hook-receipt';

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
  db.close();
});


const IDLE = 'idle-after-deny';
const DIALOG = 'dialog-bash-wrapped';
const withheldLines = (): Array<[string, Record<string, unknown>]> =>
  mockLogger.info.mock.calls.filter(([name]) => name === WITHHELD_LOG) as Array<[string, Record<string, unknown>]>;

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
const KEY = buildCompositeKey(WORKTREE_ID, 'antigravity', 'antigravity');

/**
 * A tick that loses its generation while its keys are being sent — Auto-Yes
 * switched off mid-send, as `pollAutoYes` sees it — at `T0 + ms`.
 */
async function abandonedTickAt(ms: number, keysSent: boolean): Promise<string> {
  vi.setSystemTime(T0 + ms);
  setAutoYesEnabled(WORKTREE_ID, 'antigravity', true, undefined, undefined, 'antigravity');
  expect(startAutoYesPolling(WORKTREE_ID, 'antigravity', 'antigravity').started).toBe(true);
  const state = globalThis.__autoYesPollerStates!.get(KEY)!;
  const generation: AutoYesTickGeneration = {
    compositeKey: KEY,
    worktreeId: WORKTREE_ID,
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    pollerState: state,
    grant: getAutoYesState(WORKTREE_ID, 'antigravity', 'antigravity')!,
    sessionEpoch: getEnterFallbackSessionEpoch(KEY),
    startedAt: Date.now(),
  };
  sendPromptAnswer.mockImplementationOnce(async () => {
    stopAutoYesPolling(KEY);
    throw Object.assign(new Error('answer stopped'), { keysSent });
  });
  const clean = asPollerSees(frame(DIALOG));
  return detectAndRespondToPrompt(WORKTREE_ID, state, 'antigravity', clean, clean.split('\n'), 'antigravity', undefined, generation);
}

describe('[#3796] 1: a send cut short before noteAnswerSent is reported once the grace is over', () => {
  it('positive: a send that failed part-way is recorded with the "stopped mid-send" hint, and never sent again', async () => {
    receiptAt(0);
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    sendPromptAnswer.mockRejectedValueOnce(new Error('send-keys failed'));
    expect(await tickAt(8_700, DIALOG)).toBe('error'); // accepted at 8.7s, the send failed
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    for (const ms of [13_700, 18_700, 23_700, 26_700]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(suppression()).toBeNull();
    expect(withheldLines()).toHaveLength(0);

    // Past the grace from the failed send. Before #3796 it stayed `answered`: silent for good.
    expect(await tickAt(8_700 + ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS + 1, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(suppression()).toMatchObject({ reason: 'no-hook-receipt', mode: null });
    expect(withheldLines()).toHaveLength(1);
    expect(withheldLines()[0][1].hint).toContain('途中で送信が止まり');
  });

  it('positive: a send stopped before any key (the tick lost its generation) is recorded too', async () => {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await abandonedTickAt(5_000, false)).toBe('no_answer');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    for (const ms of [10_000, 15_000, 20_000]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(suppression()).toBeNull();

    expect(await tickAt(5_000 + ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS + 1, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(suppression()?.reason).toBe('no-hook-receipt');
    expect(withheldLines().at(-1)?.[1].hint).toContain('途中で送信が止まり');
  });

  it('control: a whole send keeps the #3789 hint (keys sent, not cut short)', async () => {
    receiptAt(0);
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    expect(await tickAt(8_700, DIALOG)).toBe('responded');
    for (const ms of [13_700, 18_700, 23_700]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(await tickAt(8_700 + ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS + 1, DIALOG)).toBe('no_prompt');
    expect(withheldLines()).toHaveLength(1);
    expect(withheldLines()[0][1].hint).not.toContain('途中で送信が止まり');
    expect(withheldLines()[0][1].hint).toContain('画面に残っている');
  });

  it('control: a failure before the send began (the ownership check) starts no grace and sends nothing', async () => {
    receiptAt(0);
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    vi.mocked(checkWorktreeSessionOwnership).mockRejectedValueOnce(new Error('db gone'));
    expect(await tickAt(8_700, DIALOG)).toBe('error');
    for (const ms of [13_700, 18_700, 23_700, 28_700, 33_700]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppression()).toBeNull();
    expect(withheldLines()).toHaveLength(0);
  });
});

describe('[#3796] 2: a reason recorded inside the window stays fresh while its dialog stays up', () => {
  /** keys left in the input at 5s; the 7s tick, still inside the window, records `partial-answer`. */
  async function partialAnswerRecordedInsideTheWindow(): Promise<void> {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await abandonedTickAt(5_000, true)).toBe('no_answer');
    expect(await tickAt(7_000, DIALOG)).toBe('no_answer');
    expect(suppression()).toMatchObject({ reason: 'partial-answer', at: T0 + 7_000 });
  }

  it('positive: re-stamped on every tick past the window, so `wait` (60 s freshness) still reads it', async () => {
    await partialAnswerRecordedInsideTheWindow();
    for (let ms = 12_000; ms <= 92_000; ms += 5_000) {
      expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
      // Before #3796 `at` stayed at 7s, and a minute later `wait` dropped it as stale.
      expect(suppression()).toMatchObject({ reason: 'partial-answer', at: T0 + ms });
    }
    // Kept over a `no-hook-receipt` for the same dialog once the grace is over.
    expect(withheldLines()).toHaveLength(0);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('control: the dialog taken down — the record is no longer re-stamped', async () => {
    await partialAnswerRecordedInsideTheWindow();
    expect(await tickAt(12_000, DIALOG)).toBe('no_prompt');
    const at = suppression()?.at;
    expect(await tickAt(17_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(22_000, IDLE)).toBe('no_prompt');
    expect(suppression()).toMatchObject({ reason: 'partial-answer', at });
  });

  it('control: a record older than the dialog is not re-stamped', async () => {
    vi.setSystemTime(T0 - 30_000);
    recordPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity', {
      reason: 'mode-off',
      mode: 'off',
      promptType: 'multiple_choice',
    });
    receiptAt(0);
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    vi.mocked(checkWorktreeSessionOwnership).mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' });
    expect(await tickAt(8_700, DIALOG)).toBe('no_answer');
    for (const ms of [13_700, 18_700, 23_700]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(suppression()?.at).toBe(T0 - 30_000);
  });
});

/** A running task for the agy primary instance whose contract carries `autoYes`. */
function seedContract(autoYes: string): Task {
  return createTask(db, {
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

/** The task ends (or is replaced): the next policy read sees the change. */
function endContract(task: Task): void {
  updateTaskStatus(db, task.id, 'succeeded');
  clearAutoYesPolicyCache();
}

describe('[#3796 review A] a contract reason is re-stamped only while the contract still gives it', () => {
  /** `mode: off` withholds the dialog accepted at 5s; ticks every 5s from 10s keep it up past the window. */
  async function modeOffRecordedInsideTheWindow(): Promise<Task> {
    const task = seedContract("autoYes:\n  mode: 'off'\n");
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(5_000, DIALOG)).toBe('no_answer');
    expect(suppression()).toMatchObject({ reason: 'mode-off', mode: 'off', at: T0 + 5_000 });
    return task;
  }

  it('positive: the contract still withholds — re-stamped on every tick past the window', async () => {
    await modeOffRecordedInsideTheWindow();
    for (const ms of [10_000, 15_000, 20_000, 25_000, 30_000]) {
      expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
      expect(suppression()).toMatchObject({ reason: 'mode-off', at: T0 + ms });
    }
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('negative: the contract ended — the old reason is not re-stamped; the record goes', async () => {
    const task = await modeOffRecordedInsideTheWindow();
    expect(await tickAt(10_000, DIALOG)).toBe('no_prompt');
    endContract(task);
    expect(await tickAt(15_000, DIALOG)).toBe('no_prompt');
    // `wait` would otherwise read "withheld by contract policy" for another minute.
    expect(suppression()).toBeNull();
    for (const ms of [20_000, 25_000]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(suppression()).toBeNull();
    // The receipt is spent: ending the contract does not make Auto-Yes answer the dialog.
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('negative: the contract changed — the record takes the reason it gives now', async () => {
    const task = await modeOffRecordedInsideTheWindow();
    expect(await tickAt(10_000, DIALOG)).toBe('no_prompt');
    endContract(task);
    seedContract("autoYes:\n  mode: 'safe'\n");
    expect(await tickAt(15_000, DIALOG)).toBe('no_prompt');
    expect(suppression()).toMatchObject({ reason: 'type-not-allowed', mode: 'safe', at: T0 + 15_000 });
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});

describe('[#3796 review C] a send cut short marks only the episode it was sent for', () => {
  it('negative: the send fails after a successor accepted a dialog on a newer receipt — that episode is left alone', async () => {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    sendPromptAnswer.mockImplementationOnce(async () => {
      // While these keys are awaited: the dialog goes, a new receipt and a new
      // dialog come, and the next read accepts it (another server's session, so
      // nothing is sent to it).
      expect(await tickAt(7_000, IDLE)).toBe('no_prompt');
      receiptAt(8_000);
      vi.mocked(checkWorktreeSessionOwnership).mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' });
      expect(await tickAt(10_000, DIALOG)).toBe('no_answer');
      throw new Error('send-keys failed');
    });
    expect(await tickAt(5_000, DIALOG)).toBe('error');

    // From 17s, past the new receipt's window (8s + 8s): the dialog it accepted stays up.
    for (const ms of [17_000, 22_000, 27_000, 32_000, 37_000]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    // Before the review fix the old send's failure started this dialog's grace,
    // and at 28s it read as an answer of ours cut short.
    expect(suppression()).toBeNull();
    expect(withheldLines()).toHaveLength(0);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('positive: the same episode cut short still starts its grace (the failed-send case above)', async () => {
    receiptAt(0);
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    sendPromptAnswer.mockRejectedValueOnce(new Error('send-keys failed'));
    expect(await tickAt(8_700, DIALOG)).toBe('error');
    for (const ms of [13_700, 18_700, 23_700]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(await tickAt(8_700 + ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS + 1, DIALOG)).toBe('no_prompt');
    expect(withheldLines().at(-1)?.[1].hint).toContain('途中で送信が止まり');
  });
});

describe('[#3796 review D] the contract that withholds the prompt now is published, whatever was recorded', () => {
  it('positive: mode-off recorded → the contract ends (record dropped) → a new contract withholds the same dialog — its reason is published', async () => {
    const task = seedContract("autoYes:\n  mode: 'off'\n");
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(5_000, DIALOG)).toBe('no_answer');
    expect(await tickAt(10_000, DIALOG)).toBe('no_prompt');
    expect(suppression()).toMatchObject({ reason: 'mode-off', at: T0 + 10_000 });
    endContract(task);
    expect(await tickAt(15_000, DIALOG)).toBe('no_prompt');
    expect(suppression()).toBeNull();

    seedContract("autoYes:\n  mode: 'safe'\n");
    // Before the review fix there was no record to refresh, so nothing was
    // published: `wait` read no reason and held the prompt as Auto-Yes's.
    for (const ms of [20_000, 25_000]) {
      expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
      expect(suppression()).toMatchObject({ reason: 'type-not-allowed', mode: 'safe', at: T0 + ms });
    }
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('positive: no record at all (accepted on another server\'s session) — a contract that comes to withhold it is published', async () => {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    vi.mocked(checkWorktreeSessionOwnership).mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' });
    expect(await tickAt(5_000, DIALOG)).toBe('no_answer');
    expect(await tickAt(10_000, DIALOG)).toBe('no_prompt');
    expect(suppression()).toBeNull();

    seedContract("autoYes:\n  mode: 'off'\n");
    clearAutoYesPolicyCache();
    expect(await tickAt(15_000, DIALOG)).toBe('no_prompt');
    expect(suppression()).toMatchObject({ reason: 'mode-off', mode: 'off', at: T0 + 15_000 });
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('negative: a partial answer still on screen keeps its own reason over the contract\'s', async () => {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await abandonedTickAt(5_000, true)).toBe('no_answer');
    expect(await tickAt(7_000, DIALOG)).toBe('no_answer');
    expect(suppression()?.reason).toBe('partial-answer');
    seedContract("autoYes:\n  mode: 'off'\n");
    clearAutoYesPolicyCache();
    expect(await tickAt(12_000, DIALOG)).toBe('no_prompt');
    expect(suppression()).toMatchObject({ reason: 'partial-answer', at: T0 + 12_000 });
  });
  // The other negative — no contract withholding, no record made — is review
  // A's "the contract ended" above, kept as it is.
});

/**
 * A tick whose answer is sent while `during` runs — inside the await of its
 * last key — and then comes back whole, at `T0 + ms`. With `restart`, Auto-Yes
 * is stopped and enabled again inside the await, as in review C.
 */
async function wholeSendTickAt(ms: number, restart: boolean, during: () => Promise<void>): Promise<string> {
  vi.setSystemTime(T0 + ms);
  setAutoYesEnabled(WORKTREE_ID, 'antigravity', true, undefined, undefined, 'antigravity');
  expect(startAutoYesPolling(WORKTREE_ID, 'antigravity', 'antigravity').started).toBe(true);
  const state = globalThis.__autoYesPollerStates!.get(KEY)!;
  const generation: AutoYesTickGeneration = {
    compositeKey: KEY,
    worktreeId: WORKTREE_ID,
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    pollerState: state,
    grant: getAutoYesState(WORKTREE_ID, 'antigravity', 'antigravity')!,
    sessionEpoch: getEnterFallbackSessionEpoch(KEY),
    startedAt: Date.now(),
  };
  sendPromptAnswer.mockImplementationOnce(async () => {
    if (restart) {
      stopAutoYesPolling(KEY);
      expect(startAutoYesPolling(WORKTREE_ID, 'antigravity', 'antigravity').started).toBe(true);
    }
    await during();
  });
  const clean = asPollerSees(frame(DIALOG));
  try {
    return await detectAndRespondToPrompt(WORKTREE_ID, state, 'antigravity', clean, clean.split('\n'), 'antigravity', undefined, generation);
  } finally {
    stopAutoYesPolling(KEY);
  }
}

describe('[#3796 review E] a send that comes back whole marks only the episode it was sent for', () => {
  it('negative: stop → enable during the last key, the successor accepts a newer receipt, the old send comes back whole — that episode\'s answer time is left alone', async () => {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    await wholeSendTickAt(5_000, true, async () => {
      expect(await tickAt(7_000, IDLE)).toBe('no_prompt');
      receiptAt(8_000);
      vi.mocked(checkWorktreeSessionOwnership).mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' });
      expect(await tickAt(10_000, DIALOG)).toBe('no_answer');
    });
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);

    for (const ms of [17_000, 22_000, 27_000, 32_000, 37_000]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    // Before the review fix the old send's return started this dialog's grace
    // at 10s, and from 28s it read as an answer of ours that outlived it.
    expect(suppression()).toBeNull();
    expect(withheldLines()).toHaveLength(0);
  });

  it('positive: the same generation\'s whole send still starts its grace', async () => {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await wholeSendTickAt(5_000, false, async () => {})).toBe('responded');
    for (const ms of [10_000, 15_000, 20_000]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(withheldLines()).toHaveLength(0);
    expect(await tickAt(5_000 + ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS + 1, DIALOG)).toBe('no_prompt');
    expect(withheldLines()).toHaveLength(1);
    expect(withheldLines()[0][1].hint).toContain('画面に残っている');
    expect(withheldLines()[0][1].hint).not.toContain('途中で送信が止まり');
  });
});
