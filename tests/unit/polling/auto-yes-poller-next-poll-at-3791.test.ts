/**
 * Issue #3791: the Auto-Yes poller records when its pending tick is due
 * (`nextPollAt`), which the push gate reads to hold a wait until that tick.
 *
 * Driven through the real poller with fake timers; the session capture is
 * stood in for (a missing session puts the next tick a backoff away), so
 * nothing reaches a pane.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => {
    throw new Error('no session');
  }),
  captureSessionOutputFresh: vi.fn(async () => ''),
  getSessionPresence: vi.fn(async () => 'absent'),
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

function nextPollAt(): number | undefined {
  return globalThis.__autoYesPollerStates?.get(KEY)?.nextPollAt;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  clearAllAutoYesStates();
  clearAllPollerStates();
});

afterEach(() => {
  clearAllPollerStates();
  clearAllAutoYesStates();
  vi.useRealTimers();
});

describe('[#3791] the poller records when its next tick is due', () => {
  it('a started poller: the first tick, a poll interval away', () => {
    setAutoYesEnabled(WT, 'claude', true);
    expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
    expect(nextPollAt()).toBe(T0 + POLLING_INTERVAL_MS);
  });

  it('a tick that puts the next one a backoff away records that later time', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    startAutoYesPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(nextPollAt()).toBe(T0 + POLLING_INTERVAL_MS + MAX_BACKOFF_MS);
  });
});
