/**
 * `isDismissablePanelActive` survives BOTH delivery paths (Issue #2369).
 *
 * The Issue's own working rule is that a new boolean has to be threaded through
 * every file `isPagerActive` passes through, and that one omission anywhere
 * leaves the chat surface unchanged. This hook is where the two paths meet: the
 * HTTP poll assigns `/current-output`'s payload straight into `applySnapshot`,
 * and the WebSocket `terminal_snapshot` builds a call to the same function field
 * by field — so a field can be present on the wire, present in the payload type,
 * and still be dropped here by one path and not the other.
 *
 * Both are exercised, and the poll is frozen in the push test (a never-resolving
 * fetch) for the reason `useTerminalPanePolling-push-session-status-2240` gives:
 * an unfrozen poll re-publishes the state on its own interval and would repair
 * anything the push got wrong before an assertion could read it.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import type { TerminalSnapshotEvent } from '@/lib/realtime/types';

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

const WORKTREE_ID = 'w-2369';

/** One `terminal_snapshot`, typed as the real event so the fixture cannot drift. */
function snapshot(overrides: Partial<TerminalSnapshotEvent> = {}): TerminalSnapshotEvent {
  return {
    type: 'terminal_snapshot',
    worktreeId: WORKTREE_ID,
    cliToolId: 'command-code',
    instanceId: 'command-code',
    output: 'Press Esc to close',
    isRunning: true,
    sessionStatus: 'waiting',
    thinking: false,
    isPromptWaiting: false,
    promptData: null,
    isSelectionListActive: false,
    isPagerActive: false,
    isDismissablePanelActive: true,
    isUnclassifiedActive: false,
    version: 1,
    ...overrides,
  };
}

/** A `/current-output` body, as the server sends one for the `/usage` panel. */
function pollBody(overrides: Record<string, unknown> = {}) {
  return {
    isRunning: true,
    cliToolId: 'command-code',
    sessionStatus: 'waiting',
    thinking: false,
    isPromptWaiting: false,
    fullOutput: 'Press Esc to close',
    realtimeSnippet: 'Press Esc to close',
    isSelectionListActive: false,
    isPagerActive: false,
    isDismissablePanelActive: true,
    isUnclassifiedActive: false,
    ...overrides,
  };
}

beforeEach(() => {
  realtimeMock.listeners.length = 0;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[#2369] the dismiss-only flag reaches the pane state', () => {
  it('carries it from the HTTP poll', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => pollBody(),
    })) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'command-code' }),
    );

    await waitFor(() => {
      expect(result.current.terminal.isDismissablePanelActive).toBe(true);
    });
    // Disjoint, not a subset: the arrow pad must stay away from this screen.
    expect(result.current.terminal.isSelectionListActive).toBe(false);
    expect(result.current.terminal.isPagerActive).toBe(false);
  });

  it('carries it from a WebSocket push with no poll ever resolving', async () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'command-code' }),
    );

    await waitFor(() => expect(realtimeMock.listeners.length).toBeGreaterThan(0));
    realtimeMock.emit(snapshot());

    await waitFor(() => {
      expect(result.current.terminal.isDismissablePanelActive).toBe(true);
    });
  });

  it('lowers it again on the frame that follows the dismiss', async () => {
    // The Esc that closes the panel is also what unmounts the card, so a flag
    // that latched would leave an Esc button over an ordinary composer.
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'command-code' }),
    );

    await waitFor(() => expect(realtimeMock.listeners.length).toBeGreaterThan(0));
    realtimeMock.emit(snapshot());
    await waitFor(() => expect(result.current.terminal.isDismissablePanelActive).toBe(true));

    realtimeMock.emit(
      snapshot({
        version: 2,
        output: '❯ Ask your question...',
        sessionStatus: 'ready',
        isDismissablePanelActive: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.terminal.isDismissablePanelActive).toBe(false);
    });
  });

  it('reads an older daemon that omits the field as false, not as a panel', async () => {
    // `undefined` on the wire means "this server predates #2369". Treating it as
    // a panel would replace the hatch with an Esc button on every unclassified
    // frame such a server publishes.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        const body = pollBody({ isUnclassifiedActive: true, sessionStatus: 'running' });
        delete (body as Record<string, unknown>).isDismissablePanelActive;
        return body;
      },
    })) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'command-code' }),
    );

    await waitFor(() => expect(result.current.terminal.attaching).toBe(false));
    expect(result.current.terminal.isDismissablePanelActive).toBe(false);
  });
});
