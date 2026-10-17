/**
 * The agy receipt window is judged by when the dialog first appeared, not by the
 * clock of the tick that first read it (Issue #3767).
 *
 * Measured on a real server log: the hook answered at 02:47:49, the dialog was
 * drawn at 02:47:55 (about 6s later) and the 5s poller first read it at 02:47:58,
 * 8.7s after the receipt, outside the 8s window. Nothing arrived after that, so
 * Auto-Yes never answered. Drives the real `detectAndRespondToPrompt`, one call
 * per tick, with the system clock moved between ticks.
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
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';

const WORKTREE_ID = 'wt-3767';
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

/** Drive the real poller over one fixture, the way `pollAutoYes` does. */
async function respondTo(
  name: string,
  instanceId = 'antigravity',
): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  const clean = asPollerSees(frame(name));
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
  clearPolicySuppressions();
  resetAntigravityPermissionReceiptsForTests();
  clearAllPollerStates();
  db.close();
});


const IDLE = 'idle-after-deny';
const DIALOG = 'dialog-bash-wrapped';
const answersSent = (): string[] => sendPromptAnswer.mock.calls.map(([p]) => p.answer);
const withheldLines = (): Array<[string, Record<string, unknown>]> =>
  mockLogger.info.mock.calls.filter(([name]) => name === WITHHELD_LOG) as Array<[string, Record<string, unknown>]>;

/** One poller tick at `T0 + ms` over the named fixture. */
async function tickAt(ms: number, name: string): Promise<string> {
  vi.setSystemTime(T0 + ms);
  return respondTo(name);
}

describe('[#3767] the window is measured to the dialog\'s first appearance', () => {
  it('answers a dialog drawn 5.9s after the receipt although the next tick is 8.7s after it', async () => {
    receiptFor(); // T0
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    expect(await tickAt(8_700, DIALOG)).toBe('responded');
    expect(answersSent()).toEqual(['1']);
    expect(withheldLines()).toHaveLength(0);
  });

  it('does not answer when the first tick to see the dialog has no earlier clear tick and is past the window', async () => {
    receiptFor();
    expect(await tickAt(8_700, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('does not answer a dialog that appeared after the window closed', async () => {
    receiptFor();
    expect(await tickAt(9_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(14_000, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('does not answer a dialog first read far past the window even when the tick before it was inside', async () => {
    receiptFor();
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(30_000, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('does not answer a dialog that was on screen before the receipt arrived', async () => {
    expect(await tickAt(0, DIALOG)).toBe('no_prompt');
    vi.setSystemTime(T0 + 2_000);
    receiptFor();
    expect(await tickAt(4_000, DIALOG)).toBe('no_prompt');
    expect(await tickAt(5_000, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('spends a receipt on one dialog: a second dialog after the first is gone is not answered by it', async () => {
    receiptFor();
    expect(await tickAt(1_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(3_000, DIALOG)).toBe('responded');
    expect(await tickAt(5_000, IDLE)).toBe('no_prompt');
    sendPromptAnswer.mockClear();
    expect(await tickAt(6_000, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('a fresh receipt answers the next dialog', async () => {
    receiptFor();
    await tickAt(1_000, IDLE);
    expect(await tickAt(3_000, DIALOG)).toBe('responded');
    await tickAt(5_000, IDLE);
    vi.setSystemTime(T0 + 6_000);
    receiptFor();
    await tickAt(6_500, IDLE);
    sendPromptAnswer.mockClear();
    expect(await tickAt(7_000, DIALOG)).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });
});

describe('[#3767] no-hook-receipt is recorded and its hint tells the cases apart', () => {
  it('records lastSuppression and says no hook was ever received', async () => {
    expect(await tickAt(0, DIALOG)).toBe('no_prompt');

    expect(getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity')).toMatchObject({
      reason: 'no-hook-receipt',
      mode: null,
    });
    expect(withheldLines()[0][1].hint).toContain('一度も無い');
    expect(withheldLines()[0][1].hint).toContain('#2622');
  });

  it('says how long after the last receipt the dialog came when it was outside the window', async () => {
    receiptFor();
    await tickAt(9_000, IDLE);
    await tickAt(12_000, DIALOG);

    expect(getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity')?.reason).toBe('no-hook-receipt');
    expect(withheldLines()[0][1].hint).toContain('12 秒後');
    expect(withheldLines()[0][1].hint).toContain('窓');
  });

  it('says the receipts stopped when the last one is long gone', async () => {
    receiptFor();
    await tickAt(120_000, IDLE);
    await tickAt(125_000, DIALOG);

    expect(withheldLines()[0][1].hint).toContain('途絶えて');
    expect(withheldLines()[0][1].hint).toContain('125 秒前');
  });

  it('says the dialog was already up when the receipt arrived late', async () => {
    await tickAt(0, DIALOG);
    mockLogger.info.mockClear();
    vi.setSystemTime(T0 + 70_000);
    receiptFor();
    await tickAt(71_000, DIALOG);

    expect(withheldLines()[0][1].hint).toContain('より前から画面に');
  });

  it('records nothing when the dialog was answered', async () => {
    receiptFor();
    expect(await tickAt(1_000, DIALOG)).toBe('responded');
    expect(getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity')).toBeNull();
  });
});
