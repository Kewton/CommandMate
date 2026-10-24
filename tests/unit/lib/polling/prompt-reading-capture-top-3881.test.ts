/**
 * Issue #3881 review P2-1: an approval target whose upward scan reached the
 * top of a CUT capture is not the whole request.
 *
 * Every capture is the last N rows of the pane (`captureSessionOutput` →
 * `sliceOutput`). When the scan above a prompt reaches the frame's first row
 * without a boundary, the reading is `top-unknown`; the first change of #3881
 * kept that on the detection only, so the resolver read the target as
 * complete. A confirm whose command began above the capture — and whose rest
 * fell within 12 rows — was answered under a contract that denies it.
 *
 * Now the capture's extent decides: a capture that filled its window
 * (`clipped`) may be cut there, and the prompt carries
 * `approvalTargetCompleteness: 'top-unknown'`; one shorter than its window
 * (`history-start`) holds the pane's whole history and is read as before.
 *
 * Driven through the real `detectAndRespondToPrompt` with a real contract in a
 * migrated database, on the 1000-row Claude layout of Issue #1167 (the
 * poller's REDUCED window is the pane height, 1000 rows).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async () => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (...args: unknown[]) => sendPromptAnswer(...(args as [])),
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>()),
  invalidateCache: vi.fn(),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `claude-${id}`, name: 'Claude' }),
    }),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createTask } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { detectAndRespondToPrompt, clearAllPollerStates, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { detectPromptWithOptions } from '@/lib/polling/response-checker';
import {
  captureTopOf,
  readPromptScreen,
  withCaptureTopCompleteness,
} from '@/lib/polling/prompt-screen-reading';
import { isCaptureWindowSaturated } from '@/lib/tmux/tmux-capture-cache';
import { resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import { REDUCED_CAPTURE_LINES } from '@/config/auto-yes-config';

const WORKTREE_ID = 'wt-3881-top';
const PANE_ROWS = 1000;

/**
 * Claude's edit approval at the top of a 1000-row pane whose first rows are
 * the tail of the panel's body — the rows above it (where the command began)
 * are outside the capture. Nothing visible names `rm -rf`.
 */
function cutTopFrame(): string {
  const lines = Array<string>(PANE_ROWS).fill('');
  lines[0] = '     12 +    cleanupTargets(root)';
  lines[1] = '     13 +    return root';
  lines[2] = '     14 +  }';
  lines[4] = 'Do you want to make this edit to cleanup.ts?';
  lines[5] = '❯ 1. Yes';
  lines[6] = '  2. Yes, allow all edits during this session (shift+tab)';
  lines[7] = '  3. No';
  lines[9] = 'Esc to cancel · Tab to amend';
  return lines.join('\n');
}

/** The same panel under a boundary: the previous turn's `⏺` row is on screen. */
function boundedFrame(): string {
  const lines = cutTopFrame().split('\n');
  lines.unshift('⏺ Update(cleanup.ts)');
  lines.pop();
  return lines.join('\n');
}

const DENY_RM = "autoYes:\n  denyPatterns: ['rm -rf']\n";

function seedContract(autoYes: string): void {
  createTask(db, {
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1\ntitle: a task\ngoal: do the thing\nscope:\n  allow: ["src/**"]\n${autoYes}`,
      'task.yaml',
    ),
    status: 'running',
  });
}

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One tick on `frame`, captured with a `window`-row window (undefined: a direct caller). */
function tick(frame: string, window: number | undefined): Promise<string> {
  return detectAndRespondToPrompt(
    WORKTREE_ID, pollerState(), 'claude', frame, frame.split('\n'), undefined, frame, undefined, undefined, window,
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearAllPollerStates();
  sendPromptAnswer.mockClear();
});

afterEach(() => {
  db.close();
});

describe('[#3881 P2-1] captureTopOf is #1670’s saturation test on the row count', () => {
  it.each([
    [999, 1000],
    [1000, 1000],
    [1001, 1000],
    [12, 5000],
    [5000, 5000],
    [3, 0],
  ])('%i rows in a %i-row window', (rows, window) => {
    const capture = Array<string>(rows).fill('x').join('\n');
    expect(captureTopOf(capture, window) === 'clipped').toBe(isCaptureWindowSaturated(rows, window));
  });
});

describe('[#3881 P2-1] the detection carries a cut top to the prompt', () => {
  it('premise: the scan reaches the frame’s first row with no boundary', () => {
    const detection = detectPromptWithOptions(cutTopFrame(), 'claude');
    expect(detection.approvalContext?.completeness).toBe('top-unknown');
    expect(detection.promptData).not.toHaveProperty('approvalTargetCompleteness');
  });

  it('clipped: the prompt says `top-unknown`, and the resolver withholds on a deny miss', () => {
    const detection = withCaptureTopCompleteness(detectPromptWithOptions(cutTopFrame(), 'claude'), 'clipped');
    expect(detection.promptData?.approvalTargetCompleteness).toBe('top-unknown');
    const policy = { mode: null, allowPromptTypes: [], denyPatterns: ['rm -rf'] };
    expect(resolveAutoAnswerWithPolicy(detection.promptData!, policy, 'claude')).toMatchObject({
      answer: null,
      suppressedBy: 'deny-pattern-unusable',
    });
  });

  it('陰性対照: history-start leaves the detection as it is', () => {
    const detection = detectPromptWithOptions(cutTopFrame(), 'claude');
    expect(withCaptureTopCompleteness(detection, 'history-start')).toBe(detection);
  });

  it('陰性対照: a target bounded by a marker is complete whatever the capture', () => {
    const detection = detectPromptWithOptions(boundedFrame(), 'claude');
    expect(detection.approvalContext?.completeness).toBe('complete');
    expect(withCaptureTopCompleteness(detection, 'clipped')).toBe(detection);
  });

  it('the stored reading records where the frame began', () => {
    const detection = detectPromptWithOptions(cutTopFrame(), 'claude');
    expect(readPromptScreen('claude', cutTopFrame(), detection, 'clipped')).toMatchObject({
      approvalTarget: 'top-unknown',
      captureTop: 'clipped',
    });
  });
});

describe('[#3881 P2-1] the poller does not answer a cut target under a deny contract', () => {
  it('clipped capture (1000 rows in the 1000-row window): withheld as deny-pattern-unusable', async () => {
    expect(PANE_ROWS).toBe(REDUCED_CAPTURE_LINES);
    seedContract(DENY_RM);
    expect(await tick(cutTopFrame(), REDUCED_CAPTURE_LINES)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude', undefined)).toMatchObject({
      reason: 'deny-pattern-unusable',
    });
  });

  it('陽性対照: the same tick without the window (the pre-fix reading) answers it', async () => {
    seedContract(DENY_RM);
    expect(await tick(cutTopFrame(), undefined)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('陰性対照: a short capture taken from the start of the history is answered', async () => {
    // 1000 rows in the 5000-row FULL window: the pane holds nothing above them.
    seedContract(DENY_RM);
    expect(await tick(cutTopFrame(), 5000)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('陰性対照: no deny patterns, nothing to miss — answered on a clipped capture', async () => {
    expect(await tick(cutTopFrame(), REDUCED_CAPTURE_LINES)).toBe('responded');
  });

  it('陰性対照: a bounded target on a clipped capture is answered', async () => {
    seedContract(DENY_RM);
    expect(await tick(boundedFrame(), REDUCED_CAPTURE_LINES)).toBe('responded');
  });
});
