/**
 * Issue #3881, fourth review N5: on a scrollback pane the capture layer's word
 * decides the capture's top, and "filled the window" is counted in rows.
 *
 * The third review's N4 taught `captureTopOf` the capture layer's `headCut`,
 * but only on the alternate screen. On a scrollback pane (codex here) a full
 * window still won: the same whole 1000-row history, returned uncut to both
 * windows with `headCut: false`, read `history-start` under the 5000-row FULL
 * window and `clipped` under the 1000-row REDUCED one. And "full" counted
 * `split` elements, so a 999-row history read `clipped` under REDUCED when tmux
 * ended it with a newline and `history-start` when it did not. A confirm whose
 * upward scan reached the first row without a boundary was then `top-unknown`
 * under REDUCED only, and a contract with any deny pattern withheld it
 * (`deny-pattern-unusable`) while FULL and current-output answered it.
 *
 * As in `prompt-reading-capture-slice-3881.test.ts`, the real `pollAutoYes`
 * captures through the real `captureSessionOutput` and the real capture cache;
 * only the transport's `captureSnapshot` (tmux's raw output) is stood in for.
 * A pane the window really cut is still withheld.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      getTool: (id: string) => ({ getSessionName: (wt: string) => `mcbd-${id}-${wt}`, name: 'Codex' }),
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
import { detectPromptWithOptions } from '@/lib/polling/response-checker';
import { usesAlternateScreen } from '@/lib/cli-tools/types';
import { resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import { FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES } from '@/config/auto-yes-config';

const WT = 'wt-3881-scrollback';
const TOOL = 'codex';

/**
 * codex 0.155.1's run-command approval, as captured live
 * (`tests/fixtures/codex-dialogs-0155/dialog-approval-run-command.txt`): the
 * dialog's rows only, from its question to its footer, ANSI intact.
 */
const DIALOG_ROWS = readFileSync(join(process.cwd(), 'tests/fixtures/codex-dialogs-0155/dialog-approval-run-command.txt'), 'utf-8')
  .split('\n')
  .slice(18, 31);
const DENIED_ROW = '  $ rm -rf build';
/**
 * A status row at the pane's bottom. Not blank, so dropping tmux's terminator
 * leaves the row count as it is (a blank last row would make an unterminated
 * 1000-row pane the same string as a terminated 999-row one).
 */
const FOOTER_ROW = '  gpt-5.6-terra low · 100% left · ~/repo';

/** A codex pane of `height` rows: `top` rows, blank rows, the footer; tmux's raw output with or without its terminator. */
function paneRaw(top: readonly string[], height: number, terminated: boolean): string {
  const body = [...top, ...Array<string>(height - top.length - 1).fill(''), FOOTER_ROW].join('\n');
  return terminated ? `${body}\n` : body;
}

/** The whole history: the dialog from the first row down. */
const whole = (height: number, terminated: boolean) => paneRaw(DIALOG_ROWS, height, terminated);

/**
 * A history one row taller than the REDUCED window, the denied command on its
 * first row: cut to its last 1000 rows it is the dialog alone.
 */
const taller = (terminated: boolean) => paneRaw([DENIED_ROW, ...DIALOG_ROWS], REDUCED_CAPTURE_LINES + 1, terminated);

const WINDOWS = [
  ['with a stopPattern (FULL)', FULL_CAPTURE_LINES, 'NEVER-PRINTED-3881'],
  ['without a stopPattern (REDUCED)', REDUCED_CAPTURE_LINES, undefined],
] as const;

/** Height × terminator × window: every combination of the review's counter-example. */
const CASES = [999, 1000].flatMap((height) =>
  [true, false].flatMap((terminated) =>
    WINDOWS.map(([label, window, stopPattern]) => ({
      name: `${height} rows, ${terminated ? 'terminated' : 'unterminated'}, ${label}`,
      height,
      terminated,
      window,
      stopPattern,
    })),
  ),
);

