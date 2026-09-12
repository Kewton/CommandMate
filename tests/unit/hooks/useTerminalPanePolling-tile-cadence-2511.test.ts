/**
 * useTerminalPanePolling — the cadence, counted against the real hook (#2511).
 *
 * `tests/unit/config/pane-polling-cadence-2511` checks the rule. This checks the
 * hook: that `setInterval` really runs at the length the rule names, for both
 * profiles, by advancing fake timers and counting `fetch` calls.
 *
 * The half that matters most is the **first** describe block. #2511's acceptance
 * criteria require that `/worktrees/<id>` polls exactly as it did before, and the
 * only way to state that as a test is to drive the hook with no `cadence` option
 * — the way every existing caller does — and assert the intervals the worktree
 * screen has had since #1120. If a later change makes the default profile drift,
 * these are the assertions that fail rather than a user noticing a laggy screen.
 *
 * ## Counting convention
 *
 * The hook fetches once immediately on mount and once per interval afterwards,
 * and it re-creates the interval whenever a cadence input changes — including on
 * the state update the first response produces. Each test therefore settles the
 * hook first, clears the mock, and then measures one clean interval: nothing
 * fires at `interval - 1`, exactly one fetch at `interval`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import {
  DETAIL_PANE_POLLING_CADENCE,
  TILE_PANE_POLLING_CADENCE,
} from '@/config/pane-polling-cadence';

/** Realtime mock with a mutable `connected`, and a way to push a snapshot. */
const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const state = { connected: false };
  return {
    state,
    setConnected: (value: boolean) => { state.connected = value; },
    emit: (event: unknown) => { for (const l of [...listeners]) l(event); },
    reset: () => { listeners.length = 0; state.connected = false; },
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

interface PayloadOverrides {
  isRunning?: boolean;
  sessionStatus?: string;
}

/**
 * A `/current-output` body.
 *
 * `isRunning` and `sessionStatus` are the two the cadence turns on, and they are
 * deliberately settable apart: "a healthy tmux session exists" and "the agent is
 * generating" are different questions (#2238), and the whole tile profile rests
 * on the difference.
 */
function payload(overrides: PayloadOverrides = {}) {
  return {
    isRunning: overrides.isRunning ?? true,
    sessionStatus: overrides.sessionStatus ?? 'ready',
    fullOutput: 'frame',
    realtimeSnippet: 'frame',
    thinking: false,
  };
}

describe('useTerminalPanePolling cadence (Issue #2511)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    realtimeMock.reset();
    mockFetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => payload() }));
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Mount with fake timers, let the first response settle, and hand back a
   * counter over one interval.
   */
  async function measure(
    options: Parameters<typeof useTerminalPanePolling>[0],
    body: ReturnType<typeof payload>,
  ) {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, json: async () => body }));
    vi.useFakeTimers();
    renderHook(() => useTerminalPanePolling(options));
    // Drain the mount fetch and the interval re-creation its state update causes.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    mockFetch.mockClear();
    return {
      async advance(ms: number) {
        await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
        return mockFetch.mock.calls.length;
      },
    };
  }

  /** Assert that the next poll lands at exactly `intervalMs` and not before. */
  async function expectInterval(
    options: Parameters<typeof useTerminalPanePolling>[0],
    body: ReturnType<typeof payload>,
    intervalMs: number,
  ) {
    const m = await measure(options, body);
    expect(await m.advance(intervalMs - 1)).toBe(0);
    expect(await m.advance(1)).toBe(1);
  }

  describe('the worktree screen is untouched (#2511 acceptance criterion)', () => {
    const detailOptions = { worktreeId: 'w-1', cliToolId: 'claude' as const };

    it('polls at 2s for a live session with no push, exactly as before', async () => {
      // `isRunning` alone earns the active cadence here — that is the pre-#2511
      // behaviour, and the tile profile is the only place it changes.
      await expectInterval(
        detailOptions,
        payload({ isRunning: true, sessionStatus: 'ready' }),
        DETAIL_PANE_POLLING_CADENCE.activeMs,
      );
      expect(DETAIL_PANE_POLLING_CADENCE.activeMs).toBe(2000);
    });

    it('polls at 5s when there is no session', async () => {
      await expectInterval(
        detailOptions,
        payload({ isRunning: false, sessionStatus: 'idle' }),
        DETAIL_PANE_POLLING_CADENCE.idleMs,
      );
      expect(DETAIL_PANE_POLLING_CADENCE.idleMs).toBe(5000);
    });

    it('still polls at 2s while merely CONNECTED, with no push heartbeat', async () => {
      // The behaviour #2511 changes for tiles and deliberately leaves here: a
      // connection alone does not slow the worktree screen down.
      realtimeMock.setConnected(true);
      await expectInterval(
        detailOptions,
        payload({ isRunning: true, sessionStatus: 'ready' }),
        DETAIL_PANE_POLLING_CADENCE.activeMs,
      );
    });

    it('is unaffected by the session being idle rather than generating', async () => {
      // `sessionStatus` is a new cadence input as of #2511. The detail profile
      // ignores it, and this is what says so.
      await expectInterval(
        detailOptions,
        payload({ isRunning: true, sessionStatus: 'idle' }),
        DETAIL_PANE_POLLING_CADENCE.activeMs,
      );
    });
  });

  describe('a tile', () => {
    const tileOptions = {
      worktreeId: 'w-1',
      cliToolId: 'claude' as const,
      cadence: TILE_PANE_POLLING_CADENCE,
    };

    it('polls at 15s while connected and not generating', async () => {
      realtimeMock.setConnected(true);
      await expectInterval(
        tileOptions,
        payload({ isRunning: true, sessionStatus: 'ready' }),
        TILE_PANE_POLLING_CADENCE.wsFallbackMs,
      );
    });

    it('polls at 10s while disconnected and not generating', async () => {
      await expectInterval(
        tileOptions,
        payload({ isRunning: true, sessionStatus: 'ready' }),
        TILE_PANE_POLLING_CADENCE.idleMs,
      );
    });

    it('polls at 4s once the agent is generating and push is not carrying it', async () => {
      realtimeMock.setConnected(true);
      await expectInterval(
        tileOptions,
        payload({ isRunning: true, sessionStatus: 'running' }),
        TILE_PANE_POLLING_CADENCE.activeMs,
      );
    });

    it('polls at 4s while a prompt is waiting', async () => {
      await expectInterval(
        tileOptions,
        payload({ isRunning: true, sessionStatus: 'waiting' }),
        TILE_PANE_POLLING_CADENCE.activeMs,
      );
    });

    it('makes strictly fewer requests than the worktree screen over a quiet minute', async () => {
      // The measurement's headline, restated as an assertion: a quiet, connected
      // pane costs 4 polls a minute as a tile and 30 as a worktree screen.
      realtimeMock.setConnected(true);
      const quiet = payload({ isRunning: true, sessionStatus: 'ready' });

      const tile = await measure(tileOptions, quiet);
      const tileCalls = await tile.advance(60_000);
      vi.useRealTimers();

      const detail = await measure({ worktreeId: 'w-1', cliToolId: 'claude' }, quiet);
      const detailCalls = await detail.advance(60_000);

      expect(tileCalls).toBe(4);
      expect(detailCalls).toBe(30);
    });
  });
});
