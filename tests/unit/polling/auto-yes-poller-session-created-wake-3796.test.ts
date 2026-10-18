/**
 * Issue #3796 item 3: a poller waiting `MAX_BACKOFF_MS` for its session ticks a
 * poll interval after the session is created (`notifyTmuxSessionCreated`, which
 * `createSession` calls), instead of up to a minute later. The wake replaces the
 * pending timer only: no second chain, and nothing for a poller stopped or
 * replaced meanwhile.
 *
 * Driven through the real poller with fake timers, as in
 * auto-yes-poller-session-wait-tick-3791.test.ts; the capture is stood in for
 * (it fails while the session is absent), so nothing reaches a pane.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let presence: 'absent' | 'present' = 'absent';
const captureSessionOutput = vi.fn(async () => {
  if (presence === 'absent') throw new Error('capture failed');
  return '$ ';
});
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: () => captureSessionOutput(),
  captureSessionOutputFresh: vi.fn(async () => ''),
  getSessionPresence: vi.fn(async () => presence),
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
  clearPromptHashCache: vi.fn(),
}));
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => ({
    prepare: () => ({ get: () => undefined, run: () => undefined, all: () => [] }),
  }),
}));

import {
  buildCompositeKey,
  clearAllAutoYesStates,
  MAX_BACKOFF_MS,
  POLLING_INTERVAL_MS,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import { clearAllPollerStates, startAutoYesPolling, stopAutoYesPolling } from '@/lib/auto-yes-poller';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import {
  clearTmuxSessionCreatedListeners,
  countTmuxSessionCreatedListeners,
  notifyTmuxSessionCreated,
} from '@/lib/tmux/session-created-signal';

const WT = 'wt-3796-wake';
const KEY = buildCompositeKey(WT, 'claude');
const T0 = 1_800_000_000_000;
const SESSION = CLIToolManager.getInstance().getTool('claude').getSessionName(WT, 'claude');

function poller() {
  return globalThis.__autoYesPollerStates?.get(KEY);
}

/** Start the poller and let its first tick find no session: it now waits a backoff. */
async function startWaitingForSession(): Promise<void> {
  setAutoYesEnabled(WT, 'claude', true);
  expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
  expect(poller()?.waitingForSession).toBe(true);
  expect(poller()?.sessionWaitTickAt).toBe(T0 + POLLING_INTERVAL_MS + MAX_BACKOFF_MS);
  expect(captureSessionOutput).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  presence = 'absent';
  captureSessionOutput.mockClear();
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearTmuxSessionCreatedListeners();
});

afterEach(() => {
  clearAllPollerStates();
  clearAllAutoYesStates();
  clearTmuxSessionCreatedListeners();
  vi.useRealTimers();
});

describe('[#3796] 3: the session\'s creation wakes a poller waiting for it', () => {
  it('positive: the next tick comes a poll interval after the creation, not a backoff later', async () => {
    await startWaitingForSession();

    await vi.advanceTimersByTimeAsync(1_000);
    presence = 'present';
    notifyTmuxSessionCreated(SESSION);
    // Still the session wait's tick, brought forward: the push gate reads it.
    expect(poller()?.sessionWaitTickAt).toBe(Date.now() + POLLING_INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(captureSessionOutput).toHaveBeenCalledTimes(2);
    expect(poller()?.waitingForSession).toBe(false);
    expect(poller()?.sessionAppearedAt).toBe(T0 + POLLING_INTERVAL_MS + 1_000 + POLLING_INTERVAL_MS);
    expect(poller()?.sessionWaitTickAt).toBeUndefined();
  });

  it('one chain only: after the wake the poller ticks once per interval', async () => {
    await startWaitingForSession();
    presence = 'present';
    notifyTmuxSessionCreated(SESSION);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * POLLING_INTERVAL_MS);
    // 1 (no session) + 10 (one per interval) — a second chain would double it.
    expect(captureSessionOutput).toHaveBeenCalledTimes(11);
    expect(vi.getTimerCount()).toBe(1);
    // A second creation of the same name finds nobody waiting.
    expect(countTmuxSessionCreatedListeners()).toBe(0);
    notifyTmuxSessionCreated(SESSION);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('negative: another session\'s creation does not wake it', async () => {
    await startWaitingForSession();
    notifyTmuxSessionCreated(`${SESSION}-other`);
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS - 1);
    expect(captureSessionOutput).toHaveBeenCalledTimes(1);
  });

  it('negative: a poller stopped meanwhile is not started again by the creation', async () => {
    await startWaitingForSession();
    stopAutoYesPolling(KEY);
    expect(countTmuxSessionCreatedListeners()).toBe(0);

    presence = 'present';
    notifyTmuxSessionCreated(SESSION);
    expect(poller()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * MAX_BACKOFF_MS);
    expect(captureSessionOutput).toHaveBeenCalledTimes(1);
  });

  it('negative: a poller replaced (off → on) keeps its own timer; the old wake is gone', async () => {
    await startWaitingForSession();
    stopAutoYesPolling(KEY);
    expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
    const fresh = poller();
    expect(vi.getTimerCount()).toBe(1);

    notifyTmuxSessionCreated(SESSION);
    expect(poller()).toBe(fresh);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('control: without a creation the session wait ticks after the backoff, as in #3791, and stops listening', async () => {
    await startWaitingForSession();
    expect(countTmuxSessionCreatedListeners()).toBe(1);
    presence = 'present';
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS - 1);
    expect(captureSessionOutput).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(captureSessionOutput).toHaveBeenCalledTimes(2);
    expect(countTmuxSessionCreatedListeners()).toBe(0);
  });
});
