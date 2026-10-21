/**
 * The Auto-Yes confirmation ledger is cleaned up by the worktree, not by the
 * pollers that happen to be running (Issue #3820 PR 2, review items 1 and 3;
 * design `docs/design/auto-yes-measurement-3820.md` §4.2).
 *
 * An opencode approval is a confirmation of the ledger even with Auto-Yes off,
 * when no poller runs for its instance. The real entry points are driven —
 * `cleanupWorktreeSessions` (a worktree deleted), the lifecycle table, the
 * auto-yes route's two OFF calls — and the ledger's own lines are read.
 *
 * Positive control: before this change `stopAutoYesPollingByWorktree` told the
 * ledger only about the keys of running pollers, so the deleted worktree's
 * approval stayed open (and on every checkpoint), and the whole-worktree OFF
 * left its withheld interval running. Negative controls: another worktree's
 * approval is untouched, and a screen confirmation under a running poller still
 * turns unobservable at the OFF, as before.
 *
 * Only tmux (`child_process.execFile`), the session-ownership probe and the
 * other managers are stood in for; timers are fake.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ledgerLog = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('@/lib/logger', () => {
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, withContext: () => quiet };
  const make = (module: string) => {
    if (module !== 'auto-yes-confirmation-ledger') return quiet;
    const logger = { ...quiet, info: ledgerLog.info, withContext: () => logger };
    return logger;
  };
  return { createLogger: make, generateRequestId: () => 'req' };
});

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
  clearPromptHashCache: vi.fn(),
}));
vi.mock('@/lib/schedule-manager', () => ({
  stopScheduleForWorktree: vi.fn(),
  getScheduleWorktreeIds: vi.fn(() => []),
}));
vi.mock('@/lib/timer-manager', () => ({
  stopTimersForWorktree: vi.fn(),
  getTimerWorktreeIds: vi.fn(() => []),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `claude-${id}`, name: 'Claude' }),
    }),
  },
}));
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => ({
    prepare: () => ({ get: () => undefined, run: () => undefined, all: () => [] }),
  }),
}));

import { buildCompositeKey, clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  clearAllPollerStates,
  startAutoYesPolling,
  stopAutoYesPolling,
  stopAutoYesPollingByWorktree,
} from '@/lib/auto-yes-poller';
import { stopAutoYesPollersFor } from '@/lib/auto-yes-lifecycle';
import { cleanupWorktreeSessions } from '@/lib/session-cleanup';
import { resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import {
  AUTO_YES_LEDGER_CLOCK_MS,
  beginLedgerApiAdjudication,
  beginLedgerTick,
  observeLedgerScreen,
  resetAutoYesConfirmationLedgerForTests,
  runAutoYesLedgerHourForTests,
  setAutoYesLedgerClockTimersForTests,
  type LedgerScope,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const WT = 'wt-3820-cleanup';
const OTHER = 'wt-3820-cleanup-other';
const HOUR = 3_600_000;
const api = (worktreeId: string): LedgerScope => ({ worktreeId, cliToolId: 'opencode', instanceId: 'opencode' });

const lines = (event: string): Array<Record<string, unknown>> =>
  ledgerLog.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

/** An approval Auto-Yes did not answer (it is off): open, with no poller for its instance. */
function heldApproval(worktreeId: string, decisionId = 'per_1'): void {
  beginLedgerApiAdjudication(api(worktreeId), decisionId, { outcome: 'abstained', promptType: 'multiple_choice' });
}

/** An approval a policy withheld while Auto-Yes was on (a poller runs for the instance). */
function withheldApproval(worktreeId: string): void {
  setAutoYesEnabled(worktreeId, 'opencode', true, HOUR);
  expect(startAutoYesPolling(worktreeId, 'opencode').started).toBe(true);
  beginLedgerApiAdjudication(api(worktreeId), 'per_1', {
    outcome: 'abstained',
    withholdReason: 'deny-pattern',
    promptType: 'multiple_choice',
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  ledgerLog.info.mockClear();
  clearAllAutoYesStates();
  clearAllPollerStates();
  resetCacheForTesting();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  clearAllPollerStates();
  clearAllAutoYesStates();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  vi.useRealTimers();
});

describe('[#3820] a deleted worktree’s approvals with no poller (review item 3)', () => {
  it('cleanupWorktreeSessions abandons them, and only that worktree’s', async () => {
    heldApproval(WT);
    heldApproval(OTHER);

    await cleanupWorktreeSessions(WT, async () => false);

    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ worktreeId: WT, source: 'api', resolution: 'abandoned', abandonReason: 'worktree-deleted' }),
    ]);
  });

  it('leaves no checkpoint for the deleted worktree', async () => {
    heldApproval(WT);
    heldApproval(OTHER);
    await cleanupWorktreeSessions(WT, async () => false);
    runAutoYesLedgerHourForTests(Math.ceil(Date.now() / AUTO_YES_LEDGER_CLOCK_MS) * AUTO_YES_LEDGER_CLOCK_MS);

    expect(lines(EV.checkpoint)).toHaveLength(1);
  });

  it('the lifecycle table’s worktree-deleted row does it too', () => {
    heldApproval(WT);

    stopAutoYesPollersFor('worktree-deleted', { scope: 'worktree', worktreeId: WT });

    expect(lines(EV.closed)).toEqual([expect.objectContaining({ abandonReason: 'worktree-deleted' })]);
  });
});

describe('[#3820] the auto-yes route’s OFF under a withheld approval (review item 1)', () => {
  it('every agent of the worktree: ends the interval, keeps the approval open', () => {
    withheldApproval(WT);
    vi.setSystemTime(Date.now() + 10_000);

    stopAutoYesPollingByWorktree(WT, { keepPartialAnswers: true, reason: 'manual' });

    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'stopped', withheldMs: 10_000 })]);
    expect(lines(EV.closed)).toHaveLength(0);
  });

  it('one agent: the same', () => {
    withheldApproval(WT);
    vi.setSystemTime(Date.now() + 10_000);

    stopAutoYesPolling(buildCompositeKey(WT, 'opencode'), 'manual');

    expect(lines(EV.withholdEnded)).toEqual([expect.objectContaining({ end: 'stopped', withheldMs: 10_000 })]);
  });

  it('a screen confirmation still turns unobservable (negative control)', () => {
    setAutoYesEnabled(WT, 'claude', true, HOUR);
    expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
    const scope: LedgerScope = { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' };
    beginLedgerTick(scope);
    observeLedgerScreen(scope, 'screen-A', 'yes_no');

    stopAutoYesPollingByWorktree(WT, { keepPartialAnswers: true, reason: 'manual' });

    expect(lines(EV.presenceChanged)).toEqual([expect.objectContaining({ to: 'unobservable', cause: 'manual' })]);
    expect(lines(EV.closed)).toHaveLength(0);
  });
});
