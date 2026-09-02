/**
 * useSplitMessages — `messages_invalidated` (Issue #2219)
 *
 * The pane can add and replace rows from the socket (#2195) but has no way to
 * lose one, and one producer removes rows: `sendUserMessage` deletes the
 * previous identical user row when a send is retried (#379's duplicate guard).
 * The device that did not send it therefore rendered the removed row next to
 * the new one — the same sentence twice — until its own poll, which #2195
 * demoted to a 15s fallback while a socket is up.
 *
 * `messages_invalidated` carries a scope rather than a row id, and this suite
 * pins what the pane does with it:
 *
 *  - a frame for THIS pane re-reads history, so the removed row disappears and
 *    anything the same round trip settles arrives with it;
 *  - a frame for another instance of the same tool, another tool, or another
 *    worktree is ignored — a sibling's cleanup must not disturb this pane;
 *  - the re-fetch retires an older in-flight fetch, which is the response that
 *    would otherwise land with the deleted row still in its body.
 *
 * Fetch latency is deliberate (a real 10ms timer) for the reason
 * `useSplitMessages-realtime-2195.test.ts` documents: CI runs vitest with
 * `fileParallelism: false`, and a resolution that lands in the calling
 * microtask hides ordering bugs.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import { MESSAGES_INVALIDATED_EVENT_TYPE } from '@/lib/realtime/types';

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const state = { connected: true };
  return {
    state,
    emit: (event: unknown) => {
      for (const listener of [...listeners]) listener(event);
    },
    reset: () => {
      listeners.length = 0;
      state.connected = true;
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

const FETCH_DELAY_MS = 10;

interface Row {
  id: string;
  worktreeId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  messageType: string;
  archived: boolean;
  cliToolId: string;
  instanceId: string;
}

function row(id: string, content: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    worktreeId: 'w-1',
    role: 'user',
    content,
    timestamp: '2024-01-01T00:00:00.000Z',
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    instanceId: 'claude',
    ...overrides,
  };
}

/** A frame exactly as `sendUserMessage` shapes it after an orphan delete. */
function invalidatedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: MESSAGES_INVALIDATED_EVENT_TYPE,
    worktreeId: 'w-1',
    cliToolId: 'claude',
    instanceId: 'claude',
    reason: 'orphan_cleanup',
    ...overrides,
  };
}

describe('useSplitMessages history invalidation (Issue #2219)', () => {
  let bodies: Row[][];
  let mockFetch: ReturnType<typeof vi.fn>;

  /** Serve `bodies` in order, repeating the last one once exhausted. */
  function serve() {
    return new Promise((resolve) => {
      const body = bodies.length > 1 ? (bodies.shift() as Row[]) : bodies[0];
      setTimeout(() => resolve({ ok: true, json: async () => body }), FETCH_DELAY_MS);
    });
  }

  beforeEach(() => {
    realtimeMock.reset();
    bodies = [[]];
    mockFetch = vi.fn(() => serve());
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

  /**
   * MUTATION TARGET (acceptance criterion "変異注入"): removing the
   * `messages_invalidated` branch from `useSplitMessages` — or the
   * `broadcastMessage(MESSAGES_INVALIDATED_EVENT_TYPE, …)` call from
   * `sendUserMessage`, which is what puts the frame on the wire — must turn
   * this test red. It is the "the other device stops showing the deleted row"
   * assertion.
   */
  it('re-reads history when its own scope is invalidated, dropping the removed row', async () => {
    bodies = [[row('orphan-1', 'retry me')], [row('new-1', 'retry me')]];

    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['orphan-1']));
    const fetchesBefore = mockFetch.mock.calls.length;

    act(() => {
      realtimeMock.emit(invalidatedEvent());
    });

    await waitFor(() => {
      expect(mockFetch.mock.calls.length).toBe(fetchesBefore + 1);
      expect(result.current.messages.map((m) => m.id)).toEqual(['new-1']);
    });
  });

  it('ignores a frame for another instance of the same CLI tool', async () => {
    // The sibling-instance guard, which is the only one that can catch this:
    // both frames carry `cliToolId: 'claude'`. A matching frame follows through
    // the same synchronous listener, so a single re-fetch proves the first one
    // was refused rather than merely still in flight.
    bodies = [[row('mine', 'kept', { instanceId: 'claude-2' })]];

    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude', instanceId: 'claude-2' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const fetchesBefore = mockFetch.mock.calls.length;

    act(() => {
      realtimeMock.emit(invalidatedEvent({ instanceId: 'claude-3' }));
      realtimeMock.emit(invalidatedEvent({ instanceId: 'claude-2' }));
    });

    await waitFor(() => expect(mockFetch.mock.calls.length).toBe(fetchesBefore + 1));
    // Give a mistakenly-accepted frame a chance to show up before concluding.
    await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS * 3));
    expect(mockFetch.mock.calls.length).toBe(fetchesBefore + 1);
  });

  it('ignores a frame for another CLI tool or another worktree', async () => {
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const fetchesBefore = mockFetch.mock.calls.length;

    act(() => {
      realtimeMock.emit(invalidatedEvent({ cliToolId: 'codex', instanceId: 'codex' }));
      realtimeMock.emit(invalidatedEvent({ worktreeId: 'w-2' }));
    });

    await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS * 3));
    expect(mockFetch.mock.calls.length).toBe(fetchesBefore);
  });

  it('treats an omitted instanceId as the primary instance, as the row path does', async () => {
    // Defensive parity with the `message` branch: a producer that resolved its
    // scope and one that left the primary instance implicit must address the
    // same pane, or the two contracts drift apart.
    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const fetchesBefore = mockFetch.mock.calls.length;

    act(() => {
      realtimeMock.emit({
        type: MESSAGES_INVALIDATED_EVENT_TYPE,
        worktreeId: 'w-1',
        cliToolId: 'claude',
        reason: 'orphan_cleanup',
      });
    });

    await waitFor(() => expect(mockFetch.mock.calls.length).toBe(fetchesBefore + 1));
  });

  it('retires a fetch that started before the delete', async () => {
    // The race the invalidation exists to survive: a poll left while the orphan
    // was still committed, so its body still contains it. The re-fetch bumps
    // the hook's request id, and the older response must be dropped rather than
    // overwrite the newer one.
    const slow = { ok: true, json: async () => [row('orphan-1', 'retry me')] };
    const fresh = { ok: true, json: async () => [row('new-1', 'retry me')] };
    // Held in an object: a `let` assigned only inside a callback stays narrowed
    // to `null` for the type checker at the call site below.
    const slowGate: { release: (() => void) | null } = { release: null };

    mockFetch = vi
      .fn()
      // 1st: the hook's initial fetch — resolves normally so the pane settles.
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(slow), FETCH_DELAY_MS)),
      )
      // 2nd: the poll that left before the delete, held open on purpose.
      .mockImplementationOnce(
        () => new Promise((resolve) => { slowGate.release = () => resolve(slow); }),
      )
      // 3rd: the invalidation's re-fetch.
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(fresh), FETCH_DELAY_MS)),
      );
    global.fetch = mockFetch as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useSplitMessages({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['orphan-1']));

    // The in-flight poll (2nd call), then the delete's invalidation (3rd).
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(mockFetch.mock.calls.length).toBe(2));
    act(() => {
      realtimeMock.emit(invalidatedEvent());
    });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['new-1']));

    // Now let the stale response land. It must not resurrect the deleted row.
    act(() => {
      slowGate.release?.();
    });
    await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS * 3));
    expect(result.current.messages.map((m) => m.id)).toEqual(['new-1']);
  });
});
