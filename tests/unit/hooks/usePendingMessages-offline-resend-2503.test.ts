/**
 * Tests for the connectivity layer of usePendingMessages (Issue #2503).
 *
 * The property under test is the difference between "this message failed" and
 * "this message has not been sent yet". Everything here is driven through the
 * hook's `connectivity` input rather than through `navigator.onLine`, because
 * that is the contract #2501 established: the verdict is computed elsewhere and
 * `onLine === true` is never on its own proof of being back.
 *
 * The duplicate-send guards get the most attention, since `POST /send` has no
 * dedupe key — a resend that should not have happened puts a second prompt into
 * a live agent session.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  usePendingMessages,
  type PendingConnectivity,
  type SendFn,
} from '@/hooks/usePendingMessages';
import type { ChatMessage } from '@/types/models';

const OFFLINE: PendingConnectivity = { offline: true, reachable: false };
const ONLINE: PendingConnectivity = { offline: false, reachable: true };
/** The device claims a network but nothing has answered yet (captive portal). */
const UNCONFIRMED: PendingConnectivity = { offline: false, reachable: false };

function serverUserMessage(content: string, id: string, timeMs: number): ChatMessage {
  return {
    id,
    worktreeId: 'w1',
    role: 'user',
    content,
    timestamp: new Date(timeMs),
    messageType: 'normal',
    archived: false,
  };
}

/**
 * The recovery pass deliberately waits a settle window after its refetch before
 * deciding anything (DEFAULT_RESEND_GRACE_MS), so the harness runs that window
 * at 5ms and every flush spans a real task rather than only the microtask queue.
 */
const GRACE_MS = 5;

