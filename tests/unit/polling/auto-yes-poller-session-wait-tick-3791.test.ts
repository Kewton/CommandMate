/**
 * Issue #3791: the Auto-Yes poller records when its session-wait tick is due
 * (`sessionWaitTickAt`), which the push gate reads to hold a wait until that
 * tick — and records nothing for any other tick, an error backoff included.
 *
 * Driven through the real poller with fake timers; the session capture is
 * stood in for (it always fails; `has-session` answers per test), so nothing
 * reaches a pane.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let presence: 'absent' | 'present' = 'absent';
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => {
    throw new Error('capture failed');
  }),
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
import { clearAllPollerStates, startAutoYesPolling } from '@/lib/auto-yes-poller';

const WT = 'wt-3791-poller';
const KEY = buildCompositeKey(WT, 'claude');
const T0 = 1_800_000_000_000;

function poller() {
  return globalThis.__autoYesPollerStates?.get(KEY);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  presence = 'absent';
  clearAllAutoYesStates();
  clearAllPollerStates();
});

afterEach(() => {
  clearAllPollerStates();
  clearAllAutoYesStates();
  vi.useRealTimers();
});

describe('[#3791] the poller records its session-wait tick, and only that', () => {
  it('a started poller: none (its first tick is a poll interval away)', () => {
    setAutoYesEnabled(WT, 'claude', true);
    expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
    expect(poller()?.sessionWaitTickAt).toBeUndefined();
  });

  it('positive: no session — the next tick, a backoff away, is recorded', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    startAutoYesPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(poller()?.sessionWaitTickAt).toBe(T0 + POLLING_INTERVAL_MS + MAX_BACKOFF_MS);
  });

  it('negative: an error backoff is not recorded, and clears a session wait recorded before', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    startAutoYesPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(poller()?.sessionWaitTickAt).toBeDefined();

    // The session is there now, but the capture keeps failing: errors in a row.
    presence = 'present';
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(poller()?.consecutiveErrors).toBe(1);
    expect(poller()?.sessionWaitTickAt).toBeUndefined();

    for (let i = 0; i < 4 && poller() !== undefined; i++) {
      await vi.advanceTimersByTimeAsync(poller()!.currentInterval);
      expect(poller()?.sessionWaitTickAt).toBeUndefined();
    }
  });
});
