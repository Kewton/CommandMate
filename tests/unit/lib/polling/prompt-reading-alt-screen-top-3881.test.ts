/**
 * Issue #3881, second review N1: an alternate-screen capture's top is read off
 * the screen, not off "fewer rows than the window".
 *
 * The first fix read a capture with fewer rows than its window as the start of
 * the pane's history. That holds for a scrollback pane. Claude, copilot and
 * opencode draw in the alternate screen, which keeps no history: the capture
 * is the visible screen whatever the window. So
 *
 * - a short pane whose content has scrolled (full to its bottom row, the
 *   command's first rows gone) read as `history-start` under the 5000-row
 *   FULL window a stopPattern grant captures with — and under the 1000-row
 *   REDUCED one — and its deny miss was answered;
 * - a fresh 1000-row screen (top margin, the dialog, blank rows to the bottom)
 *   read as `clipped` under the REDUCED window only because it has 1000 rows,
 *   and a complete short dialog was withheld.
 *
 * Both are driven through the real `detectAndRespondToPrompt` with a real
 * contract in a migrated database, under both windows (with and without a
 * stopPattern, `pollAutoYes`' `grant.stopPattern ? FULL : REDUCED`).
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
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
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
import { readStoredPromptReading } from '@/lib/detection/prompt-reading';
import { resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import { FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES } from '@/config/auto-yes-config';
import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';
import { usesAlternateScreen } from '@/lib/cli-tools/types';

const WORKTREE_ID = 'wt-3881-alt';

const PROMPT_ROWS = [
  'Do you want to make this edit to cleanup.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  '',
  'Esc to cancel · Tab to amend',
];

/**
 * A 10-row claude pane whose content scrolled: full to its bottom row, the top
 * margin row blank (as `head-cut-200x12.txt` draws it) and the rows where the
 * command began gone. Nothing visible names `rm -rf`.
 */
function scrolledScreen(): string {
  return ['', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS].join('\n');
}

/**
 * A fresh 1000-row claude pane: the top margin row, the dialog, and blank rows
 * to the bottom — the whole of what the tool drew is on screen.
 */
function wholeScreen(): string {
  const rows = ['', '     12 +    cleanupTargets(root)', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS];
  return [...rows, ...Array<string>(TUI_PANE_HEIGHT - rows.length).fill('')].join('\n');
}

const DENY_RM = "autoYes:\n  denyPatterns: ['rm -rf']\n";
/** The two windows `pollAutoYes` captures with: a grant with a stopPattern, and one without. */
const WINDOWS = [
  ['with a stopPattern (FULL)', FULL_CAPTURE_LINES],
  ['without a stopPattern (REDUCED)', REDUCED_CAPTURE_LINES],
] as const;

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

function tick(frame: string, window: number): Promise<string> {
  return detectAndRespondToPrompt(
    WORKTREE_ID, pollerState(), 'claude', frame, frame.split('\n'), undefined, frame, undefined, undefined, window,
  );
}