/** Let the fire-and-forget send, the recovery refetch and its settle window run. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 5));
  });
}

interface HarnessProps {
  serverMessages: ChatMessage[];
  connectivity: PendingConnectivity;
}

function renderPending(
  sendFn: SendFn,
  initial: Partial<HarnessProps> = {},
  onSent?: () => void | Promise<void>,
) {
  return renderHook(
    ({ serverMessages, connectivity }: HarnessProps) =>
      usePendingMessages({
        worktreeId: 'w1',
        serverMessages,
        sendFn,
        onSent,
        connectivity,
        resendGraceMs: GRACE_MS,
      }),
    {
      initialProps: {
        serverMessages: initial.serverMessages ?? [],
        connectivity: initial.connectivity ?? ONLINE,
      },
    },
  );
}

describe('usePendingMessages — offline queueing (Issue #2503)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parks a send that fails while offline as waiting, not failed', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderPending(sendFn, { connectivity: OFFLINE });

    act(() => {
      result.current.sendOptimistic('圏外から', { cliToolId: 'claude' });
    });
    await flush();

    expect(result.current.pending).toHaveLength(1);
    expect(result.current.pending[0].queued).toBe(true);
    // 'sending' is what the bubble draws as in-flight — deliberately NOT 'error'.
    expect(result.current.messages[0].optimisticState).toBe('sending');
  });

  it('still fails a send that rejects while the connection is up', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('500'));
    const { result } = renderPending(sendFn, { connectivity: ONLINE });

    act(() => {
      result.current.sendOptimistic('oops', { cliToolId: 'claude' });
    });
    await flush();

    expect(result.current.messages[0].optimisticState).toBe('error');
    expect(result.current.pending[0].queued).toBe(false);
  });

  it('does not let the timeout expire while offline', async () => {
    vi.useFakeTimers();
    try {
      // Never settles: the request issued as the signal died.
      const sendFn = vi.fn().mockReturnValue(new Promise<never>(() => {}));
      const { result, rerender } = renderPending(sendFn, {
        connectivity: OFFLINE,
      });

      act(() => {
        result.current.sendOptimistic('tunnel', { cliToolId: 'claude' });
      });

      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(result.current.messages[0].optimisticState).toBe('sending');
      expect(result.current.pending[0].queued).toBe(true);

      // The clock only starts once the server is answering again. The send is
      // still in flight, so this one is a restarted timer, not a resend.
      rerender({ serverMessages: [], connectivity: ONLINE });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        vi.advanceTimersByTime(GRACE_MS);
      });
      expect(result.current.messages[0].optimisticState).toBe('sending');
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(result.current.messages[0].optimisticState).toBe('error');
      expect(sendFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parks an in-flight send the moment the connection drops', async () => {
    const sendFn = vi.fn().mockReturnValue(new Promise<never>(() => {}));
    const { result, rerender } = renderPending(sendFn, { connectivity: ONLINE });

    act(() => {
      result.current.sendOptimistic('mid-flight', { cliToolId: 'claude' });
    });
    expect(result.current.pending[0].queued).toBe(false);

    rerender({ serverMessages: [], connectivity: OFFLINE });
    await flush();

    expect(result.current.pending[0].queued).toBe(true);
    expect(result.current.messages[0].optimisticState).toBe('sending');
  });
});

describe('usePendingMessages — automatic resend on recovery (Issue #2503)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resends a queued message once when the server answers again', async () => {
    const sendFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ success: true });
    const { result, rerender } = renderPending(sendFn, { connectivity: OFFLINE });

    act(() => {
      result.current.sendOptimistic('あとで送る', { cliToolId: 'claude' });
    });
    await flush();
    expect(result.current.pending[0].queued).toBe(true);
    expect(sendFn).toHaveBeenCalledTimes(1);

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenLastCalledWith('あとで送る', { cliToolId: 'claude' });
    expect(result.current.pending[0].queued).toBe(false);
    expect(result.current.messages[0].optimisticState).toBe('sending');

    // …and the echo retires the bubble as an ordinary message.
    rerender({
      serverMessages: [serverUserMessage('あとで送る', 's1', 1000)],
      connectivity: ONLINE,
    });
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('s1');
  });

  it('does not treat "the device says it is online" as the server answering', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('network down'));
    const { result, rerender } = renderPending(sendFn, { connectivity: OFFLINE });

    act(() => {
      result.current.sendOptimistic('hold', { cliToolId: 'claude' });
    });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(1);

    // navigator.onLine flipped back, nothing has answered: #2501 says this is
    // not evidence, and nothing may be sent on it.
    rerender({ serverMessages: [], connectivity: UNCONFIRMED });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result.current.pending[0].queued).toBe(true);
  });

  it('marks the message as error when the automatic resend also fails', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('still broken'));
    const { result, rerender } = renderPending(sendFn, { connectivity: OFFLINE });

    act(() => {
      result.current.sendOptimistic('doomed', { cliToolId: 'claude' });
    });
    await flush();

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(result.current.messages[0].optimisticState).toBe('error');
    expect(result.current.pending[0].queued).toBe(false);

    // Manual retry and discard are back in the user's hands from there.
    const tempId = result.current.pending[0].tempId;
    act(() => {
      result.current.retry(tempId);
    });
    expect(sendFn).toHaveBeenCalledTimes(3);
  });

  it('resends at most once per recovery, even across repeated reconnects', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('down'));
    const { result, rerender } = renderPending(sendFn, { connectivity: OFFLINE });

    act(() => {
      result.current.sendOptimistic('once', { cliToolId: 'claude' });
    });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(1);

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);

    // Flap the connection twice more. The budget is spent, so nothing goes out.
    for (const cycle of [1, 2]) {
      rerender({ serverMessages: [], connectivity: OFFLINE });
      await flush();
      rerender({ serverMessages: [], connectivity: ONLINE });
      await flush();
      expect(sendFn, `cycle ${cycle}`).toHaveBeenCalledTimes(2);
    }
    expect(result.current.messages[0].optimisticState).toBe('error');
  });

  it('spends the budget for good — a resend that dies with the line errors out', async () => {
    // The awkward case the budget exists for: the automatic resend goes out
    // while the server is answering, and the connection dies again before it
    // lands. Parking it a second time would hand recovery another attempt, and
    // a message that reconnects three times would be sent three times.
    let rejectResend: ((error: Error) => void) | undefined;
    const sendFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockReturnValueOnce(
        new Promise<never>((_resolve, reject) => {
          rejectResend = reject;
        }),
      );
    const { result, rerender } = renderPending(sendFn as unknown as SendFn, {
      connectivity: OFFLINE,
    });

    act(() => {
      result.current.sendOptimistic('last chance', { cliToolId: 'claude' });
    });
    await flush();
    expect(result.current.pending[0].queued).toBe(true);

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);

    // The line drops again while the resend is still travelling. A message on
    // its last attempt is NOT parked again.
    rerender({ serverMessages: [], connectivity: OFFLINE });
    await flush();
    expect(result.current.pending[0].queued).toBe(false);

    await act(async () => {
      rejectResend?.(new Error('down again'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.messages[0].optimisticState).toBe('error');

    // And the next reconnection sends nothing — it is the user's call now.
    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it('gives an explicit retry its own automatic-resend budget', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('down'));
    const { result, rerender } = renderPending(sendFn, { connectivity: OFFLINE });

    act(() => {
      result.current.sendOptimistic('again', { cliToolId: 'claude' });
    });
    await flush();
    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);

    // The user presses 再試行 while the connection is down again…
    rerender({ serverMessages: [], connectivity: OFFLINE });
    await flush();
    act(() => {
      result.current.retry(result.current.pending[0].tempId);
    });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(3);
    expect(result.current.pending[0].queued).toBe(true);

    // …and that attempt earns a fresh automatic resend on the next recovery.
    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(4);
  });

  it('resends every queued message, in order', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('down'));
    const { result, rerender } = renderPending(sendFn, { connectivity: OFFLINE });

    act(() => {
      result.current.sendOptimistic('one', { cliToolId: 'claude' });
    });
    act(() => {
      result.current.sendOptimistic('two', { cliToolId: 'claude' });
    });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(4);
    expect(sendFn.mock.calls.slice(2).map((c) => c[0])).toEqual(['one', 'two']);
  });

  it('does nothing on recovery when there is nothing waiting', async () => {
    const sendFn = vi.fn().mockResolvedValue({ success: true });
    const onSent = vi.fn();
    const { rerender } = renderPending(sendFn, { connectivity: OFFLINE }, onSent);

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();

    expect(sendFn).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });
});

describe('usePendingMessages — resend never duplicates (Issue #2503)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resend a message whose echo the recovery refetch brought back', async () => {
    // The lost-response case: the server accepted the POST and the reply never
    // made it home, so the client saw a transport error.
    const sendFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const echo = serverUserMessage('landed anyway', 's1', 1000);

    let serverMessages: ChatMessage[] = [];
    const { result, rerender } = renderHook(
      ({ connectivity }: { connectivity: PendingConnectivity }) =>
        usePendingMessages({
          worktreeId: 'w1',
          serverMessages,
          sendFn,
          // The caller's refetch: the recovery pass awaits it, and this is the
          // render the resend decision is made on.
          onSent: async () => {
            serverMessages = [echo];
          },
          connectivity,
        }),
      { initialProps: { connectivity: OFFLINE } },
    );

    act(() => {
      result.current.sendOptimistic('landed anyway', { cliToolId: 'claude' });
    });
    await flush();
    expect(result.current.pending[0].queued).toBe(true);
    expect(sendFn).toHaveBeenCalledTimes(1);

    rerender({ connectivity: ONLINE });
    await flush();
    // The refetch ran; re-render with what it produced.
    rerender({ connectivity: ONLINE });
    await flush();

    // Never sent twice, and the bubble has been replaced by the real row.
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('s1');
  });

  it('never resends a request that is still in flight', async () => {
    // The outcome is unknown, so the conservative answer is to wait rather than
    // risk putting the same prompt into the agent's session twice.
    const sendFn = vi.fn().mockReturnValue(new Promise<never>(() => {}));
    const { result, rerender } = renderPending(sendFn, { connectivity: ONLINE });

    act(() => {
      result.current.sendOptimistic('unknown', { cliToolId: 'claude' });
    });
    rerender({ serverMessages: [], connectivity: OFFLINE });
    await flush();
    expect(result.current.pending[0].queued).toBe(true);

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('does not resend a send that succeeded after the drop', async () => {
    let settle: (() => void) | undefined;
    const sendFn = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const { result, rerender } = renderPending(sendFn, { connectivity: ONLINE });

    act(() => {
      result.current.sendOptimistic('slow but fine', { cliToolId: 'claude' });
    });
    rerender({ serverMessages: [], connectivity: OFFLINE });
    await flush();
    expect(result.current.pending[0].queued).toBe(true);

    // The request completes: the server has it. It stays parked — there is
    // still no network for the echo to arrive over — but it is no longer
    // something that needs sending.
    await act(async () => {
      settle?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.pending[0].accepted).toBe(true);

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('refetches before resending so the check runs on fresh data', async () => {
    const order: string[] = [];
    const sendFn = vi.fn(async () => {
      order.push('send');
      throw new Error('down');
    });
    const onSent = vi.fn(async () => {
      order.push('refetch');
    });
    const { result, rerender } = renderPending(sendFn, { connectivity: OFFLINE }, onSent);

    act(() => {
      result.current.sendOptimistic('check first', { cliToolId: 'claude' });
    });
    await flush();
    expect(order).toEqual(['send']);

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();

    expect(order).toEqual(['send', 'refetch', 'send']);
  });

  it('still resends when the recovery refetch itself fails', async () => {
    const sendFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ success: true });
    const onSent = vi.fn().mockRejectedValue(new Error('refetch failed'));
    const { result, rerender } = renderPending(sendFn, { connectivity: OFFLINE }, onSent);

    act(() => {
      result.current.sendOptimistic('do not strand me', { cliToolId: 'claude' });
    });
    await flush();

    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();

    expect(sendFn).toHaveBeenCalledTimes(2);
  });
});

describe('usePendingMessages — without a connectivity input (Issue #2503)', () => {
  it('behaves exactly as it did before: a failed send is an error', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() =>
      usePendingMessages({ worktreeId: 'w1', serverMessages: [], sendFn }),
    );

    act(() => {
      result.current.sendOptimistic('legacy', { cliToolId: 'claude' });
    });
    await flush();

    expect(result.current.messages[0].optimisticState).toBe('error');
    expect(result.current.pending[0].queued).toBe(false);
    expect(sendFn).toHaveBeenCalledTimes(1);
  });
});
