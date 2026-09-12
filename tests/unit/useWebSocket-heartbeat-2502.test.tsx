/**
 * Half-open detection, jittered reconnect and `online` recovery (Issue #2502).
 *
 * The bug these cover is the one no `onclose` ever reports. When a phone walks
 * out of range, a laptop resumes from sleep, or Wi-Fi hands over to LTE, the TCP
 * connection is not closed — it is simply gone. Nothing is written, so no RST
 * comes back; `readyState` answers OPEN forever and `status` stays `connected`
 * while every frame in both directions falls on the floor. The terminal pane had
 * its own rescue (`useTerminalPanePolling`'s push-staleness check), but the
 * sidebar, the history pane and the version-mismatch banner all key off
 * `status` and sat on the slow polling interval trusting a lie.
 *
 * So the assertions here are about *silence*: the hook must reach
 * `disconnected` with no close event, no error event and no server involvement
 * whatsoever, purely because nothing arrived for long enough.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { MockWebSocket, installMockWebSocket } from '@tests/helpers/mock-websocket';
import {
  WS_HALF_OPEN_CLOSE_CODE,
  WS_HEARTBEAT_MESSAGE_TYPE,
} from '@/config/websocket-config';

/** Short, round numbers so the arithmetic in each case is readable. */
const LIVENESS_TIMEOUT = 30_000;
const LIVENESS_CHECK = 5_000;
const BASE_DELAY = 1_000;

const heartbeatFrame = () => JSON.stringify({ type: WS_HEARTBEAT_MESSAGE_TYPE, at: Date.now() });

describe('useWebSocket half-open detection (#2502)', () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installMockWebSocket();
    vi.useFakeTimers();
    // Pin the middle of the jitter window so reconnect delays stay exact.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    uninstall();
  });

  const mount = () =>
    renderHook(() =>
      useWebSocket({
        reconnectBaseDelay: BASE_DELAY,
        livenessTimeout: LIVENESS_TIMEOUT,
        livenessCheckInterval: LIVENESS_CHECK,
      }),
    );

  it('drops status to disconnected when nothing arrives for the timeout', () => {
    const onStatusChange = vi.fn();
    const { result } = renderHook(() =>
      useWebSocket({
        onStatusChange,
        reconnectBaseDelay: BASE_DELAY,
        livenessTimeout: LIVENESS_TIMEOUT,
        livenessCheckInterval: LIVENESS_CHECK,
      }),
    );
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());
    expect(result.current.status).toBe('connected');

    // Just short of the timeout the socket is still trusted — a quiet
    // connection is normal, and a needless teardown costs a real reconnect.
    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT - LIVENESS_CHECK));
    expect(result.current.status).toBe('connected');

    // The next check crosses it. No close event, no error event: the hook
    // concluded this on its own.
    act(() => vi.advanceTimersByTime(LIVENESS_CHECK));
    expect(result.current.status).toBe('disconnected');
    expect(onStatusChange).toHaveBeenLastCalledWith('disconnected');
  });

  it('releases the abandoned socket with the half-open close code', () => {
    mount();
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());
    const closeSpy = vi.spyOn(ws1, 'close');

    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT));

    // A distinct code (not a plain 1000 goodbye) so a server-side close log can
    // tell "the tab gave up on this path" apart from an ordinary disconnect.
    expect(closeSpy).toHaveBeenCalledWith(WS_HALF_OPEN_CLOSE_CODE, expect.any(String));
    expect(ws1.closed).toBe(true);
  });

  it('reconnects on the normal backoff after declaring the socket dead', () => {
    mount();
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());
    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT));
    expect(MockWebSocket.instances.length).toBe(1);

    act(() => vi.advanceTimersByTime(BASE_DELAY));
    expect(MockWebSocket.instances.length).toBe(2);
    expect(MockWebSocket.last()).not.toBe(ws1);
  });

  it('replays the subscription set onto the socket that replaces it', () => {
    const { result } = mount();
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());
    act(() => result.current.subscribe('wt-1'));

    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT));
    act(() => vi.advanceTimersByTime(BASE_DELAY));
    const ws2 = MockWebSocket.last();
    act(() => ws2.mockOpen());

    expect(ws2.sent).toContain(JSON.stringify({ type: 'subscribe', worktreeId: 'wt-1' }));
  });

  it('keeps a quiet-but-beating connection alive indefinitely', () => {
    const { result } = mount();
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());

    // Four timeouts' worth of wall clock with nothing but the server beat.
    for (let i = 0; i < 4; i += 1) {
      act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT - LIVENESS_CHECK));
      act(() => ws1.mockMessage(heartbeatFrame()));
    }

    expect(result.current.status).toBe('connected');
    expect(MockWebSocket.instances.length).toBe(1);
    expect(ws1.closed).toBe(false);
  });

  it('accepts ordinary traffic as proof of life, not just the beat', () => {
    const { result } = mount();
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());

    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT - LIVENESS_CHECK));
    act(() =>
      ws1.mockMessage(
        JSON.stringify({
          type: 'broadcast',
          worktreeId: 'wt-1',
          data: { type: 'session_status_changed', worktreeId: 'wt-1', isRunning: true },
        }),
      ),
    );
    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT - LIVENESS_CHECK));

    expect(result.current.status).toBe('connected');
  });

  it('counts an unparseable frame as proof of life too', () => {
    // A frame this bundle cannot read still proves the path carries bytes,
    // which is the only question being asked. Killing the socket over a
    // vocabulary mismatch would be the worst possible reading of the evidence.
    const { result } = mount();
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());

    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT - LIVENESS_CHECK));
    act(() => ws1.mockMessage('not-json{'));
    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT - LIVENESS_CHECK));

    expect(result.current.status).toBe('connected');
  });

  it('does not forward the beat to event listeners', () => {
    const onEvent = vi.fn();
    renderHook(() =>
      useWebSocket({
        onEvent,
        livenessTimeout: LIVENESS_TIMEOUT,
        livenessCheckInterval: LIVENESS_CHECK,
      }),
    );
    const ws = MockWebSocket.last();
    act(() => ws.mockOpen());

    act(() => ws.mockMessage(heartbeatFrame()));
    expect(onEvent).not.toHaveBeenCalled();

    // ...and the fan-out still works for everything else.
    act(() =>
      ws.mockMessage(
        JSON.stringify({
          type: 'broadcast',
          worktreeId: 'wt-1',
          data: { type: 'session_status_changed', worktreeId: 'wt-1', isRunning: true },
        }),
      ),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('never opens a second socket for the same tab when the dead one finally closes', () => {
    // A real `close()` on a dead path cannot complete its handshake, so the
    // browser fires `onclose` only when the OS TCP timeout expires — long after
    // the replacement socket is up. If that late event still reached the hook's
    // handler it would schedule a reconnect for a connection nobody is waiting
    // on, and the tab would end up with two.
    mount();
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());
    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT));
    act(() => vi.advanceTimersByTime(BASE_DELAY));
    const ws2 = MockWebSocket.last();
    act(() => ws2.mockOpen());
    expect(MockWebSocket.instances.length).toBe(2);

    act(() => ws1.mockServerClose());
    // Well past any backoff the stale event could have armed, and short of the
    // replacement's own liveness deadline so nothing else can muddy the count.
    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT - LIVENESS_CHECK));

    expect(MockWebSocket.instances.length).toBe(2);
    expect(MockWebSocket.last()).toBe(ws2);
  });

  it('stops checking after unmount', () => {
    const { unmount } = mount();
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());
    unmount();

    act(() => vi.advanceTimersByTime(LIVENESS_TIMEOUT * 4));
    expect(MockWebSocket.instances.length).toBe(1);
  });
});

