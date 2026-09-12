/**
 * The recovery edge, driven through the real hook composition (Issue #2535).
 *
 * #2503's own tests feed `usePendingMessages` a hand-built `PendingConnectivity`
 * and its composer test replaces `useConnectivity` with a store it flips by
 * hand. Both stayed green while the phone in the acceptance test never resent
 * anything, because neither of them ever ran the *composition*: the real
 * `useConnectivity` folding `navigator.onLine`, the WebSocket status and the
 * reachability reports into signals, the two evidence helpers reading those
 * signals, and `usePendingMessages` acting on the result.
 *
 * That gap is the subject here. Everything below drives the browser-level facts
 * a device actually produces — the `offline`/`online` events and the socket
 * status — and asserts on `sendFn`, i.e. on whether `POST /send` would go out.
 *
 * Two properties the old wiring got wrong and that these tests pin:
 *
 *  1. **Offline has to be visible as "not confirmed reachable".** A session that
 *     was healthy leaves `serverReachable: true` behind, and nothing clears it
 *     while the device is off the network: the probe is gated on `browserOnline`
 *     and `api-client` refuses the request before it is made (`assertOnline`)
 *     without reporting anything. So the stale `true` survived the whole outage
 *     and `isServerConfirmedReachable` kept answering `true` — the hook was told
 *     the server was answering at the very moment it was parking messages
 *     because it was not.
 *  2. **The rising edge must not depend on catching a render.** Returning online
 *     raises the `online` event and reconnects the socket within a few ms, and
 *     React coalesces state updates that land in one batch — so a design that
 *     arms itself only by *observing* a committed `reachable === false` render
 *     can miss the transition entirely. Every recovery here applies both facts
 *     inside a single `act()`, which is the coalescing the browser produces.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RealtimeStatus } from '@/lib/realtime/types';
import type { ChatMessage } from '@/types/models';

// ---------------------------------------------------------------------------
// The one thing mocked: the WebSocket transport.
// ---------------------------------------------------------------------------

/**
 * Reactive so a status change re-renders every consumer, exactly as the real
 * provider's state does. A plain mutable object would let the composition pass
 * by never re-reading the socket.
 */
const realtime = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    status: 'connected' as RealtimeStatus,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: RealtimeStatus) {
      this.status = next;
      listeners.forEach((listener) => listener());
    },
  };
});

vi.mock('@/hooks/useRealtimeConnection', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useRealtime: () => {
      const status = useSyncExternalStore(
        (listener: () => void) => realtime.subscribe(listener),
        () => realtime.status,
        () => realtime.status,
      );
      return {
        status,
        connected: status === 'connected',
        subscribe: () => {},
        unsubscribe: () => {},
        addListener: () => () => {},
      };
    },
  };
});

import {
  useConnectivity,
  isServerConfirmedReachable,
  isConnectionKnownDown,
} from '@/hooks/useConnectivity';
import {
  usePendingMessages,
  type PendingConnectivity,
  type SendFn,
} from '@/hooks/usePendingMessages';

// ---------------------------------------------------------------------------
// Browser-level drivers
// ---------------------------------------------------------------------------

/** jsdom exposes `navigator.onLine` as a non-writable getter. */
function setBrowserOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

/**
 * Lose the network the way a device does: the flag flips, the `offline` event
 * fires, and the socket drops. `socket` is a parameter because the two real
 * shapes differ and both have to work — a phone losing its carrier tears the
 * socket down, while a laptop losing Wi-Fi with the server on loopback keeps it
 * wide open and only the flag moves.
 */
function goOffline(socket: RealtimeStatus | 'keep' = 'disconnected'): void {
  act(() => {
    setBrowserOnline(false);
    if (socket !== 'keep') realtime.set(socket);
    window.dispatchEvent(new Event('offline'));
  });
}

/**
 * Come back the way a device does, and — the point of this file — in ONE act(),
 * so the `online` event and the socket's reconnection are coalesced into a
 * single React batch with no committed render in between. That is what the
 * browser produces (the acceptance test measured the socket back 5ms after the
 * event) and what a design that waits to *see* `reachable === false` misses.
 */
function goOnline(): void {
  act(() => {
    setBrowserOnline(true);
    realtime.set('connected');
    window.dispatchEvent(new Event('online'));
  });
}

// ---------------------------------------------------------------------------
// The composition under test
// ---------------------------------------------------------------------------

const GRACE_MS = 5;

/** Let the send, the recovery refetch and its settle window all land. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 10));
  });
}

/**
 * The exact three lines `TerminalSplitPaneContent` and `MobileTerminalTab` both
 * carry. Written out rather than imported so this file pins the *shape* of the
 * wiring: if a surface ever stops deriving its two booleans this way, the
 * disagreement shows up here rather than on a phone.
 */
