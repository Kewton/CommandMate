/**
 * Integration test for the WS ↔ polling fallback switch (Issue #1120).
 *
 * Acceptance criterion: while the WebSocket push connection is up, the terminal
 * output poll is throttled to a slow fallback cadence; on disconnect the fast
 * poll resumes automatically; on reconnect it throttles again.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { RealtimeProvider } from '@/hooks/useRealtimeConnection';
import {
  useTerminalPanePolling,
  ACTIVE_POLLING_INTERVAL_MS,
  IDLE_POLLING_INTERVAL_MS,
  WS_CONNECTED_POLLING_INTERVAL_MS,
} from '@/hooks/useTerminalPanePolling';
import { MockWebSocket, installMockWebSocket } from '@tests/helpers/mock-websocket';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RealtimeProvider>{children}</RealtimeProvider>
);

describe('WS ↔ polling fallback (Issue #1120)', () => {
  let uninstall: () => void;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    uninstall = installMockWebSocket();
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        isRunning: false,
        cliToolId: 'claude',
        sessionStatus: 'idle',
        sessionStatusReason: 'session_not_running',
        content: '',
        lineCount: 0,
      }),
    }));
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstall();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('throttles polling while connected and restores it on disconnect/reconnect', async () => {
    renderHook(
      () => useTerminalPanePolling({ worktreeId: 'wt-1', cliToolId: 'claude' }),
      { wrapper },
    );

    // Let the initial mount kick settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const ws = MockWebSocket.last();

    // --- Disconnected: fast fallback poll (IDLE = 5s since isRunning=false). ---
    let before = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_POLLING_INTERVAL_MS);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);

    // --- Connect: cadence throttled to the slow WS fallback interval. ---
    await act(async () => {
      ws.mockOpen();
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterConnect = fetchMock.mock.calls.length; // includes the effect re-run kick
    // Below the throttled interval → no new poll while connected.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_POLLING_INTERVAL_MS);
    });
    expect(fetchMock.mock.calls.length).toBe(afterConnect);
    // Reaching the throttled interval → exactly one poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WS_CONNECTED_POLLING_INTERVAL_MS - IDLE_POLLING_INTERVAL_MS);
    });
    expect(fetchMock.mock.calls.length).toBe(afterConnect + 1);

    // --- Disconnect: fast polling resumes (fallback). ---
    await act(async () => {
      ws.mockServerClose();
      await vi.advanceTimersByTimeAsync(0);
    });
    before = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_POLLING_INTERVAL_MS);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);

    // --- Reconnect: throttled again. ---
    // The reconnect timer (base 1s backoff) fires during the advance above; open it.
    const ws2 = MockWebSocket.last();
    expect(ws2).not.toBe(ws);
    await act(async () => {
      ws2.mockOpen();
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterReconnect = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_POLLING_INTERVAL_MS);
    });
    expect(fetchMock.mock.calls.length).toBe(afterReconnect);
  });

  it('sanity: the throttled interval is larger than the active poll interval', () => {
    expect(WS_CONNECTED_POLLING_INTERVAL_MS).toBeGreaterThan(ACTIVE_POLLING_INTERVAL_MS);
    expect(WS_CONNECTED_POLLING_INTERVAL_MS).toBeGreaterThan(IDLE_POLLING_INTERVAL_MS);
  });
});
