/**
 * Issue #3329: Auto-Yes enabled for an instance whose session is not running
 * must wait for the session until `expiresAt`, not give up after 20 polls.
 *
 * The UAT case (#3300): `auto-yes --enable --instance codex` with no codex
 * session. Every poll threw "session ... does not exist", the poller counted it
 * as a capture error, and the 20th (about 12 minutes in) disabled Auto-Yes with
 * `consecutive_errors` and told no one. Auto-Yes lives independently of the
 * session it answers for (`auto-yes-lifecycle.ts`), and `send --auto-yes`
 * enables it before the session starts, so "no session" is a wait, not an error.
 *
 * What must not move: a session that exists but cannot be read still counts,
 * and the poller still stops at the threshold.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  getSessionPresence: vi.fn(),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux', () => ({ sendKeys: vi.fn(), sendSpecialKeys: vi.fn() }));
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

import { captureSessionOutput, getSessionPresence } from '@/lib/session/cli-session';
import { sendSpecialKeys } from '@/lib/tmux/tmux';
import {
  getAutoYesState,
  setAutoYesEnabled,
  clearAllAutoYesStates,
  startAutoYesPolling,
  stopAllAutoYesPolling,
  clearAllPollerStates,
  isPollerActive,
  POLLING_INTERVAL_MS,
  MAX_BACKOFF_MS,
} from '@/lib/polling/auto-yes-manager';
import { AUTO_STOP_ERROR_THRESHOLD } from '@/config/auto-yes-config';

const WT = 'wt-3329';
const KEY = `${WT}:claude`;
const EIGHT_HOURS = 28_800_000 as const;
const ONE_HOUR = 3_600_000 as const;

function sessionMissing(): void {
  vi.mocked(captureSessionOutput).mockRejectedValue(
    new Error(`Claude session claude-${WT} does not exist`),
  );
  vi.mocked(getSessionPresence).mockResolvedValue('absent');
}

describe('Issue #3329: Auto-Yes waits for a session that is not running', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    clearAllAutoYesStates();
    clearAllPollerStates();
    vi.mocked(captureSessionOutput).mockReset();
    vi.mocked(getSessionPresence).mockReset();
    vi.mocked(sendSpecialKeys).mockReset();
  });

  afterEach(() => {
    stopAllAutoYesPolling();
    vi.useRealTimers();
  });

  it('stays enabled past the error threshold while the session does not exist', async () => {
    sessionMissing();
    setAutoYesEnabled(WT, 'claude', true, EIGHT_HOURS);
    startAutoYesPolling(WT, 'claude');

    // Well past the 20 polls (about 12 minutes) that used to disable it.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(vi.mocked(captureSessionOutput).mock.calls.length).toBeGreaterThan(AUTO_STOP_ERROR_THRESHOLD);
    const state = getAutoYesState(WT, 'claude');
    expect(state?.enabled).toBe(true);
    expect(state?.stopReason).toBeUndefined();
    expect(isPollerActive(KEY)).toBe(true);
  });

  it('polls a missing session at the backoff cap, not every 2 seconds', async () => {
    sessionMissing();
    setAutoYesEnabled(WT, 'claude', true, EIGHT_HOURS);
    startAutoYesPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS); // first poll
    expect(captureSessionOutput).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS - 1);
    expect(captureSessionOutput).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(captureSessionOutput).toHaveBeenCalledTimes(2);
  });

  it('answers once the session appears, and returns to the normal interval', async () => {
    sessionMissing();
    setAutoYesEnabled(WT, 'claude', true, EIGHT_HOURS);
    startAutoYesPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(sendSpecialKeys).not.toHaveBeenCalled();

    // The session starts: a quiet frame first, then a prompt.
    vi.mocked(getSessionPresence).mockResolvedValue('present');
    vi.mocked(captureSessionOutput).mockResolvedValue('idle');
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    const callsAfterAppear = vi.mocked(captureSessionOutput).mock.calls.length;

    // Back to the normal 2s interval.
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(vi.mocked(captureSessionOutput).mock.calls.length).toBe(callsAfterAppear + 1);

    vi.mocked(captureSessionOutput).mockResolvedValue('Select an option:\n❯ 1. Yes\n  2. No');
    vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);

    expect(sendSpecialKeys).toHaveBeenCalled();
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);
  });

  it('still stops with consecutive_errors when the session exists but capture keeps failing', async () => {
    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('Failed to capture Claude output: boom'));
    vi.mocked(getSessionPresence).mockResolvedValue('present');
    setAutoYesEnabled(WT, 'claude', true, EIGHT_HOURS);
    startAutoYesPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(captureSessionOutput).toHaveBeenCalledTimes(AUTO_STOP_ERROR_THRESHOLD);
    const state = getAutoYesState(WT, 'claude');
    expect(state?.enabled).toBe(false);
    expect(state?.stopReason).toBe('consecutive_errors');
    expect(isPollerActive(KEY)).toBe(false);
  });

  it('does not stop when failures alternate with successful captures (40 polls)', async () => {
    // A capture that succeeds in between means the errors were not consecutive.
    let n = 0;
    vi.mocked(captureSessionOutput).mockImplementation(async () => {
      n++;
      if (n % 2 === 1) throw new Error('Failed to capture Claude output: transient');
      return 'idle';
    });
    vi.mocked(getSessionPresence).mockResolvedValue('present');
    setAutoYesEnabled(WT, 'claude', true, EIGHT_HOURS);
    startAutoYesPolling(WT, 'claude');

    // Long enough for the old count (never reset by a good tick) to reach 20
    // through its backoff.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(n).toBeGreaterThanOrEqual(40);
    const state = getAutoYesState(WT, 'claude');
    expect(state?.enabled).toBe(true);
    expect(state?.stopReason).toBeUndefined();
    expect(isPollerActive(KEY)).toBe(true);
  });

  it('still stops when the capture works but sending the answer fails every time', async () => {
    // The good capture must not end the run of errors: the poll did not finish.
    vi.mocked(captureSessionOutput).mockResolvedValue('Select an option:\n\u276F 1. Yes\n  2. No');
    vi.mocked(getSessionPresence).mockResolvedValue('present');
    vi.mocked(sendSpecialKeys).mockRejectedValue(new Error('send-keys failed'));
    setAutoYesEnabled(WT, 'claude', true, EIGHT_HOURS);
    startAutoYesPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(vi.mocked(sendSpecialKeys).mock.calls.length).toBeGreaterThanOrEqual(AUTO_STOP_ERROR_THRESHOLD);
    const state = getAutoYesState(WT, 'claude');
    expect(state?.enabled).toBe(false);
    expect(state?.stopReason).toBe('consecutive_errors');
    expect(isPollerActive(KEY)).toBe(false);
  });

  it('counts the failure when the session check itself fails', async () => {
    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('Claude session x does not exist'));
    vi.mocked(getSessionPresence).mockRejectedValue(new Error('tmux unavailable'));
    setAutoYesEnabled(WT, 'claude', true, EIGHT_HOURS);
    startAutoYesPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(getAutoYesState(WT, 'claude')?.stopReason).toBe('consecutive_errors');
  });

  it('stops at expiresAt while waiting for the session', async () => {
    sessionMissing();
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    startAutoYesPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(61 * 60 * 1000);

    expect(isPollerActive(KEY)).toBe(false);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(false);
  });
});