function useComposedPending(
  serverMessages: ChatMessage[],
  sendFn: SendFn,
  onSent?: () => void | Promise<void>,
) {
  const connectivity = useConnectivity({ probe: false });
  const pendingConnectivity = React.useMemo(
    () => ({
      offline: isConnectionKnownDown(connectivity.signals),
      reachable: isServerConfirmedReachable(connectivity.signals),
    }),
    [connectivity.signals],
  );
  const pending = usePendingMessages({
    worktreeId: 'w1',
    serverMessages,
    sendFn,
    onSent,
    connectivity: pendingConnectivity,
    resendGraceMs: GRACE_MS,
  });
  return { ...pending, pendingConnectivity };
}

function renderComposed(sendFn: SendFn, onSent?: () => void | Promise<void>) {
  return renderHook(
    ({ serverMessages }: { serverMessages: ChatMessage[] }) =>
      useComposedPending(serverMessages, sendFn, onSent),
    { initialProps: { serverMessages: [] as ChatMessage[] } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setBrowserOnline(true);
  realtime.status = 'connected';
});

afterEach(() => {
  setBrowserOnline(true);
  realtime.status = 'connected';
});

// ---------------------------------------------------------------------------
// The signals themselves
// ---------------------------------------------------------------------------

describe('useConnectivity — the verdict a real outage produces (Issue #2535)', () => {
  it('stops confirming reachability the moment the device leaves the network', () => {
    const { result } = renderHook(() => useConnectivity({ probe: false }));

    // A healthy session first, so `serverReachable` is genuinely `true` and the
    // staleness under test has something to be stale about.
    expect(isServerConfirmedReachable(result.current.signals)).toBe(true);

    goOffline();

    // The regression: this used to stay `true` for the whole outage, because
    // nothing clears a reachability measured before the network went away.
    expect(isConnectionKnownDown(result.current.signals)).toBe(true);
    expect(isServerConfirmedReachable(result.current.signals)).toBe(false);
  });

  it('drops a reachability measured against the network that just went away', () => {
    const { result } = renderHook(() => useConnectivity({ probe: false }));
    expect(result.current.signals.serverReachable).toBe(true);

    goOffline();

    // Not `false` — nothing measured the new situation, and claiming a
    // measurement that was never taken is the mistake in the other direction.
    // `null` is "unmeasured", which is what it actually is. The guard in
    // `isServerConfirmedReachable` covers the same ground from the reading end;
    // this is the stale value being cleared at its source, so a later reader
    // that asks `signals.serverReachable` directly is not handed a lie.
    expect(result.current.signals.serverReachable).toBeNull();
  });

  it('stops confirming reachability even when the socket never notices', () => {
    // Server on loopback: Wi-Fi drops, `navigator.onLine` flips, and the
    // WebSocket to 127.0.0.1 stays up because loopback never went anywhere.
    const { result } = renderHook(() => useConnectivity({ probe: false }));

    goOffline('keep');

    expect(result.current.signals.realtimeStatus).toBe('connected');
    expect(isServerConfirmedReachable(result.current.signals)).toBe(false);
  });

  it('never reports a connection as both down and confirmed reachable', () => {
    const { result } = renderHook(() => useConnectivity({ probe: false }));
    const seen: Array<{ down: boolean; up: boolean }> = [];
    const record = () =>
      seen.push({
        down: isConnectionKnownDown(result.current.signals),
        up: isServerConfirmedReachable(result.current.signals),
      });

    record();
    goOffline();
    record();
    goOnline();
    record();

    for (const s of seen) expect(s.down && s.up).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

describe('offline send → online resend, through the real composition (Issue #2535)', () => {
  it('resends exactly once when the network comes back', async () => {
    const sendFn = vi.fn<SendFn>().mockRejectedValue(new Error('offline'));
    const onSent = vi.fn(() => Promise.resolve());
    const { result } = renderComposed(sendFn, onSent);

    goOffline();

    await act(async () => {
      result.current.sendOptimistic('圏外から送った', { cliToolId: 'claude' });
    });
    await flush();

    // Parked, not failed — and no second attempt while there is no network.
    expect(result.current.pending[0].queued).toBe(true);
    expect(result.current.messages[0].optimisticState).toBe('sending');
    expect(sendFn).toHaveBeenCalledTimes(1);

    // Back online: one automatic resend, and only one.
    sendFn.mockResolvedValue(undefined);
    goOnline();
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenLastCalledWith('圏外から送った', { cliToolId: 'claude' });
  });

  it('resends when the socket never dropped and only the device flag moved', async () => {
    const sendFn = vi.fn<SendFn>().mockRejectedValue(new Error('offline'));
    const { result } = renderComposed(sendFn, vi.fn(() => Promise.resolve()));

    goOffline('keep');

    await act(async () => {
      result.current.sendOptimistic('ループバック', { cliToolId: 'claude' });
    });
    await flush();
    expect(result.current.pending[0].queued).toBe(true);

    sendFn.mockResolvedValue(undefined);
    goOnline();
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it('does not resend a message the refetch shows the server already has', async () => {
    const sendFn = vi.fn<SendFn>().mockRejectedValue(new Error('offline'));
    const { result, rerender } = renderComposed(sendFn, () => {
      // The refetch the recovery pass awaits: the transcript comes back with
      // the message in it, so there is nothing left to send.
      rerender({
        serverMessages: [
          {
            id: 's1',
            worktreeId: 'w1',
            role: 'user',
            content: '届いていた',
            timestamp: new Date(1),
            messageType: 'normal',
            archived: false,
          },
        ],
      });
      return Promise.resolve();
    });

    goOffline();
    await act(async () => {
      result.current.sendOptimistic('届いていた', { cliToolId: 'claude' });
    });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(1);

    goOnline();
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toHaveLength(0);
  });

  it('surfaces an error the user can act on when the resend also fails', async () => {
    const sendFn = vi.fn<SendFn>().mockRejectedValue(new Error('still broken'));
    const { result } = renderComposed(sendFn, vi.fn(() => Promise.resolve()));

    goOffline();
    await act(async () => {
      result.current.sendOptimistic('二度目も落ちる', { cliToolId: 'claude' });
    });
    await flush();

    goOnline();
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(result.current.pending[0].status).toBe('error');
    expect(result.current.pending[0].queued).toBe(false);

    // …and the manual affordances still work from there.
    sendFn.mockResolvedValue(undefined);
    await act(async () => {
      result.current.retry(result.current.pending[0].tempId);
    });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(3);
  });

  it('does not resend on a reconnection with nothing waiting', async () => {
    const sendFn = vi.fn<SendFn>().mockResolvedValue(undefined);
    const onSent = vi.fn(() => Promise.resolve());
    renderComposed(sendFn, onSent);

    goOffline();
    goOnline();
    await flush();

    expect(sendFn).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it('survives a flapping connection without duplicating the send', async () => {
    const sendFn = vi.fn<SendFn>().mockRejectedValue(new Error('offline'));
    const { result } = renderComposed(sendFn, vi.fn(() => Promise.resolve()));

    goOffline();
    await act(async () => {
      result.current.sendOptimistic('不安定な回線', { cliToolId: 'claude' });
    });
    await flush();

    sendFn.mockResolvedValue(undefined);
    goOnline();
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);

    // Two more round trips: the budget is spent, so nothing else goes out on
    // its own — the message is the server's problem now, or the user's.
    goOffline();
    goOnline();
    await flush();
    goOffline();
    goOnline();
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The edge itself, at the hook's own boundary
// ---------------------------------------------------------------------------

/**
 * The composition above can no longer produce a message that is parked while
 * the connection reads as reachable — the two evidence helpers are now mutually
 * exclusive, which is half of this fix. The hook's boundary is wider than that:
 * `offline` and `reachable` arrive as two independent booleans, and the
 * contradictory pair is exactly what the broken wiring handed it.
 *
 * What is pinned here is that the hook does not *depend* on the composition
 * getting it right. A parked message is a standing debt, and it is discharged
 * on the evidence available rather than on having witnessed a transition.
 */
describe('usePendingMessages — recovery is owed by the queue, not by a transition (Issue #2535)', () => {
  function renderHookOnly(sendFn: SendFn, connectivity: PendingConnectivity) {
    return renderHook(
      ({ c }: { c: PendingConnectivity }) =>
        usePendingMessages({
          worktreeId: 'w1',
          serverMessages: [],
          sendFn,
          onSent: () => Promise.resolve(),
          connectivity: c,
          resendGraceMs: GRACE_MS,
        }),
      { initialProps: { c: connectivity } },
    );
  }

  it('resends a message parked while the verdict already read as reachable', async () => {
    // The contradictory pair the old wiring produced for the whole of an
    // outage: measured down *and* confirmed reachable at the same time. With
    // recovery armed only by watching `reachable` fall, nothing here is ever
    // owed and the message waits forever.
    const sendFn = vi.fn<SendFn>().mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHookOnly(sendFn, { offline: true, reachable: true });

    await act(async () => {
      result.current.sendOptimistic('矛盾した判定の下で', { cliToolId: 'claude' });
    });
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it('still spends only one automatic attempt on it', async () => {
    const sendFn = vi.fn<SendFn>().mockRejectedValue(new Error('offline'));
    const { result, rerender } = renderHookOnly(sendFn, { offline: true, reachable: true });

    await act(async () => {
      result.current.sendOptimistic('一度きり', { cliToolId: 'claude' });
    });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);

    // Further churn on both inputs must not buy a third attempt.
    rerender({ c: { offline: false, reachable: false } });
    await flush();
    rerender({ c: { offline: false, reachable: true } });
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(result.current.pending[0].status).toBe('error');
  });

  it('does not start a recovery round when nothing is queued', async () => {
    const sendFn = vi.fn<SendFn>().mockResolvedValue(undefined);
    const onSent = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(
      ({ c }: { c: PendingConnectivity }) =>
        usePendingMessages({
          worktreeId: 'w1',
          serverMessages: [],
          sendFn,
          onSent,
          connectivity: c,
          resendGraceMs: GRACE_MS,
        }),
      { initialProps: { c: { offline: false, reachable: false } as PendingConnectivity } },
    );

    rerender({ c: { offline: false, reachable: true } });
    await flush();

    expect(onSent).not.toHaveBeenCalled();
    expect(sendFn).not.toHaveBeenCalled();
  });
});
