/**
 * Unit tests for the redesigned useWebSocket hook (Issue #1120).
 * Covers connect/status, subscription resend on reconnect, exponential backoff,
 * and event dispatch.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket, computeBackoffDelay } from '@/hooks/useWebSocket';
import { MockWebSocket, installMockWebSocket } from '@tests/helpers/mock-websocket';

describe('computeBackoffDelay', () => {
  it('grows exponentially and clamps to the max', () => {
    expect(computeBackoffDelay(0, 1000, 30000)).toBe(1000);
    expect(computeBackoffDelay(1, 1000, 30000)).toBe(2000);
    expect(computeBackoffDelay(2, 1000, 30000)).toBe(4000);
    expect(computeBackoffDelay(3, 1000, 30000)).toBe(8000);
    expect(computeBackoffDelay(20, 1000, 30000)).toBe(30000);
  });
});

describe('useWebSocket', () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installMockWebSocket();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstall();
  });

  it('connects on mount and reports connected on open', () => {
    const onStatusChange = vi.fn();
    const { result } = renderHook(() => useWebSocket({ onStatusChange }));

    expect(result.current.status).toBe('connecting');
    const ws = MockWebSocket.last();
    act(() => ws.mockOpen());
    expect(result.current.status).toBe('connected');
    expect(onStatusChange).toHaveBeenCalledWith('connected');
  });

  it('sends subscribe frames and resends them on reconnect', () => {
    const { result } = renderHook(() => useWebSocket({ reconnectBaseDelay: 1000 }));
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());

    act(() => result.current.subscribe('wt-1'));
    expect(ws1.sent).toContain(JSON.stringify({ type: 'subscribe', worktreeId: 'wt-1' }));

    // Unexpected drop → status disconnected, reconnect scheduled.
    act(() => ws1.mockServerClose());
    expect(result.current.status).toBe('disconnected');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const ws2 = MockWebSocket.last();
    expect(ws2).not.toBe(ws1);
    act(() => ws2.mockOpen());

    // The subscription set is replayed on the fresh socket.
    expect(ws2.sent).toContain(JSON.stringify({ type: 'subscribe', worktreeId: 'wt-1' }));
  });

  it('reconnects with exponential backoff', () => {
    renderHook(() => useWebSocket({ reconnectBaseDelay: 1000, reconnectMaxDelay: 30000 }));
    const ws1 = MockWebSocket.last();

    // First drop → reconnect after 1000ms.
    act(() => ws1.mockServerClose());
    act(() => vi.advanceTimersByTime(999));
    expect(MockWebSocket.instances.length).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances.length).toBe(2);

    // Second drop (without an intervening open) → reconnect after 2000ms.
    const ws2 = MockWebSocket.last();
    act(() => ws2.mockServerClose());
    act(() => vi.advanceTimersByTime(1999));
    expect(MockWebSocket.instances.length).toBe(2);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances.length).toBe(3);
  });

  it('resets backoff after a successful open', () => {
    renderHook(() => useWebSocket({ reconnectBaseDelay: 1000 }));
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockServerClose());
    act(() => vi.advanceTimersByTime(1000));
    const ws2 = MockWebSocket.last();
    act(() => ws2.mockOpen()); // resets attempt counter
    act(() => ws2.mockServerClose());
    // Back to base delay (1000ms), not 2000ms.
    act(() => vi.advanceTimersByTime(1000));
    expect(MockWebSocket.instances.length).toBe(3);
  });

  it('dispatches parsed broadcast events to onEvent', () => {
    const onEvent = vi.fn();
    renderHook(() => useWebSocket({ onEvent }));
    const ws = MockWebSocket.last();
    act(() => ws.mockOpen());

    act(() =>
      ws.mockMessage(
        JSON.stringify({
          type: 'broadcast',
          worktreeId: 'wt-1',
          data: { type: 'session_status_changed', worktreeId: 'wt-1', isRunning: true },
        }),
      ),
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_status_changed', worktreeId: 'wt-1', isRunning: true }),
    );
  });

  it('ignores malformed frames without dispatching', () => {
    const onEvent = vi.fn();
    renderHook(() => useWebSocket({ onEvent }));
    const ws = MockWebSocket.last();
    act(() => ws.mockOpen());
    act(() => ws.mockMessage('not-json{'));
    expect(onEvent).not.toHaveBeenCalled();
  });
});
