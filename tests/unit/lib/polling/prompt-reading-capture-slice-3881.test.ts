/**
 * Issue #3881, third review N4: the capture's top is judged on what the
 * capture layer actually returned, terminator and slice included.
 *
 * tmux ends every row with a newline, so a 1000-row alternate screen comes
 * back as 1000 rows and a terminator — 1001 `split` elements. `sliceOutput`
 * counted elements, so the poller's 1000-row REDUCED window dropped the
 * screen's first row, and `captureTopOf` (window ≥ `TUI_PANE_HEIGHT`, so
 * "not clipped") then read the rest off the screen:
 *
 * - the whole screen lost its blank top margin and read `screen-full` under
 *   REDUCED only, so a stopPattern grant (FULL) answered it and one without
 *   withheld it;
 * - a screen whose first row held the denied command, with a blank row under
 *   it, lost exactly that row and read `screen-start`: answered under a
 *   contract that denies the command;
 * - a pane one row taller than the window was cut to rows that look like a
 *   whole screen, and the row count could not say it was cut.
 *
 * Unlike `prompt-reading-alt-screen-top-3881.test.ts`, nothing here hands the
 * poller a frame: the real `pollAutoYes` captures through the real
 * `captureSessionOutput` and the real capture cache, and only the transport's
 * `captureSnapshot` (tmux's raw output, terminator included) is stood in for.
 * Both windows run: a grant with a stopPattern (FULL) and one without
 * (REDUCED).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

/** tmux's raw `capture-pane` output for the session, swapped per test. */
const pane = vi.hoisted(() => ({ raw: '' }));
const transport = vi.hoisted(() => ({
  sessionExists: vi.fn(async () => true),
  captureSnapshot: vi.fn(async () => pane.raw),
}));
vi.mock('@/lib/tmux/polling-tmux-transport', () => ({ getPollingTmuxTransport: () => transport }));
vi.mock('@/lib/session/cli-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/cli-session')>()),
  // The only other cli-session call of the tick: no tmux here.
  getSessionPresence: vi.fn(async () => 'present'),
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
const sendPromptAnswer = vi.fn(async () => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (...args: unknown[]) => sendPromptAnswer(...(args as [])),
}));
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
  clearPromptHashCache: vi.fn(),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({ getSessionName: (wt: string) => `mcbd-${id}-${wt}`, name: 'Claude' }),
    }),
  },
}));
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { ...log, withContext: () => log };
  },
}));

import { createTask } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { clearAllAutoYesStates, POLLING_INTERVAL_MS, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAllPollerStates, startAutoYesPolling, stopAllAutoYesPolling } from '@/lib/auto-yes-poller';
import { capturePollerFrame } from '@/lib/polling/auto-yes-poller-capture';
import { captureTopOf } from '@/lib/polling/prompt-screen-reading';
import { resetCacheForTesting, sliceOutput } from '@/lib/tmux/tmux-capture-cache';
import { FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES } from '@/config/auto-yes-config';
import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';

const WT = 'wt-3881-slice';

const PROMPT_ROWS = [
  'Do you want to make this edit to cleanup.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  '',
  'Esc to cancel · Tab to amend',
];
const DENIED_ROW = '     11 +    execSync(`rm -rf ${root}`)';

/** `rows`, padded with blank rows to `height`, as tmux returns them: every row ends with a newline. */
function tmuxRaw(rows: readonly string[], height: number): string {
  return `${[...rows, ...Array<string>(height - rows.length).fill('')].join('\n')}\n`;
}

/** A fresh 1000-row claude pane: the top margin row, the dialog, blank rows to the bottom. */
const WHOLE = tmuxRaw(['', '     12 +    cleanupTargets(root)', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS], TUI_PANE_HEIGHT);

/** A 1000-row claude pane whose first row is the denied command, a blank row under it (the review's case). */
const DENIED_FIRST = tmuxRaw([DENIED_ROW, '', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS], TUI_PANE_HEIGHT);

/**
 * A pane one row taller than the REDUCED window: the denied command on its
 * first row, two blank rows under it. Cut to its last 1000 rows it begins and
 * ends with a blank row, the shape of a whole screen.
 */
const TALLER = tmuxRaw(
  [DENIED_ROW, '', '', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS],
  TUI_PANE_HEIGHT + 1,
);

const WINDOWS = [
  ['with a stopPattern (FULL)', FULL_CAPTURE_LINES, 'NEVER-PRINTED-3881'],
  ['without a stopPattern (REDUCED)', REDUCED_CAPTURE_LINES, undefined],
] as const;

function seedDenyContract(): void {
  createTask(db, {
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      "version: 1\ntitle: a task\ngoal: do the thing\nscope:\n  allow: [\"src/**\"]\nautoYes:\n  denyPatterns: ['rm -rf']\n",
      'task.yaml',
    ),
    status: 'running',
  });
}

