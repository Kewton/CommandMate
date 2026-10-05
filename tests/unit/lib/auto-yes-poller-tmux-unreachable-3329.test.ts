/**
 * Issue #3329: "tmux could not be asked" is not "the session does not exist".
 *
 * The poller waits for an absent session until `expiresAt`. It decides
 * "absent" from `tmux has-session`'s exit code (`probeSession`), not from
 * `hasSession`, which folds a timeout or a spawn failure into `false` too.
 * Here the real poller, cli-session, capture cache and tmux module run, and
 * only `child_process.execFile` — the tmux call itself — is made to fail, so a
 * tmux that times out or cannot be run must still stop Auto-Yes at the
 * threshold, while a genuinely absent session (exit 1) keeps it on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
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
  getDbInstance: () => ({ prepare: () => ({ get: () => undefined, run: () => undefined }) }),
}));

import { execFile } from 'child_process';
import {
  getAutoYesState,
  setAutoYesEnabled,
  clearAllAutoYesStates,
  startAutoYesPolling,
  stopAllAutoYesPolling,
  clearAllPollerStates,
  isPollerActive,
} from '@/lib/polling/auto-yes-manager';
import { resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import { probeSession } from '@/lib/tmux/tmux';
import { AUTO_STOP_ERROR_THRESHOLD } from '@/config/auto-yes-config';

const WT = 'wt-3329-tmux';
const KEY = `${WT}:claude`;
const EIGHT_HOURS = 28_800_000 as const;

type ExecError = Error & { code?: unknown; killed?: boolean; signal?: string | null };

function timeoutError(): ExecError {
  return Object.assign(new Error('Command failed: tmux has-session'), { code: null, killed: true, signal: 'SIGTERM' });
}
function spawnError(): ExecError {
  return Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
}
function absentError(): ExecError {
  return Object.assign(new Error("can't find session: claude-x"), { code: 1, killed: false });
}

/** Every tmux call fails with what `make` returns. */
function tmuxFailsWith(make: () => ExecError): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error | null, out?: unknown) => void;
    callback(make());
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

function hasSessionCalls(): number {
  return vi.mocked(execFile).mock.calls.filter((c) => (c[1] as string[])[0] === 'has-session').length;
}

describe('Issue #3329: probeSession', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
  });

  it('answers present when has-session succeeds', async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      (args[args.length - 1] as (err: null, out: unknown) => void)(null, { stdout: '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);
    await expect(probeSession('s')).resolves.toBe('present');
  });

  it('answers absent when has-session exits 1', async () => {
    tmuxFailsWith(absentError);
    await expect(probeSession('s')).resolves.toBe('absent');
  });

  it('answers unknown when has-session times out', async () => {
    tmuxFailsWith(timeoutError);
    await expect(probeSession('s')).resolves.toBe('unknown');
  });

  it('answers unknown when tmux cannot be run', async () => {
    tmuxFailsWith(spawnError);
    await expect(probeSession('s')).resolves.toBe('unknown');
  });
});

describe('Issue #3329: Auto-Yes over a tmux that cannot be asked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    clearAllAutoYesStates();
    clearAllPollerStates();
    resetCacheForTesting();
    vi.mocked(execFile).mockReset();
  });

  afterEach(() => {
    stopAllAutoYesPolling();
    vi.useRealTimers();
  });

  it.each([
    ['times out', timeoutError],
    ['cannot be run', spawnError],
  ])('stops with consecutive_errors when tmux %s', async (_label, make) => {
    tmuxFailsWith(make);
    setAutoYesEnabled(WT, 'claude', true, EIGHT_HOURS);
    startAutoYesPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    const state = getAutoYesState(WT, 'claude');
    expect(state?.enabled).toBe(false);
    expect(state?.stopReason).toBe('consecutive_errors');
    expect(isPollerActive(KEY)).toBe(false);
    // Two has-session calls per poll (the capture's, then the probe's).
    expect(hasSessionCalls()).toBe(2 * AUTO_STOP_ERROR_THRESHOLD);
  });

  it('keeps waiting when tmux says the session does not exist (exit 1)', async () => {
    tmuxFailsWith(absentError);
    setAutoYesEnabled(WT, 'claude', true, EIGHT_HOURS);
    startAutoYesPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(hasSessionCalls()).toBeGreaterThan(2 * AUTO_STOP_ERROR_THRESHOLD);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
    expect(isPollerActive(KEY)).toBe(true);
  });
});
