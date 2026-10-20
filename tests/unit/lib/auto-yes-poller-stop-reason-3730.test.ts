/**
 * Every path that stops an Auto-Yes poller says why on `poller:stopped`
 * (Issue #3730).
 *
 * One test per path, each driving the REAL entry point — the poller's own
 * tick, the lifecycle table, the stop pattern, the error threshold — and
 * reading the log line the real poller writes. Not a grep over call sites: a
 * path that forgot its reason, or passed the wrong one, fails here.
 *
 * Positive control: before #3730 only the stop-all path logged a reason
 * (`shutdown`); every other row below fails on the old implementation.
 * Negative controls: the paths that stop a poller while the grant lives on
 * (replacement, test reset) leave the grant enabled, and a stop with no poller
 * to stop logs nothing.
 *
 * Only `child_process.execFile` (tmux) and the session-ownership probe are
 * stood in for; timers are fake, so nothing reaches a pane.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged: Array<{ module: string; action: string; data?: Record<string, unknown> }> = [];
vi.mock('@/lib/logger', () => {
  const make = (module: string) => {
    const record = (action: string, data?: Record<string, unknown>) => {
      logged.push({ module, action, data });
    };
    const logger = { debug: record, info: record, warn: record, error: record, withContext: () => logger };
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
  // `all` answers the orphan sweep's `SELECT id FROM worktrees`: only OTHER exists.
  getDbInstance: () => ({
    prepare: () => ({ get: () => undefined, run: () => undefined, all: () => [{ id: 'wt-3730-other' }] }),
  }),
}));

import { execFile } from 'child_process';
import {
  buildCompositeKey,
  clearAllAutoYesStates,
  disableAutoYes,
  getAutoYesState,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import {
  clearAllPollerStates,
  isPollerActive,
  processStopConditionDelta,
  startAutoYesPolling,
  stopAutoYesPolling,
  validatePollingContext,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { releaseAutoYes, stopAutoYesPollersFor } from '@/lib/auto-yes-lifecycle';
import { resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import { cleanupWorktreeSessions } from '@/lib/session-cleanup';
import { cleanupOrphanedMapEntries } from '@/lib/resource-cleanup';
import type { AutoYesPollerStopReason } from '@/config/auto-yes-config';

const WT = 'wt-3730-stop';
const OTHER = 'wt-3730-other';
const KEY = buildCompositeKey(WT, 'claude');
const ALIAS_KEY = buildCompositeKey(WT, 'claude', 'claude-2');
const HOUR = 3_600_000 as const;

/** The reasons `poller:stopped` was logged with for `key`, in order. */
function stoppedReasons(key: string): Array<AutoYesPollerStopReason | undefined> {
  return logged
    .filter((e) => e.module === 'auto-yes-poller' && e.action === 'poller:stopped' && e.data?.compositeKey === key)
    .map((e) => e.data?.reason as AutoYesPollerStopReason | undefined);
}

function arm(worktreeId: string, instanceId?: string, stopPattern?: string): string {
  setAutoYesEnabled(worktreeId, 'claude', true, HOUR, stopPattern, instanceId);
  expect(startAutoYesPolling(worktreeId, 'claude', instanceId).started).toBe(true);
  return buildCompositeKey(worktreeId, 'claude', instanceId);
}

/** The live poller state under `key` (the map the poller keeps on globalThis). */
function pollerStateOf(key: string): AutoYesPollerState {
  const state = globalThis.__autoYesPollerStates?.get(key);
  expect(state).toBeDefined();
  return state!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  clearAllAutoYesStates();
  clearAllPollerStates();
  resetCacheForTesting();
  vi.mocked(execFile).mockReset();
  logged.length = 0;
});

afterEach(() => {
  clearAllPollerStates();
  clearAllAutoYesStates();
  vi.useRealTimers();
});