/** One real poller tick on `raw` under `stopPattern`'s window: answered, and the reason it recorded if not. */
async function tick(raw: string, stopPattern: string | undefined) {
  pane.raw = raw;
  setAutoYesEnabled(WT, 'claude', true, undefined, stopPattern);
  expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
  stopAllAutoYesPolling();
  return {
    answered: sendPromptAnswer.mock.calls.length > 0,
    reason: getLastPolicySuppression(WT, 'claude', undefined)?.reason ?? null,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  db = new Database(':memory:');
  runMigrations(db);
  resetCacheForTesting();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearAllAutoYesStates();
  clearAllPollerStates();
  sendPromptAnswer.mockClear();
  transport.captureSnapshot.mockClear();
});

afterEach(() => {
  stopAllAutoYesPolling();
  clearAllPollerStates();
  clearAllAutoYesStates();
  resetCacheForTesting();
  db.close();
  vi.useRealTimers();
});

describe('[#3881 N4] the capture layer counts rows, not split elements', () => {
  it('a 1000-row pane asked for 1000 rows comes back whole, and says it was not cut', async () => {
    for (const [, window] of WINDOWS) {
      resetCacheForTesting();
      pane.raw = WHOLE;
      const frame = await capturePollerFrame(WT, 'claude', window);
      expect(frame.raw).toBe(WHOLE);
      expect(frame.headCut).toBe(false);
    }
  });

  it('a pane taller than the window is cut, and the capture says so', async () => {
    pane.raw = TALLER;
    const reduced = await capturePollerFrame(WT, 'claude', REDUCED_CAPTURE_LINES);
    expect(reduced.headCut).toBe(true);
    expect(reduced.raw.startsWith('\n\n     13 +')).toBe(true);
    // Served from the cache this time: the same answer.
    expect(transport.captureSnapshot).toHaveBeenCalledTimes(1);
    expect((await capturePollerFrame(WT, 'claude', FULL_CAPTURE_LINES)).headCut).toBe(false);
    expect((await capturePollerFrame(WT, 'claude', REDUCED_CAPTURE_LINES)).headCut).toBe(true);
    expect(transport.captureSnapshot).toHaveBeenCalledTimes(1);
  });

  it('陽性対照: counted in split elements (the old slice), the first row went', () => {
    const elements = WHOLE.split('\n');
    expect(elements).toHaveLength(TUI_PANE_HEIGHT + 1);
    const oldSlice = elements.slice(-REDUCED_CAPTURE_LINES).join('\n');
    expect(oldSlice.startsWith('     12 +')).toBe(true);
    expect(captureTopOf(oldSlice, REDUCED_CAPTURE_LINES, 'claude')).toBe('screen-full');
    expect(sliceOutput(WHOLE, REDUCED_CAPTURE_LINES)).toBe(WHOLE);
  });

  it('陽性対照: without the capture layer’s word, the cut taller pane reads as a whole screen', async () => {
    pane.raw = TALLER;
    const { raw } = await capturePollerFrame(WT, 'claude', REDUCED_CAPTURE_LINES);
    // Issue #3881 (second half, contract decision (5b)): no longer. Without
    // the capture layer's word a capture that filled its 1000-row window is
    // `clipped`, not read off the screen's blank edges — the hole this
    // control documented is closed.
    expect(captureTopOf(raw, REDUCED_CAPTURE_LINES, 'claude')).toBe('clipped');
    expect(captureTopOf(raw, REDUCED_CAPTURE_LINES, 'claude', true)).toBe('clipped');
  });
});

describe('[#3881 N4] the real poller tick, with and without a stopPattern', () => {
  it.each(WINDOWS)('the whole screen %s is answered', async (_label, _window, stopPattern) => {
    seedDenyContract();
    expect(await tick(WHOLE, stopPattern)).toEqual({ answered: true, reason: null });
  });

  it.each(WINDOWS)('the denied command on the first row %s is not answered', async (_label, _window, stopPattern) => {
    seedDenyContract();
    const verdict = await tick(DENIED_FIRST, stopPattern);
    expect(verdict.answered).toBe(false);
    expect(['deny-pattern', 'deny-pattern-unusable']).toContain(verdict.reason);
  });

  it('a pane the REDUCED window cut, whose cut row is the denied command, is not answered', async () => {
    seedDenyContract();
    expect(await tick(TALLER, undefined)).toEqual({ answered: false, reason: 'deny-pattern-unusable' });
  });

  it('陰性対照: no deny patterns — the cut pane is answered', async () => {
    expect((await tick(TALLER, undefined)).answered).toBe(true);
  });
});
