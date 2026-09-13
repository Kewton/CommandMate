/**
 * useSplitMessages — no state update from a fetch that settles after unmount (Issue #2559)
 *
 * The poll effect's cleanup stopped the interval but not a fetch already in
 * flight, and `fetchMessages` only dropped responses that were superseded or
 * landed under another CLI / instance. A response that settled after unmount
 * therefore still called `setMessages` / `setIsLoading`. React 19 reads
 * `window.event` to pick the update's priority *before* it notices the fiber is
 * gone, so once vitest had torn jsdom down that call threw, and CI's Unit Tests
 * job exited 1 on an Unhandled Error with every test green.
 *
 * ## How this is made deterministic
 *
 * Load decided *when* the stray response landed; nothing here depends on it.
 * Each case holds the fetch open on a promise the test settles by hand, unmounts,
 * then removes `window` — the teardown state CI hit — before settling. Any
 * setState on that path throws inside `fetchMessages`, and because `refresh()`
 * returns the very same promise, the throw surfaces as a rejection the test can
 * await instead of an unhandled error nobody attributes.
 *
 * Mutation check: with `!mountedRef.current` removed from `isStale` (and at the
 * pre-#2559 HEAD), all three cases below fail (`refresh()` rejects with
 * `TypeError: Cannot read properties of undefined (reading 'event')`).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSplitMessages } from '@/hooks/useSplitMessages';

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

function makeMessage(content: string) {
  return {
    id: `msg-${content}`,
    worktreeId: 'w-1',
    role: 'user',
    content,
    timestamp: '2024-01-01T00:00:00.000Z',
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    instanceId: 'claude',
  };
}

describe('useSplitMessages unmount guard (Issue #2559)', () => {
  let mockFetch: ReturnType<typeof vi.fn<() => Promise<MockFetchResponse>>>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => [makeMessage('first')] }),
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
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    expect(hook.result.current.messages).toHaveLength(1);

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
    pending.resolve({ ok: true, json: async () => [makeMessage('late')] });

    await expect(refreshed).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not update state when the fetch rejects after unmount', async () => {
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
    body.resolve([makeMessage('late')]);

    await expect(refreshed).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