describe('poller:stopped carries the reason of the path that stopped it (Issue #3730)', () => {
  it('expired: a tick finds the grant past its deadline', () => {
    arm(WT);
    vi.setSystemTime(Date.now() + HOUR);
    expect(validatePollingContext(KEY, pollerStateOf(KEY))).toBe('expired');
    expect(stoppedReasons(KEY)).toEqual(['expired']);
  });

  it('not-enabled: a tick finds the grant disabled for another reason (the same return value as expiry)', () => {
    arm(WT);
    const pollerState = pollerStateOf(KEY);
    // An invalid stop pattern disables without stopping the poller.
    disableAutoYes(WT, 'claude');
    expect(validatePollingContext(KEY, pollerState)).toBe('expired');
    expect(stoppedReasons(KEY)).toEqual(['not-enabled']);
  });

  it('invalid-key: a tick whose key names no CLI tool', () => {
    const bogus = `${WT}:not-a-tool`;
    const pollerState = { ...pollerStateOf(arm(WT)) };
    globalThis.__autoYesPollerStates!.set(bogus, pollerState);
    validatePollingContext(bogus, pollerState);
    expect(stoppedReasons(bogus)).toEqual(['invalid-key']);
  });

  it('stop-pattern: the stop pattern matches new output', () => {
    arm(WT, undefined, 'FATAL');
    const pollerState = pollerStateOf(KEY);
    processStopConditionDelta(KEY, pollerState, 'baseline');
    expect(processStopConditionDelta(KEY, pollerState, 'baseline\nFATAL: boom')).toBe(true);
    expect(stoppedReasons(KEY)).toEqual(['stop-pattern']);
    expect(getAutoYesState(WT, 'claude')?.stopReason).toBe('stop_pattern_matched');
  });

  it('consecutive-errors: the poller’s own threshold (tmux cannot be run)', async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      (args[args.length - 1] as (err: Error) => void)(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }));
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);
    arm(WT);

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(isPollerActive(KEY)).toBe(false);
    expect(stoppedReasons(KEY)).toEqual(['consecutive-errors']);
  });

  it('replaced: a poller of another CLI tool under the key (grant kept)', () => {
    arm(WT);
    pollerStateOf(KEY).cliToolId = 'codex';
    expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
    expect(stoppedReasons(KEY)).toEqual(['replaced']);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
  });

  it.each([
    ['session-killed', () => releaseAutoYes('session-killed', { scope: 'instance', worktreeId: WT, cliToolId: 'claude', instanceId: 'claude-2' })],
    ['instance-removed', () => releaseAutoYes('instance-removed', { scope: 'instance', worktreeId: WT, cliToolId: 'claude', instanceId: 'claude-2' })],
    ['worktree-deleted', () => releaseAutoYes('worktree-deleted', { scope: 'worktree', worktreeId: WT })],
    ['orphan-swept', () => stopAutoYesPollersFor('orphan-swept', { scope: 'key', compositeKey: ALIAS_KEY })],
    ['consecutive-errors', () => releaseAutoYes('consecutive-errors', { scope: 'key', compositeKey: ALIAS_KEY })],
    ['shutdown', () => releaseAutoYes('server-shutdown', { scope: 'all' })],
  ] as const)('%s: through the lifecycle table', (reason, run) => {
    arm(WT, 'claude-2');
    const other = arm(OTHER);
    run();
    expect(stoppedReasons(ALIAS_KEY)).toEqual([reason]);
    // Only the shutdown reaches the other worktree's poller.
    expect(stoppedReasons(other)).toEqual(reason === 'shutdown' ? ['shutdown'] : []);
  });

  it('worktree-deleted: through session-cleanup (the worktree delete / sync path)', async () => {
    arm(WT, 'claude-2');
    const other = arm(OTHER);
    await cleanupWorktreeSessions(WT, vi.fn(async () => false));
    expect(stoppedReasons(ALIAS_KEY)).toEqual(['worktree-deleted']);
    expect(stoppedReasons(other)).toEqual([]);
  });

  it('orphan-swept: through the periodic resource cleanup', () => {
    arm(WT, 'claude-2'); // WT is not in the database: an orphan
    const other = arm(OTHER);
    cleanupOrphanedMapEntries();
    expect(stoppedReasons(ALIAS_KEY)).toEqual(['orphan-swept']);
    expect(stoppedReasons(other)).toEqual([]);
  });

  it('reset: the test seam is not logged as a shutdown', () => {
    arm(WT);
    clearAllPollerStates();
    expect(stoppedReasons(KEY)).toEqual(['reset']);
  });

  it('the lifecycle scope ends with its call: a later bare stop is `unspecified`', () => {
    arm(WT, 'claude-2');
    arm(WT);
    releaseAutoYes('session-killed', { scope: 'instance', worktreeId: WT, cliToolId: 'claude', instanceId: 'claude-2' });
    stopAutoYesPolling(KEY);
    expect(stoppedReasons(KEY)).toEqual(['unspecified']);
  });

  it('negative control: stopping a key with no poller logs nothing', () => {
    stopAutoYesPolling(KEY, 'manual');
    expect(stoppedReasons(KEY)).toEqual([]);
  });

  it('negative control: no poller reason disables the grant by itself', () => {
    arm(WT);
    stopAutoYesPolling(KEY, 'worktree-id-migrated');
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
  });
});
