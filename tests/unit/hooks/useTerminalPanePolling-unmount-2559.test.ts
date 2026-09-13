/**
 * useTerminalPanePolling — no state update from a fetch that settles after unmount (Issue #2559)
 *
 * Same hole as `useSplitMessages` (see `useSplitMessages-unmount-2559.test.ts`
 * for the full story): the poll effect's cleanup stopped the interval, not a
 * fetch already out, and `fetchCurrentOutput`'s stale check never looked at
 * mount state. A late success reached `setTerminal` / `setPrompt` /
 * `setAgentSession`; a late failure logged to `console.error` for a pane that no
 * longer existed.
 *
 * The fetch is held open by hand, the pane is unmounted, `window` is removed
 * (the state jsdom teardown leaves, where any React update throws) and only then
 * is the fetch settled — so nothing here depends on timing or load.
 *
 * Unlike `useSplitMessages`, this catch block sets no state, so a late setState
 * does not reject `refresh()` — it is caught and logged. `console.error` is
 * therefore the observable: with `!mountedRef.current` removed from `isStale`
 * (and at the pre-#2559 HEAD), all three cases below fail on it — the two
 * success paths logging `TypeError: Cannot read properties of undefined
 * (reading 'event')` from the throwing setState, the failure path logging the
 * fetch error itself.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';

const realtimeMock = vi.hoisted(() => {
  const api = {
    status: 'disconnected' as const,
    connected: false,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  };
  return { useRealtime: () => api };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: realtimeMock.useRealtime,
}));

type MockFetchResponse = { ok: boolean; json: () => Promise<unknown> };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const LATE_OUTPUT = {
  isRunning: true,
  fullOutput: 'late output',
  thinking: false,
  isPromptWaiting: true,
  promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' },
  structuredEvents: { session: null, sessionContext: null, sessionDiff: null },
};

describe('useTerminalPanePolling unmount guard (Issue #2559)', () => {
  let mockFetch: ReturnType<typeof vi.fn<() => Promise<MockFetchResponse>>>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        // `isRunning: false` keeps the poll effect's dependencies where they
        // started, so this response does not re-create the interval and kick a
        // second poll while the test is setting up its controlled fetch.
        json: async () => ({ isRunning: false, fullOutput: 'first output', thinking: false }),
      }),
    );
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Mount a real (polling) pane, let its first poll land so the pane is settled,
   * then start a `refresh()` whose fetch the test controls.
   */
  async function mountAndStartRefresh(pendingFetch: Promise<MockFetchResponse>) {
    const hook = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(hook.result.current.terminal.output).toBe('first output'));

    const callsBefore = mockFetch.mock.calls.length;
    mockFetch.mockImplementation(() => pendingFetch);
    const refreshed = hook.result.current.refresh();
    expect(mockFetch).toHaveBeenCalledTimes(callsBefore + 1);
    return { unmount: hook.unmount, refreshed };
  }

  /** The state jsdom teardown leaves behind: any React update now throws. */
  function removeWindow(): void {
    vi.stubGlobal('window', undefined);
  }

  it('does not update state when a successful response settles after unmount', async () => {
    const pending = deferred<MockFetchResponse>();
    const { unmount, refreshed } = await mountAndStartRefresh(pending.promise);

    unmount();
    removeWindow();
    pending.resolve({ ok: true, json: async () => LATE_OUTPUT });

    await expect(refreshed).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not log when the fetch rejects after unmount', async () => {
    const pending = deferred<MockFetchResponse>();
    const { unmount, refreshed } = await mountAndStartRefresh(pending.promise);

    unmount();
    removeWindow();
    pending.reject(new TypeError('Failed to fetch'));

    await expect(refreshed).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not update state when unmount lands between the response and its body', async () => {
    const body = deferred<unknown>();
    const { unmount, refreshed } = await mountAndStartRefresh(
      Promise.resolve({ ok: true, json: () => body.promise }),
    );

    unmount();
    removeWindow();
    body.resolve(LATE_OUTPUT);

    await expect(refreshed).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
