/**
 * The leftovers of #3767's review (Issue #3789): an answered agy dialog that
 * stays up, the read gap, the 7s carry threshold and a receipt spent on a
 * dialog that was already answered. Same harness as
 * auto-yes-poller-antigravity-receipt-window-3767.test.ts: the real
 * `detectAndRespondToPrompt`, one call per tick, the clock moved between ticks.
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
import { getLastPolicySuppression, recordPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { checkWorktreeSessionOwnership } from '@/lib/cli-tools/worktree-session-ownership';
import {
  ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS,
  ANTIGRAVITY_PERMISSION_RECEIPT_OBSERVATION_SLACK_MS,
  getAntigravityReceiptVerdict,
} from '@/lib/polling/antigravity-receipt-episodes';
import {
  ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS,
  hasRecentAntigravityPermissionReceipt,
} from '@/lib/polling/antigravity-permission-receipts';
import { COOLDOWN_INTERVAL_MS } from '@/lib/auto-yes-state';

const WORKTREE_ID = 'wt-3789';
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

const OTHER_DIALOG = 'dialog-bash-oneline';
const suppression = () => getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity');

describe('[#3789] 1 (M2-a): an answered dialog that stays up is recorded once the grace is over', () => {
  it('the grace is the window, the slack and the cooldown after an answer', () => {
    expect(ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS).toBe(
      ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS + ANTIGRAVITY_PERMISSION_RECEIPT_OBSERVATION_SLACK_MS + COOLDOWN_INTERVAL_MS,
    );
    expect(ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS).toBe(18_000);
  });

  it('records no-hook-receipt with an `outlived` hint once the grace has passed since the answer', async () => {
    receiptAt(0);
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    expect(await tickAt(8_700, DIALOG)).toBe('responded'); // accepted at 8.7s
    sendPromptAnswer.mockClear();
    for (const ms of [13_700, 18_700, 23_700, 26_700]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(suppression()).toBeNull();
    expect(withheldLines()).toHaveLength(0);

    expect(await tickAt(28_700, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppression()).toMatchObject({ reason: 'no-hook-receipt', mode: null });
    expect(withheldLines()).toHaveLength(1);
    expect(withheldLines()[0][1].hint).toContain('画面に残っている');
    expect(withheldLines()[0][1].hint).toContain('18 秒');
  });

  it('control: within the grace the dialog still up stays silent and is not answered again', async () => {
    receiptAt(0);
    expect(await tickAt(3_000, IDLE)).toBe('no_prompt');
    expect(await tickAt(5_000, DIALOG)).toBe('responded'); // accepted at 5s
    sendPromptAnswer.mockClear();
    for (let ms = 10_000; ms <= 23_000; ms += 1_000) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppression()).toBeNull();
    expect(withheldLines()).toHaveLength(0);
  });

  it('control: the dialog taken down within the grace records nothing', async () => {
    receiptAt(0);
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    expect(await tickAt(8_700, DIALOG)).toBe('responded');
    expect(await tickAt(13_700, DIALOG)).toBe('no_prompt');
    expect(await tickAt(18_700, IDLE)).toBe('no_prompt');
    expect(await tickAt(30_000, IDLE)).toBe('no_prompt');
    expect(suppression()).toBeNull();
    expect(withheldLines()).toHaveLength(0);
  });
});

describe('[#3789] review M-1: the grace starts at a send, not at the acceptance', () => {
  it('a dialog accepted but not sent to (another server\'s session) is not reported as outliving an answer', async () => {
    receiptAt(0);
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    vi.mocked(checkWorktreeSessionOwnership).mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' });
    expect(await tickAt(8_700, DIALOG)).toBe('no_answer'); // accepted, nothing sent
    for (const ms of [13_700, 18_700, 23_700, 28_700, 33_700]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppression()).toBeNull();
    expect(withheldLines()).toHaveLength(0);
  });

  it('a reason the poller recorded inside the window is not overwritten after the grace', async () => {
    receiptAt(0);
    expect(await tickAt(3_700, IDLE)).toBe('no_prompt');
    vi.mocked(checkWorktreeSessionOwnership).mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' });
    expect(await tickAt(8_700, DIALOG)).toBe('no_answer');
    // Stands in for the reason a no-send exit records on its tick (step 2.5's
    // partial-answer and the like), whatever the exit was.
    recordPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity', {
      reason: 'partial-answer',
      mode: null,
      promptType: 'multiple_choice',
    });
    for (const ms of [13_700, 18_700, 23_700, 28_700]) expect(await tickAt(ms, DIALOG)).toBe('no_prompt');
    expect(suppression()?.reason).toBe('partial-answer');
    expect(withheldLines()).toHaveLength(0);
  });
});

// KNOWN WEAKNESS, pinned on purpose (not fixed): across a read gap the episode
// is dropped, so a dialog that was up BEFORE the receipt is answered when the
// receipt is within the window — the "predates" protection is lost, exactly as
// develop's old tick test lost it. See the commit of #3789 for why.
describe('[#3789] 2: a gap in the reads drops the episode (not fixed; the old tick test)', () => {
  it('control: read every 5s, a dialog up before the receipt is still `predates`', async () => {
    expect(await tickAt(0, DIALOG)).toBe('no_prompt');
    receiptAt(3_000);
    expect(await tickAt(5_000, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    // The withheld line went out at 0s (`never`) and is limited to one a minute.
    expect(getAntigravityReceiptVerdict(WORKTREE_ID, 'antigravity')?.cause).toBe('predates');
  });

  it('known weakness: after a gap longer than the carry, a dialog up before the receipt is judged by the old tick test, both ways', async () => {
    expect(await tickAt(0, DIALOG)).toBe('no_prompt');
    // No reads for 20s. Nothing is known of the screen in between, so the dialog
    // read next is judged on its own first sighting, as develop judged every tick.
    receiptAt(18_000);
    vi.setSystemTime(T0 + 20_000);
    const old = hasRecentAntigravityPermissionReceipt(WORKTREE_ID, 'antigravity', 'antigravity');
    expect(old).toBe(true);
    expect(await tickAt(20_000, DIALOG)).toBe('responded');

    sendPromptAnswer.mockClear();
    // The same gap with the receipt outside the window: both refuse.
    expect(await tickAt(60_000, DIALOG)).toBe('no_prompt');
    expect(hasRecentAntigravityPermissionReceipt(WORKTREE_ID, 'antigravity', 'antigravity')).toBe(false);
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});

describe('[#3789] 3: the 7s carry against the widest measured read gap', () => {
  // Measured on the server logs of 2026-10-10..18 (poller:response-sent, 77
  // agy and 366 Command Code pairs): the tick overhead on top of the 5s / 2s
  // intervals was 0.02–0.25s, at most 0.63s, so the widest read gap is ~5.63s.
  it('carries the clear read over a 5.63s gap: the measured case is still answered', async () => {
    receiptAt(0);
    expect(await tickAt(3_070, IDLE)).toBe('no_prompt');
    expect(await tickAt(8_700, DIALOG)).toBe('responded');
  });

  it('control: past 7s the clear read no longer bounds the appearance', async () => {
    receiptAt(0);
    expect(await tickAt(1_690, IDLE)).toBe('no_prompt');
    expect(await tickAt(8_700, DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});

describe('[#3789] 4 (L2): a newer receipt spent on the answered dialog (not fixed; now reported)', () => {
  // One poller state across the ticks, as `pollAutoYes` keeps it, so that the
  // duplicate-prompt guard holds a dialog that is still up inside the window.
  let shared: AutoYesPollerState;
  beforeEach(() => {
    shared = pollerState();
  });
  async function sharedTickAt(ms: number, name: string): Promise<string> {
    vi.setSystemTime(T0 + ms);
    const clean = asPollerSees(frame(name));
    return detectAndRespondToPrompt(WORKTREE_ID, shared, 'antigravity', clean, clean.split('\n'), 'antigravity');
  }

  /** A answered on R1 stays up; R2 arrives; the next read of A spends R2. */
  async function staleDialogSpendsTheNewerReceipt(): Promise<void> {
    receiptAt(0);
    expect(await sharedTickAt(1_000, IDLE)).toBe('no_prompt');
    expect(await sharedTickAt(3_000, DIALOG)).toBe('responded');
    expect(await sharedTickAt(9_000, DIALOG)).toBe('no_prompt');
    receiptAt(10_000);
    expect(await sharedTickAt(12_000, DIALOG)).toBe('responded'); // accepted at 12s on R2
    sendPromptAnswer.mockClear();
  }

  it('B replacing A with no clear read in between, past the window, is reported once the grace is over', async () => {
    await staleDialogSpendsTheNewerReceipt();
    // A still up inside R2's window: the poller's own dedup holds it.
    expect(await sharedTickAt(17_000, DIALOG)).toBe('duplicate');
    // B replaced A between two reads, read past R2's window.
    for (const ms of [19_000, 24_000, 29_000]) expect(await sharedTickAt(ms, OTHER_DIALOG)).toBe('no_prompt');
    expect(suppression()).toBeNull();
    expect(withheldLines()).toHaveLength(0);

    expect(await sharedTickAt(31_000, OTHER_DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppression()?.reason).toBe('no-hook-receipt');
    expect(withheldLines().at(-1)?.[1].hint).toContain('入れ替わった');
  });

  it('control: with a clear read in between, B is `used` at once, as before', async () => {
    await staleDialogSpendsTheNewerReceipt();
    expect(await sharedTickAt(17_000, IDLE)).toBe('no_prompt');
    expect(await sharedTickAt(19_000, OTHER_DIALOG)).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(suppression()?.reason).toBe('no-hook-receipt');
    expect(withheldLines().at(-1)?.[1].hint).toContain('使い済み');
  });
});
