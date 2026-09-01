/**
 * useSplitMessages — WebSocket history push (Issue #2195)
 *
 * The pane used to learn about a new history row only from its own 5s poll.
 * The server has broadcast every row it writes as `message` / `message_updated`
 * since #1120, so this suite pins the consumer side of that contract:
 *
 *  - a `message` for THIS split lands without a round trip;
 *  - a `message` for another instance of the same tool is ignored (the
 *    mutation-injection target named in the issue's acceptance criteria);
 *  - `message_updated` replaces the row with the same id rather than appending;
 *  - rows are ordered by `timestamp`, not by arrival;
 *  - the HTTP poll is demoted to 15s while a socket is up, and still runs at 5s
 *    when it is not (the fallback #2195 explicitly keeps);
 *  - a disconnect and a reconnect each pull one recovery re-fetch, which is how
 *    rows broadcast into a dead socket are recovered.
 *
 * ## Why the fetch mock is deliberately slow
 *
 * CI runs vitest with `fileParallelism: false`, and a suite that asserts right
 * after an `act()` can pass locally on a fetch that resolves in the same
 * microtask and fail there. Every fetch below resolves after a real 10ms timer
 * so the resolution genuinely lands in a later task, and every assertion that
 * depends on one is inside `waitFor`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useSplitMessages,
  SPLIT_MESSAGES_POLL_INTERVAL_MS,
  WS_CONNECTED_SPLIT_MESSAGES_POLL_INTERVAL_MS,
} from '@/hooks/useSplitMessages';

/**
 * Realtime mock with a *mutable* `connected`, because #2195 makes the poll
 * cadence and the recovery re-fetch depend on it. `useRealtime` returns a fresh
 * object per render so a flip is visible to the hook on the next render (the
 * provider does the same thing — its value is a `useMemo` keyed on `status`).
 */
const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const state = { connected: false };
  return {
    state,
    setConnected: (value: boolean) => {
      state.connected = value;
    },
    emit: (event: unknown) => {
      for (const listener of [...listeners]) listener(event);
    },
    reset: () => {
      listeners.length = 0;
      state.connected = false;
    },
    useRealtime: () => ({
      status: state.connected ? ('connected' as const) : ('disconnected' as const),
      connected: state.connected,
      subscribe: () => {},
      unsubscribe: () => {},
      addListener: (l: (e: unknown) => void) => {
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    }),
  };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: realtimeMock.useRealtime,
}));

/** Deliberate latency so a resolution can never land in the calling microtask. */
const FETCH_DELAY_MS = 10;

type MockFetchResponse = { ok: boolean; json: () => Promise<unknown> };

function slowJson(data: unknown): Promise<MockFetchResponse> {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ ok: true, json: async () => data }), FETCH_DELAY_MS);
  });
}

interface MessageOverrides {
  id?: string;
  role?: 'user' | 'assistant';
  content?: string;
  timestamp?: string;
  cliToolId?: string;
  instanceId?: string;
  archived?: boolean;
  messageType?: string;
}

function makeMessage(overrides: MessageOverrides = {}) {
  return {
    id: overrides.id ?? `msg-${Math.random()}`,
    worktreeId: 'w-1',
    role: overrides.role ?? 'assistant',
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? '2024-01-01T00:00:00.000Z',
    messageType: overrides.messageType ?? 'normal',
    archived: overrides.archived ?? false,
    cliToolId: overrides.cliToolId ?? 'claude',
    instanceId: overrides.instanceId ?? 'claude',
    ...('instanceId' in overrides && overrides.instanceId === undefined
      ? { instanceId: undefined }
      : {}),
  };
}

/** A `message` / `message_updated` frame exactly as `broadcastMessage` shapes it. */
function messageEvent(type: 'message' | 'message_updated', message: unknown, worktreeId = 'w-1') {
  return { type, worktreeId, message };
}

