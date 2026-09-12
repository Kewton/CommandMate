/**
 * useSplitMessages — the history poll cadence, per profile (Issue #2511).
 *
 * `/messages` is the cheaper of a tile's two pollers (40KB, ~5ms, no tmux work
 * at all in the measurement), so this is the smaller half of the saving. It is
 * still worth a profile: history has been push-first since #2195, which makes
 * the poll a gap-filler, and a gap-filler on twenty tiles does not need to run
 * three times a minute.
 *
 * As in the terminal-pane suite, the first block is the one that matters for the
 * acceptance criteria — the worktree screen's 5s / 15s, asserted through the
 * hook's own default so that a drift in the default profile fails here.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import {
  DETAIL_MESSAGES_POLLING_CADENCE,
  TILE_MESSAGES_POLLING_CADENCE,
} from '@/config/pane-polling-cadence';

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const state = { connected: false };
  return {
    setConnected: (value: boolean) => { state.connected = value; },
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

describe('useSplitMessages cadence (Issue #2511)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    realtimeMock.reset();
    mockFetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Mount, settle the first fetch, then assert the next poll's exact timing. */
  async function expectInterval(
    options: Parameters<typeof useSplitMessages>[0],
    intervalMs: number,
  ) {
    vi.useFakeTimers();
    renderHook(() => useSplitMessages(options));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    mockFetch.mockClear();

    await act(async () => { await vi.advanceTimersByTimeAsync(intervalMs - 1); });
    expect(mockFetch).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  }

  describe('the worktree screen is untouched', () => {
    const detailOptions = { worktreeId: 'w-1', cliToolId: 'claude' as const };

    it('keeps the 5s fallback while the socket is down', async () => {
      await expectInterval(detailOptions, DETAIL_MESSAGES_POLLING_CADENCE.pollMs);
      expect(DETAIL_MESSAGES_POLLING_CADENCE.pollMs).toBe(5000);
    });

    it('keeps the 15s throttle while the socket is up', async () => {
      realtimeMock.setConnected(true);
      await expectInterval(detailOptions, DETAIL_MESSAGES_POLLING_CADENCE.wsFallbackMs);
      expect(DETAIL_MESSAGES_POLLING_CADENCE.wsFallbackMs).toBe(15000);
    });
  });

  describe('a tile', () => {
    const tileOptions = {
      worktreeId: 'w-1',
      cliToolId: 'claude' as const,
      cadence: TILE_MESSAGES_POLLING_CADENCE,
    };

    it('polls at 15s while the socket is down', async () => {
      await expectInterval(tileOptions, TILE_MESSAGES_POLLING_CADENCE.pollMs);
    });

    it('polls at 30s while the socket is up', async () => {
      realtimeMock.setConnected(true);
      await expectInterval(tileOptions, TILE_MESSAGES_POLLING_CADENCE.wsFallbackMs);
    });
  });
});
