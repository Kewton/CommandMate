/**
 * The pane hook publishing what the agent says about its own session (#2042).
 *
 * Two properties, and the second is the reason the first is not enough:
 *
 *  - **Only the HTTP poll carries it.** A `terminal_snapshot` push carries a
 *    frame and a fixed set of flags and no `structuredEvents` at all, so folding
 *    this into the shared `applySnapshot` would blank the cost every time output
 *    streamed in — which, while a turn runs, is many times a second.
 *  - **The identity only moves when a rendered value moves.** The header pill
 *    map upstream is React state, and a poll that repeats the same numbers
 *    every 2s on every open split would otherwise re-render the whole detail
 *    view on a cadence.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const api = {
    status: 'disconnected' as const,
    connected: false,
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
    emit: (event: unknown) => { for (const l of [...listeners]) l(event); },
    useRealtime: () => api,
  };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({ useRealtime: realtimeMock.useRealtime }));

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

/** The session as the server publishes it, with the measured numbers. */
const SESSION = {
  id: 'ses_measured',
  title: 'One-word response: PONG',
  agent: 'build',
  model: 'claude-sonnet-4.6',
  provider: 'github-copilot',
  cost: 0.0346026,
  tokens: { input: 6, output: 11, reasoning: 0, cacheRead: 8482, cacheWrite: 8500, total: null },
  at: 1_700_000_000_000,
};

const CONTEXT = {
  tokens: 8_508,
  limit: 1_000_000,
  percent: 1,
  sessionAt: 1_700_000_000_000,
  at: 1_700_000_000_100,
};

function payload(structuredEvents?: unknown): unknown {
  return {
    isRunning: true,
    cliToolId: 'opencode',
    fullOutput: 'output\n',
    ...(structuredEvents ? { structuredEvents } : {}),
  };
}

describe('useTerminalPanePolling agent session (Issue #2042)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes both blocks off the poll', async () => {
    mockFetch.mockImplementation(() =>
      okJson(payload({ session: SESSION, sessionContext: CONTEXT })),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'opencode' }),
    );

    await waitFor(() => expect(result.current.agentSession.session).toEqual(SESSION));
    expect(result.current.agentSession.context).toEqual(CONTEXT);
  });

  it('starts empty, so a pane renders nothing before its first reply', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'opencode' }),
    );

    expect(result.current.agentSession).toEqual({ session: null, context: null });
  });

  it('answers nulls for a tool that publishes none', async () => {
    mockFetch.mockImplementation(() => okJson({ isRunning: true, cliToolId: 'claude', fullOutput: 'x' }));

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'claude' }),
    );

    await waitFor(() => expect(result.current.terminal.isRunning).toBe(true));
    expect(result.current.agentSession).toEqual({ session: null, context: null });
  });

  it('keeps the same object across polls that repeat the same numbers', async () => {
    mockFetch.mockImplementation(() =>
      okJson(payload({ session: SESSION, sessionContext: CONTEXT })),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'opencode' }),
    );

    await waitFor(() => expect(result.current.agentSession.session).not.toBeNull());
    const first = result.current.agentSession;

    await act(async () => {
      await result.current.refresh();
    });
    // A fresh object here would re-render the header's instance-pill map on
    // every poll, on every open split.
    expect(result.current.agentSession).toBe(first);
  });

  it('replaces the object when a rendered value actually moves', async () => {
    mockFetch.mockImplementation(() =>
      okJson(payload({ session: SESSION, sessionContext: CONTEXT })),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'opencode' }),
    );

    await waitFor(() => expect(result.current.agentSession.session).not.toBeNull());
    const first = result.current.agentSession;

    mockFetch.mockImplementation(() =>
      okJson(
        payload({
          session: { ...SESSION, cost: 0.99, at: 1_700_000_009_999 },
          sessionContext: { ...CONTEXT, tokens: 20_000, percent: 2 },
        }),
      ),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.agentSession).not.toBe(first);
    expect(result.current.agentSession.session?.cost).toBe(0.99);
    expect(result.current.agentSession.context?.percent).toBe(2);
  });

  it('ignores a timestamp-only change, which the agent emits several times a turn', async () => {
    mockFetch.mockImplementation(() =>
      okJson(payload({ session: SESSION, sessionContext: CONTEXT })),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'opencode' }),
    );

    await waitFor(() => expect(result.current.agentSession.session).not.toBeNull());
    const first = result.current.agentSession;

    mockFetch.mockImplementation(() =>
      okJson(payload({ session: { ...SESSION, at: 1_700_000_099_999 }, sessionContext: CONTEXT })),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.agentSession).toBe(first);
  });

  it('is not blanked by a WebSocket snapshot, which carries no structuredEvents', async () => {
    mockFetch.mockImplementation(() =>
      okJson(payload({ session: SESSION, sessionContext: CONTEXT })),
    );

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'opencode' }),
    );

    await waitFor(() => expect(result.current.agentSession.session).not.toBeNull());

    act(() => {
      realtimeMock.emit({
        type: 'terminal_snapshot',
        worktreeId: 'w-1',
        cliToolId: 'opencode',
        instanceId: 'opencode',
        version: 1,
        output: 'pushed output\n',
      });
    });

    await waitFor(() => expect(result.current.terminal.output).toContain('pushed output'));
    expect(result.current.agentSession.session).toEqual(SESSION);
    expect(result.current.agentSession.context).toEqual(CONTEXT);
  });

  it('clears when the pane switches to another instance', async () => {
    mockFetch.mockImplementation(() =>
      okJson(payload({ session: SESSION, sessionContext: CONTEXT })),
    );

    const { result, rerender } = renderHook(
      ({ instanceId }: { instanceId: string }) =>
        useTerminalPanePolling({ worktreeId: 'w-1', cliToolId: 'opencode', instanceId }),
      { initialProps: { instanceId: 'opencode' } },
    );

    await waitFor(() => expect(result.current.agentSession.session).not.toBeNull());

    mockFetch.mockImplementation(() => new Promise(() => {}));
    rerender({ instanceId: 'opencode-2' });

    // A different conversation. Showing the previous instance's cost while the
    // first poll is in flight is the same mistake blanking the terminal avoids.
    expect(result.current.agentSession).toEqual({ session: null, context: null });
  });
});