/** What the resolver does with `frame` read under `captureTop`, against the deny contract. */
function resolvedUnder(frame: string, captureTop: ReturnType<typeof captureTopOf>) {
  const detection = withCaptureTopCompleteness(detectPromptWithOptions(frame, 'claude'), captureTop);
  return resolveAutoAnswerWithPolicy(
    detection.promptData!,
    { mode: null, allowPromptTypes: [], denyPatterns: ['rm -rf'] },
    'claude',
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

describe('[#3881 N1] premises', () => {
  it('claude draws in the alternate screen; the REDUCED window is its pane height', () => {
    expect(usesAlternateScreen('claude')).toBe(true);
    expect(REDUCED_CAPTURE_LINES).toBe(TUI_PANE_HEIGHT);
    expect(FULL_CAPTURE_LINES).toBeGreaterThan(TUI_PANE_HEIGHT);
  });

  it.each([
    ['scrolled', scrolledScreen],
    ['whole', wholeScreen],
  ])('the %s screen’s target scan reaches its first row with no boundary', (_label, frame) => {
    expect(detectPromptWithOptions(frame(), 'claude').approvalContext?.completeness).toBe('top-unknown');
  });
});

describe('[#3881 N1] captureTopOf reads an alternate screen off the screen', () => {
  it.each(WINDOWS)('scrolled screen, window %s: screen-full', (_label, window) => {
    expect(captureTopOf(scrolledScreen(), window, 'claude')).toBe('screen-full');
    expect(captureTopOf(`${scrolledScreen()}\n`, window, 'claude')).toBe('screen-full');
  });

  it.each(WINDOWS)('whole screen, window %s: screen-start', (_label, window) => {
    expect(captureTopOf(wholeScreen(), window, 'claude')).toBe('screen-start');
    // tmux ends every row with a newline; the last one is not a row.
    // Issue #3881 (second half, contract decision (5b)): at a window of
    // exactly the pane height, the 1000-row spelling fills the window, and
    // only the capture layer's word (`headCut === false`) says it was not cut;
    // unreported, it is `clipped` (prompt-reading-headcut-unreported-3881).
    const reported = window === REDUCED_CAPTURE_LINES ? false : undefined;
    expect(captureTopOf(`${wholeScreen()}\n`, window, 'claude', reported)).toBe('screen-start');
  });

  it('a content row on the top row is screen-full even with room below', () => {
    expect(captureTopOf(wholeScreen().replace(/^/, 'x'), REDUCED_CAPTURE_LINES, 'claude')).toBe('screen-full');
  });

  it('a window narrower than the pane that the capture filled is clipped', () => {
    expect(captureTopOf(wholeScreen(), 200, 'claude')).toBe('clipped');
  });

  it('陽性対照: read as a scrollback pane (the first fix), the two screens swap', () => {
    for (const [, window] of WINDOWS) expect(captureTopOf(scrolledScreen(), window)).toBe('history-start');
    // Issue #3881 (fourth review N5): "filled" counts rows, so the 1000-row
    // screen is spelled as tmux returns it (terminated); `wholeScreen()` alone
    // ends in a blank row, which reads as 999 rows and a terminator.
    expect(captureTopOf(`${wholeScreen()}\n`, REDUCED_CAPTURE_LINES)).toBe('clipped');
    // …and the resolver followed: the scrolled screen's deny miss passed, the whole one was withheld.
    expect(resolvedUnder(scrolledScreen(), 'history-start')).toMatchObject({ suppressedBy: null });
    expect(resolvedUnder(wholeScreen(), 'clipped')).toMatchObject({ suppressedBy: 'deny-pattern-unusable' });
  });

  it('陰性対照: a scrollback pane is read as before', () => {
    expect(usesAlternateScreen('codex')).toBe(false);
    expect(captureTopOf(scrolledScreen(), FULL_CAPTURE_LINES, 'codex')).toBe('history-start');
    // Issue #3881 (fourth review N5): "filled" counts rows, so the 1000-row
    // screen is spelled as tmux returns it (terminated); `wholeScreen()` alone
    // ends in a blank row, which reads as 999 rows and a terminator.
    expect(captureTopOf(`${wholeScreen()}\n`, REDUCED_CAPTURE_LINES, 'codex')).toBe('clipped');
    expect(captureTopOf(wholeScreen(), FULL_CAPTURE_LINES, 'codex')).toBe('history-start');
  });

  it('the stored reading keeps the screen reading', () => {
    const detection = detectPromptWithOptions(scrolledScreen(), 'claude');
    const reading = readPromptScreen('claude', scrolledScreen(), detection, 'screen-full');
    expect(readStoredPromptReading({ reading })).toMatchObject({ approvalTarget: 'top-unknown', captureTop: 'screen-full' });
    expect(readStoredPromptReading({ reading: { ...reading, captureTop: 'screen-start' } })?.captureTop).toBe(
      'screen-start',
    );
    expect(readStoredPromptReading({ reading: { ...reading, captureTop: 'screen' } })).toBeNull();
  });
});

describe('[#3881 N1] the poller, with and without a stopPattern', () => {
  it.each(WINDOWS)('scrolled screen %s: withheld as deny-pattern-unusable', async (_label, window) => {
    seedContract(DENY_RM);
    expect(await tick(scrolledScreen(), window)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude', undefined)).toMatchObject({
      reason: 'deny-pattern-unusable',
    });
  });

  it.each(WINDOWS)('陰性対照: whole screen %s: answered', async (_label, window) => {
    seedContract(DENY_RM);
    expect(await tick(wholeScreen(), window)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('陰性対照: no deny patterns — the scrolled screen is answered', async () => {
    expect(await tick(scrolledScreen(), FULL_CAPTURE_LINES)).toBe('responded');
  });
});