function seedDenyContract(): void {
  createTask(db, {
    worktreeId: WT,
    cliToolId: TOOL,
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
  setAutoYesEnabled(WT, TOOL, true, undefined, stopPattern);
  expect(startAutoYesPolling(WT, TOOL).started).toBe(true);
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
  stopAllAutoYesPolling();
  return {
    answered: sendPromptAnswer.mock.calls.length > 0,
    reason: getLastPolicySuppression(WT, TOOL, undefined)?.reason ?? null,
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

describe('[#3881 N5] premises', () => {
  it('codex is a scrollback pane, and its confirm’s upward scan reaches the first row with no boundary', () => {
    expect(usesAlternateScreen(TOOL)).toBe(false);
    const detection = detectPromptWithOptions(whole(1000, true), TOOL);
    expect(detection.promptData?.type).toBe('multiple_choice');
    expect(detection.approvalContext).toMatchObject({ startRow: 0, completeness: 'top-unknown' });
  });
});

describe('[#3881 N5] the capture layer’s word decides a scrollback capture’s top', () => {
  it.each(CASES)('$name: uncut, so the history’s first row', async ({ height, terminated, window }) => {
    pane.raw = whole(height, terminated);
    const frame = await capturePollerFrame(WT, TOOL, window);
    expect(frame.raw).toBe(pane.raw);
    expect(frame.headCut).toBe(false);
    expect(captureTopOf(frame.raw, window, TOOL, frame.headCut)).toBe('history-start');
  });

  it.each([true, false])('a history the REDUCED window cut is clipped (terminated: %s)', async (terminated) => {
    pane.raw = taller(terminated);
    const frame = await capturePollerFrame(WT, TOOL, REDUCED_CAPTURE_LINES);
    expect(frame.headCut).toBe(true);
    expect(frame.raw.startsWith(DIALOG_ROWS[0])).toBe(true);
    expect(captureTopOf(frame.raw, REDUCED_CAPTURE_LINES, TOOL, frame.headCut)).toBe('clipped');
  });

  it('without the capture layer’s word, a full window is still clipped; "full" is counted in rows', () => {
    expect(captureTopOf(whole(1000, true), REDUCED_CAPTURE_LINES, TOOL)).toBe('clipped');
    expect(captureTopOf(whole(1000, false), REDUCED_CAPTURE_LINES, TOOL)).toBe('clipped');
    // 999 rows and a terminator are 1000 `split` elements, and still 999 rows.
    expect(whole(999, true).split('\n')).toHaveLength(REDUCED_CAPTURE_LINES);
    expect(captureTopOf(whole(999, true), REDUCED_CAPTURE_LINES, TOOL)).toBe('history-start');
    expect(captureTopOf(whole(999, false), REDUCED_CAPTURE_LINES, TOOL)).toBe('history-start');
  });
});

describe('[#3881 N5] the real poller tick on a scrollback pane', () => {
  it.each(CASES)('$name: the whole history’s confirm is answered', async ({ height, terminated, stopPattern }) => {
    seedDenyContract();
    expect(await tick(whole(height, terminated), stopPattern)).toEqual({ answered: true, reason: null });
  });

  it.each([true, false])(
    'a history the REDUCED window cut, whose cut row is the denied command, is not answered (terminated: %s)',
    async (terminated) => {
      seedDenyContract();
      expect(await tick(taller(terminated), undefined)).toEqual({ answered: false, reason: 'deny-pattern-unusable' });
    },
  );

  it.each([true, false])('the same history under FULL is denied by its first row (terminated: %s)', async (terminated) => {
    seedDenyContract();
    expect(await tick(taller(terminated), 'NEVER-PRINTED-3881')).toEqual({ answered: false, reason: 'deny-pattern' });
  });

  it('陰性対照: no deny patterns — the cut history is answered', async () => {
    expect((await tick(taller(true), undefined)).answered).toBe(true);
  });
});
