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
  /** 0.5 sits at the middle of the jitter window, i.e. no jitter at all. */
  const noJitter = () => 0.5;

  it('grows exponentially and clamps to the max', () => {
    expect(computeBackoffDelay(0, 1000, 30000, noJitter)).toBe(1000);
    expect(computeBackoffDelay(1, 1000, 30000, noJitter)).toBe(2000);
    expect(computeBackoffDelay(2, 1000, 30000, noJitter)).toBe(4000);
    expect(computeBackoffDelay(3, 1000, 30000, noJitter)).toBe(8000);
    expect(computeBackoffDelay(20, 1000, 30000, noJitter)).toBe(30000);
  });

  it('spreads each delay across a +/-20% window (#2502)', () => {
    // The extremes of the window, which is where a sign error or a ratio typo
    // shows up: the herd this exists to break is a server restart handing every
    // tab the same close event in the same millisecond.
    expect(computeBackoffDelay(2, 1000, 30000, () => 0)).toBe(3200);
    expect(computeBackoffDelay(2, 1000, 30000, () => 1)).toBe(4800);
    // Jitter applies to the CLAMPED value, so the ceiling is still the ceiling
    // in expectation rather than something 2**20 can push past.
    expect(computeBackoffDelay(20, 1000, 30000, () => 1)).toBe(36000);
  });

  it('never returns a negative delay', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      expect(computeBackoffDelay(0, 1000, 30000, () => r)).toBeGreaterThanOrEqual(0);
    }
  });

  it('defaults to Math.random, so production delays are actually jittered', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(computeBackoffDelay(0, 1000, 30000)).toBe(800);
      expect(randomSpy).toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
    }
  });
});

describe('useWebSocket', () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installMockWebSocket();
    vi.useFakeTimers();
    // Issue #2502: the backoff is jittered in production. Pin the middle of the
    // window here so the timing assertions below can stay exact — the jitter
    // itself is covered by the `computeBackoffDelay` cases above.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('announces the client bundle version on every (re)connect (#1338/#1356)', () => {
    const { result } = renderHook(() => useWebSocket({ reconnectBaseDelay: 1000 }));
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());

    const helloOf = (ws: MockWebSocket) =>
      ws.sent.map((f) => JSON.parse(f)).find((m) => m.type === 'client_version');
    expect(helloOf(ws1)).toMatchObject({ type: 'client_version' });
    expect(typeof helloOf(ws1)?.version).toBe('string');

    // Drop + reconnect: the hello must be re-sent on the fresh socket, since a
    // reconnect right after a server swap is exactly when detection matters.
    act(() => ws1.mockServerClose());
    act(() => vi.advanceTimersByTime(1000));
    const ws2 = MockWebSocket.last();
    expect(ws2).not.toBe(ws1);
    act(() => ws2.mockOpen());
    expect(helloOf(ws2)).toMatchObject({ type: 'client_version' });
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
