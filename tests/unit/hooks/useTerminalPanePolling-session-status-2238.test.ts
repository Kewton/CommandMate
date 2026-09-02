/**
 * The pane's generating verdict (Issue #2238).
 *
 * `/current-output` has published `sessionStatus` all along; this hook read
 * every other field on the payload and not that one, so the chat surface had
 * nothing to gate on but `isRunning` — "a healthy tmux session exists" — and
 * said "Responding…" on every live pane forever.
 *
 * Reading one more field would be a one-line change with nothing to test, if it
 * were not for the seam this file exists for: **the two delivery paths were not
 * equal here.** `terminal_snapshot` — the WebSocket push, which is what actually
 * feeds a pane while a turn runs — had no `sessionStatus` member at all, and it
 * shares `applySnapshot` with the HTTP poll. Blank it on every push and the
 * bubble strobes through the whole turn; hold it on every path and a kill leaves
 * a dead pane claiming to generate. Both of those are asserted below.
 *
 * Issue #2240 has since put `sessionStatus` on the push, so the frames in this
 * file — which deliberately omit it — are now the OLD server's shape rather than
 * the current one. They are kept exactly as they are: that combination is why
 * the retention in `applySnapshot` survived #2240, and this file is where it is
 * pinned. The frames a current server sends are asserted in
 * `useTerminalPanePolling-push-session-status-2240`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const api = {
    status: 'connected' as const,
    connected: true,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: (l: (e: unknown) => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return {
    listeners,
    emit: (event: unknown) => {
      for (const l of [...listeners]) l(event);
    },
    useRealtime: () => api,
  };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: realtimeMock.useRealtime,
}));

type MockFetchResponse = { ok: boolean; json: () => Promise<unknown> };

const okJson = (data: unknown): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: true, json: async () => data });

/**
 * Stop the HTTP poll dead.
 *
 * Without this the two realtime tests below are VACUOUS: the poll runs on its
 * own interval and re-publishes `sessionStatus` a tick later, so a push that
 * wrongly blanked the field would be repaired before the assertion read it —
 * measured, by mutating `applySnapshot` to `data.sessionStatus ?? ''` and
 * watching them stay green. A never-resolving fetch makes the pushed event the
 * only thing that can move the state.
 */
function freezePoll(
  mockFetch: ReturnType<typeof vi.fn<(input: string | URL | Request) => Promise<MockFetchResponse>>>,
): void {
  mockFetch.mockImplementation(() => new Promise<MockFetchResponse>(() => {}));
}

/** One `terminal_snapshot` for the pane under test. Carries no `sessionStatus`
 *  — that is the point: it is the shape a server older than #2240 broadcasts,
 *  and the client still has to keep its verdict when one arrives. */
function snapshot(version: number, overrides: Record<string, unknown> = {}) {
  return {
    type: 'terminal_snapshot',
    worktreeId: 'w-1',
    cliToolId: 'claude',
    instanceId: 'claude',
    output: 'pushed frame',
    isRunning: true,
    thinking: true,
    isPromptWaiting: false,
    promptData: null,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
    version,
    ...overrides,
  };
}

describe('[#2238] useTerminalPanePolling exposes sessionStatus', () => {
  let mockFetch: ReturnType<typeof vi.fn<(input: string | URL | Request) => Promise<MockFetchResponse>>>;

  beforeEach(() => {
    realtimeMock.listeners.length = 0;
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is empty before the first poll resolves', () => {
    mockFetch.mockImplementation(() => new Promise<MockFetchResponse>(() => {}));
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    // Not `'ready'`: the pane has heard nothing, and guessing a verdict here
    // would be a claim about a session nobody has looked at.
    expect(result.current.terminal.sessionStatus).toBe('');
  });

  it('publishes the merged verdict the poll returns', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, fullOutput: 'frame', thinking: true, sessionStatus: 'running' }),
    );
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('running'));
  });

  it('reports an idle agent on a healthy session as running=true, status=ready', async () => {
    // The exact pair the bug was reported in, at the layer that produces it.
    // It is not a contradiction: the session is up, the agent is at its prompt.
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, fullOutput: 'frame', thinking: false, sessionStatus: 'ready' }),
    );
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('ready'));
    expect(result.current.terminal.isRunning).toBe(true);
  });

  it('keeps the last polled verdict across a pre-#2240 push, which carries none', async () => {
    // While push is healthy the HTTP poll drops to a 15s fallback, so a push
    // that blanked this field would take the bubble down for most of the turn.
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, fullOutput: 'frame', thinking: true, sessionStatus: 'running' }),
    );
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('running'));
    freezePoll(mockFetch);

    act(() => realtimeMock.emit(snapshot(1)));

    await waitFor(() => expect(result.current.terminal.output).toBe('pushed frame'));
    expect(result.current.terminal.sessionStatus).toBe('running');
  });

  it('clears it to idle on a matching session_status_changed stop', async () => {
    // The other direction: a kill IS knowledge that the session stopped, and
    // `buildCurrentOutput` publishes `'idle'` for one. Holding `'running'` here
    // would leave the chat surface generating on a dead pane until the next
    // poll landed.
    mockFetch.mockImplementation(() =>
      okJson({ isRunning: true, fullOutput: 'frame', thinking: true, sessionStatus: 'running' }),
    );
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );
    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('running'));
    freezePoll(mockFetch);

    act(() =>
      realtimeMock.emit({
        type: 'session_status_changed',
        worktreeId: 'w-1',
        cliTool: 'claude',
        instance: 'claude',
        isRunning: false,
      }),
    );

    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('idle'));
    expect(result.current.terminal.isRunning).toBe(false);
  });

  it('starts a different instance from empty rather than inheriting a verdict', async () => {
    mockFetch.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : String(input);
      return url.includes('instance=claude-2')
        ? new Promise<MockFetchResponse>(() => {})
        : okJson({ isRunning: true, fullOutput: 'frame', thinking: true, sessionStatus: 'running' });
    });
    const { result, rerender } = renderHook(
      ({ instanceId }: { instanceId: string }) =>
        useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude', instanceId }),
      { initialProps: { instanceId: 'claude' } },
    );
    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('running'));

    rerender({ instanceId: 'claude-2' });

    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe(''));
  });
});