describe('useWebSocket online recovery (#2502)', () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installMockWebSocket();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    uninstall();
  });

  it('reconnects the moment the radio comes back, not when the backoff is due', () => {
    renderHook(() => useWebSocket({ reconnectBaseDelay: BASE_DELAY, reconnectMaxDelay: 30_000 }));

    // Three failed attempts without an intervening open push the next delay out
    // to 8s — the shape of a phone in a lift or a laptop that slept.
    let attempts = 0;
    for (const delay of [BASE_DELAY, BASE_DELAY * 2, BASE_DELAY * 4]) {
      act(() => MockWebSocket.last().mockServerClose());
      act(() => vi.advanceTimersByTime(delay));
      attempts += 1;
    }
    expect(MockWebSocket.instances.length).toBe(attempts + 1);
    act(() => MockWebSocket.last().mockServerClose());

    // 8s pending. `online` must not wait it out.
    act(() => vi.advanceTimersByTime(100));
    expect(MockWebSocket.instances.length).toBe(attempts + 1);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(MockWebSocket.instances.length).toBe(attempts + 2);
  });

  it('cancels the pending backoff rather than racing it', () => {
    renderHook(() => useWebSocket({ reconnectBaseDelay: BASE_DELAY }));
    act(() => MockWebSocket.last().mockServerClose());

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(MockWebSocket.instances.length).toBe(2);

    // The timer that was already armed must not open a third socket behind it.
    act(() => vi.advanceTimersByTime(BASE_DELAY * 4));
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('resets the backoff so the next drop starts from the base delay again', () => {
    renderHook(() => useWebSocket({ reconnectBaseDelay: BASE_DELAY }));
    act(() => MockWebSocket.last().mockServerClose());
    act(() => vi.advanceTimersByTime(BASE_DELAY));
    act(() => MockWebSocket.last().mockServerClose());

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    const count = MockWebSocket.instances.length;

    // Reconnected without ever opening, so only the `online` reset can have
    // brought the attempt counter back to 0.
    act(() => MockWebSocket.last().mockServerClose());
    act(() => vi.advanceTimersByTime(BASE_DELAY));
    expect(MockWebSocket.instances.length).toBe(count + 1);
  });

  it('ignores online while a socket is already up', () => {
    renderHook(() => useWebSocket({ reconnectBaseDelay: BASE_DELAY }));
    const ws1 = MockWebSocket.last();
    act(() => ws1.mockOpen());

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(MockWebSocket.instances.length).toBe(1);
    expect(ws1.closed).toBe(false);
  });

  it('stops listening after unmount', () => {
    const { unmount } = renderHook(() => useWebSocket({ reconnectBaseDelay: BASE_DELAY }));
    act(() => MockWebSocket.last().mockServerClose());
    unmount();

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(MockWebSocket.instances.length).toBe(1);
  });
});
