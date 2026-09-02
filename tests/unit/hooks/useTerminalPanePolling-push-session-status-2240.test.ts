/**
 * The pushed generating verdict (Issue #2240).
 *
 * #2238 moved the chat surface's "is a turn running" gate onto `sessionStatus`,
 * the merged verdict `buildCurrentOutput` publishes. Only the HTTP poll carried
 * that field: `terminal_snapshot` — the WebSocket push, and the path that
 * actually feeds a pane while a turn runs — had no `sessionStatus` member, so
 * #2239 had to express "this delivery path says nothing" as a retention
 * (`data.sessionStatus ?? prev.sessionStatus`) and lean on the poll for the
 * value itself.
 *
 * That leaves one state the retention cannot rescue: **a pane whose first frame
 * arrives by push.** `prev.sessionStatus` is `''` there, so the surface shows no
 * live bubble at all until the fallback poll lands — up to
 * `WS_CONNECTED_POLLING_INTERVAL_MS` (15s) into a turn that is already running.
 * The first test below is that state, and it is the point of the issue.
 *
 * The poll is frozen for the whole file (a never-resolving fetch). Without that
 * every assertion here is VACUOUS — the poll re-publishes `sessionStatus` on its
 * own interval and would repair anything the push got wrong before the assertion
 * read it. Frozen, the pushed event is the only thing that can move the state.
 *
 * Scope note: this file pins what reaches `terminal.sessionStatus`. That the
 * value `'running'` is what makes the surface say "Responding…" is pinned next
 * door, in `ChatSurface-generating-2238` — the two together are the criterion
 * "push alone raises the generating verdict".
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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

const WORKTREE_ID = 'w-2240';

/**
 * One `terminal_snapshot` as a current server broadcasts it.
 *
 * Typed as the real event so that dropping `sessionStatus` from
 * `TerminalSnapshotEvent` fails this file at compile time as well as at run
 * time — the fixture cannot drift away from the contract it is testing.
 */
function snapshot(
  version: number,
  sessionStatus: string,
  overrides: Partial<TerminalSnapshotEvent> = {},
): TerminalSnapshotEvent {
  return {
    type: 'terminal_snapshot',
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    instanceId: 'claude',
    output: `frame-${version}`,
    isRunning: true,
    sessionStatus,
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

describe('[#2240] terminal_snapshot carries the pane its own sessionStatus', () => {
  beforeEach(() => {
    realtimeMock.listeners.length = 0;
    // Frozen for every test in this file. See the header.
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('raises the verdict from a push alone, with no poll ever resolving', async () => {
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude' }),
    );
    // The state the retention could not rescue: nothing has been polled, so
    // there is no previous value to hold.
    expect(result.current.terminal.sessionStatus).toBe('');

    act(() => realtimeMock.emit(snapshot(1, 'running')));

    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('running'));
    // The frame really was applied — the verdict did not arrive by some other
    // route while the push was dropped.
    expect(result.current.terminal.output).toBe('frame-1');
  });

  it('follows the push down as well as up', async () => {
    // The retention must not pin the verdict high. A turn that ends while push
    // is healthy publishes `'ready'` on the very next frame, and holding
    // `'running'` there is the #2238 defect ("Responding…" forever) reached from
    // the other side.
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude' }),
    );
    act(() => realtimeMock.emit(snapshot(1, 'running')));
    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('running'));

    act(() => realtimeMock.emit(snapshot(2, 'ready', { thinking: false })));

    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('ready'));
    // Still a healthy session: the two fields answer different questions, which
    // is the whole of #2238.
    expect(result.current.terminal.isRunning).toBe(true);
  });

  it('reports a waiting frame as waiting rather than as generating', async () => {
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude' }),
    );

    act(() =>
      realtimeMock.emit(
        snapshot(1, 'waiting', { thinking: false, isPromptWaiting: true }),
      ),
    );

    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('waiting'));
  });

  it('keeps the last verdict when a push carries none (a server older than #2240)', async () => {
    // The deliberate half of the decision. The wire is parsed, not validated,
    // and the version-drift banner only nudges a reload — a tab held open across
    // a downgrade keeps applying frames from a server that predates the field.
    // Blanking on those would strobe the bubble through the whole turn.
    const { result } = renderHook(() =>
      useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude' }),
    );
    act(() => realtimeMock.emit(snapshot(1, 'running')));
    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('running'));

    const legacy = { ...snapshot(2, '', { output: 'legacy frame' }) } as Record<string, unknown>;
    delete legacy.sessionStatus;
    act(() => realtimeMock.emit(legacy));

    await waitFor(() => expect(result.current.terminal.output).toBe('legacy frame'));
    expect(result.current.terminal.sessionStatus).toBe('running');
  });

  it('does not leak a pushed verdict into a different instance', async () => {
    const { result, rerender } = renderHook(
      ({ instanceId }: { instanceId: string }) =>
        useTerminalPanePolling({ worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId }),
      { initialProps: { instanceId: 'claude' } },
    );
    act(() => realtimeMock.emit(snapshot(1, 'running')));
    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe('running'));

    rerender({ instanceId: 'claude-2' });

    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe(''));
    // And a frame addressed to the first instance stays out of the second.
    act(() => realtimeMock.emit(snapshot(2, 'running')));
    await waitFor(() => expect(result.current.terminal.sessionStatus).toBe(''));
  });
});
