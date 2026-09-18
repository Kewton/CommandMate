/**
 * useWorktreesCache — failed first load: retry ladder, response guards and the
 * console line (Issue #2059).
 *
 * Before this, a failed first fetch left the cache empty and silent: nothing
 * reached the console, and the only recovery was the ordinary poll 30s away
 * (60s with a live push connection). Meanwhile an unauthenticated request
 * resolved as the /login HTML page with status 200 and was parsed as JSON.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useWorktreesCache,
  INITIAL_LOAD_RETRY_DELAYS_MS,
} from '@/hooks/useWorktreesCache';

// Keep the hook off a real WebSocket. Mirrors tests/unit/useWorktreesCache.test.ts.
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: 'disconnected' as const,
    connected: false,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  }),
}));

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: 'http://localhost/api/worktrees',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

/** What a fetch that followed the auth middleware's 307 actually resolves to. */
function loginRedirectResponse(): Response {
  return {
    ok: true,
    status: 200,
    redirected: true,
    url: 'http://localhost/login?from=%2F',
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  } as unknown as Response;
}

describe('useWorktreesCache — failed first load (Issue #2059)', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    // The hook now reports failures on the console by design; keep the expected
    // path out of the test output while still asserting on it.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('exposes a bounded, increasing retry ladder', () => {
    expect([...INITIAL_LOAD_RETRY_DELAYS_MS]).toEqual([2000, 5000, 10000]);
  });

  it('logs one line to the console when the fetch fails', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    const { result } = renderHook(() => useWorktreesCache());

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[useWorktreesCache] Failed to fetch worktrees:',
      expect.any(Error),
    );
  });

  it('retries an empty cache on the ladder and stops once a retry succeeds', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    renderHook(() => useWorktreesCache());

    // Initial fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Nothing before the first rung.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INITIAL_LOAD_RETRY_DELAYS_MS[0] - 100);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // First rung (2s) fires and also fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second rung is 5s after the first one, not another 2s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INITIAL_LOAD_RETRY_DELAYS_MS[1] - 400);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockResolvedValue(jsonResponse({ worktrees: [{ id: 'wt-1' }], repositories: [] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // The success ends the ladder: the third rung (10s) must not fire.
    const callsAfterSuccess = mockFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INITIAL_LOAD_RETRY_DELAYS_MS[2] + 500);
    });
    expect(mockFetch).toHaveBeenCalledTimes(callsAfterSuccess);
  });

  it('gives up after the last rung instead of retrying forever', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    renderHook(() => useWorktreesCache());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    for (const delay of INITIAL_LOAD_RETRY_DELAYS_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay + 100);
      });
    }
    // 1 initial + 3 rungs. The ordinary poll (30s) takes over from here.
    expect(mockFetch).toHaveBeenCalledTimes(1 + INITIAL_LOAD_RETRY_DELAYS_MS.length);
  });

  it('does not run the ladder once the cache holds a list', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ worktrees: [{ id: 'wt-1' }], repositories: [] }),
    );

    renderHook(() => useWorktreesCache());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const callsAfterLoad = mockFetch.mock.calls.length;

    // A failing poll on a populated cache is a stale list, not a blank screen.
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000 + 100);
    });
    const callsAfterFailedPoll = mockFetch.mock.calls.length;
    expect(callsAfterFailedPoll).toBe(callsAfterLoad + 1);

    // No 2s rung follows it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INITIAL_LOAD_RETRY_DELAYS_MS[0] + 100);
    });
    expect(mockFetch).toHaveBeenCalledTimes(callsAfterFailedPoll);
  });

  it('treats a followed /login redirect as an error rather than parsing HTML', async () => {
    mockFetch.mockResolvedValue(loginRedirectResponse());

    const { result } = renderHook(() => useWorktreesCache());

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error?.message).toBe('Authentication required');
    expect(result.current.worktrees).toEqual([]);
  });

  it('treats a 200 that is not application/json as an error', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      url: 'http://localhost/api/worktrees',
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => ({ worktrees: [{ id: 'should-not-be-used' }] }),
    } as unknown as Response);

    const { result } = renderHook(() => useWorktreesCache());

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error?.message).toBe('Unexpected response format');
    expect(result.current.worktrees).toEqual([]);
  });

  it('leaves no retry armed after unmount', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    const { unmount } = renderHook(() => useWorktreesCache());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const callsBeforeUnmount = mockFetch.mock.calls.length;
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INITIAL_LOAD_RETRY_DELAYS_MS[0] * 10);
    });
    expect(mockFetch).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it('goes back to loading while an empty cache retries after a failure (Issue #2643)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.isLoading).toBe(false);

    let resolveRetry!: (value: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveRetry = resolve; }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refresh();
    });
    // 応答待ちの間: エラーは消え、読込中に戻っている（「読込完了・空・エラーなし」にならない）
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveRetry(jsonResponse({ worktrees: [{ id: 'wt-1' }], repositories: [] }));
      await pending;
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.worktrees).toHaveLength(1);
  });

  it('keeps isLoading false when an empty list that loaded fine is fetched again (Issue #2643)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ worktrees: [], repositories: [] }));
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let resolveAgain!: (value: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveAgain = resolve; }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refresh();
    });
    expect(result.current.isLoading).toBe(false);
    await act(async () => {
      resolveAgain(jsonResponse({ worktrees: [], repositories: [] }));
      await pending;
    });
    expect(result.current.isLoading).toBe(false);
  });
});