describe('useSplitMessages realtime history push (Issue #2195)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    realtimeMock.reset();
    mockFetch = vi.fn(() => slowJson([]));
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('appends a `message` addressed to this split without re-fetching', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude', instanceId: 'claude-2' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const fetchesBefore = mockFetch.mock.calls.length;

    act(() => {
      realtimeMock.emit(
        messageEvent(
          'message',
          makeMessage({ id: 'm-1', content: 'pushed reply', instanceId: 'claude-2' }),
        ),
      );
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual(['pushed reply']);
      // The point of the issue: the row arrives on the socket, not on a poll.
      expect(mockFetch.mock.calls.length).toBe(fetchesBefore);
    });
  });

  it('parses the pushed ISO timestamp into a Date, like the fetch path does', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      realtimeMock.emit(
        messageEvent('message', makeMessage({ id: 'm-1', timestamp: '2024-05-01T12:00:00.000Z' })),
      );
    });

    await waitFor(() => {
      expect(result.current.messages[0]?.timestamp).toBeInstanceOf(Date);
      expect(result.current.messages[0]?.timestamp.toISOString()).toBe('2024-05-01T12:00:00.000Z');
    });
  });

  /**
   * MUTATION TARGET (acceptance criterion "変異注入"): deleting the
   * `eventInstanceId !== inFlightInstanceRef.current` guard in
   * `useSplitMessages` must turn this test red.
   *
   * Both messages carry `cliToolId: 'claude'`, so the CLI-level guard cannot
   * catch the foreign one — only the instance guard can. The foreign frame is
   * emitted first and a matching frame second, through the same synchronous
   * listener, so "the matching row arrived" proves the foreign row was already
   * offered and refused rather than merely still in flight.
   */
  it('ignores a `message` for a different instance of the same CLI tool', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude', instanceId: 'claude-2' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      realtimeMock.emit(
        messageEvent(
          'message',
          makeMessage({ id: 'other-instance', content: 'claude-3 says', instanceId: 'claude-3' }),
        ),
      );
      realtimeMock.emit(
        messageEvent(
          'message',
          makeMessage({ id: 'mine', content: 'claude-2 says', instanceId: 'claude-2' }),
        ),
      );
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['mine']);
    });
  });

  it('ignores a `message` for a different CLI tool and a different worktree', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      realtimeMock.emit(
        messageEvent(
          'message',
          makeMessage({ id: 'codex-row', cliToolId: 'codex', instanceId: 'codex' }),
        ),
      );
      realtimeMock.emit(
        messageEvent('message', makeMessage({ id: 'other-worktree' }), 'w-2'),
      );
      realtimeMock.emit(messageEvent('message', makeMessage({ id: 'mine' })));
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['mine']);
    });
  });

  it('replaces the row with the same id on `message_updated` instead of appending', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      realtimeMock.emit(
        messageEvent(
          'message',
          makeMessage({ id: 'p-1', messageType: 'prompt', content: 'Proceed?' }),
        ),
      );
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    act(() => {
      realtimeMock.emit(
        messageEvent(
          'message_updated',
          makeMessage({ id: 'p-1', messageType: 'prompt', content: 'Proceed? (answered)' }),
        ),
      );
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe('Proceed? (answered)');
    });
  });

  it('replaces rather than duplicates when a `message` repeats an id it already has', async () => {
    mockFetch.mockImplementation(() =>
      slowJson([makeMessage({ id: 'dup', content: 'from the poll' })]),
    );
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    act(() => {
      realtimeMock.emit(
        messageEvent('message', makeMessage({ id: 'dup', content: 'from the socket' })),
      );
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe('from the socket');
    });
  });

  it('orders pushed rows by timestamp, not by arrival', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      realtimeMock.emit(
        messageEvent(
          'message',
          makeMessage({ id: 'late', content: 'third', timestamp: '2024-01-01T00:00:30.000Z' }),
        ),
      );
      realtimeMock.emit(
        messageEvent(
          'message',
          makeMessage({ id: 'early', content: 'first', timestamp: '2024-01-01T00:00:10.000Z' }),
        ),
      );
      realtimeMock.emit(
        messageEvent(
          'message',
          makeMessage({ id: 'mid', content: 'second', timestamp: '2024-01-01T00:00:20.000Z' }),
        ),
      );
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    });
  });

  it('drops turns beyond the display limit, counting user rows the way the API does', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude', limit: 2 }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Three complete turns pushed in order; `limit: 2` counts turns (pairs), so
    // the oldest user row AND the assistant row that belongs to it must go.
    act(() => {
      for (const [n, at] of [
        [1, '00:00:10'],
        [2, '00:00:20'],
        [3, '00:00:30'],
      ] as const) {
        realtimeMock.emit(
          messageEvent(
            'message',
            makeMessage({
              id: `u-${n}`,
              role: 'user',
              content: `ask ${n}`,
              timestamp: `2024-01-01T${at}.000Z`,
            }),
          ),
        );
        realtimeMock.emit(
          messageEvent(
            'message',
            makeMessage({
              id: `a-${n}`,
              role: 'assistant',
              content: `answer ${n}`,
              timestamp: `2024-01-01T${at}.500Z`,
            }),
          ),
        );
      }
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['u-2', 'a-2', 'u-3', 'a-3']);
    });
  });

  it('ignores a pushed row the API itself would have filtered out (empty content)', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      realtimeMock.emit(messageEvent('message', makeMessage({ id: 'blank', content: '   ' })));
      realtimeMock.emit(messageEvent('message', makeMessage({ id: 'real' })));
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['real']);
    });
  });

  it('ignores an archived pushed row unless the pane asked for archived rows', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      realtimeMock.emit(
        messageEvent('message', makeMessage({ id: 'old-session', archived: true })),
      );
      realtimeMock.emit(messageEvent('message', makeMessage({ id: 'current' })));
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['current']);
    });
  });

  it('accepts a row whose producer omitted instanceId, resolving it to the primary instance', async () => {
    // `createMessage` returns the caller's object, so producers that never name
    // an instance (e.g. the claude-done hook route) broadcast without one. The
    // primary pane must still recognise the row as its own.
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      realtimeMock.emit(
        messageEvent('message', {
          id: 'no-instance',
          worktreeId: 'w-1',
          role: 'assistant',
          content: 'hook route reply',
          timestamp: '2024-01-01T00:00:00.000Z',
          messageType: 'normal',
          archived: false,
          cliToolId: 'claude',
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['no-instance']);
    });
  });

  it('keeps a row that arrived while a poll was in flight from being erased by that poll', async () => {
    // The poll left before the row was committed, so its response cannot contain
    // it. Overwriting the state with that response would drop a row the socket
    // had already delivered — for a whole fallback interval.
    let resolvePoll: ((res: MockFetchResponse) => void) | undefined;
    mockFetch.mockImplementationOnce(() => slowJson([])).mockImplementationOnce(
      () =>
        new Promise<MockFetchResponse>((resolve) => {
          resolvePoll = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      void result.current.refresh();
      await Promise.resolve();
    });

    act(() => {
      realtimeMock.emit(messageEvent('message', makeMessage({ id: 'raced', content: 'pushed' })));
    });

    await act(async () => {
      resolvePoll?.({ ok: true, json: async () => [] });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['raced']);
    });
  });

  it('polls every 15s while the socket is connected', async () => {
    realtimeMock.setConnected(true);
    vi.useFakeTimers();
    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, json: async () => [] }));

    renderHook(() => useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    mockFetch.mockClear();

    // Well past the 5s fallback cadence — nothing may fire yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_CONNECTED_SPLIT_MESSAGES_POLL_INTERVAL_MS - 1);
    });
    expect(mockFetch).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the 5s fallback cadence while the socket is down', async () => {
    realtimeMock.setConnected(false);
    vi.useFakeTimers();
    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, json: async () => [] }));

    renderHook(() => useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    mockFetch.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPLIT_MESSAGES_POLL_INTERVAL_MS);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once on disconnect and once on reconnect', async () => {
    realtimeMock.setConnected(true);
    const { rerender } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));

    // Socket drops: the pane cannot know what it missed, so it re-reads once.
    mockFetch.mockClear();
    realtimeMock.setConnected(false);
    act(() => {
      rerender();
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Socket comes back: rows written during the outage were broadcast to
    // nobody, so the recovery re-read happens here too.
    mockFetch.mockClear();
    realtimeMock.setConnected(true);
    act(() => {
      rerender();
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });
});
