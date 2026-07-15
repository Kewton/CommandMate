/**
 * Tests for usePendingMessages hook (Issue #1121)
 *
 * Covers optimistic insertion, server-echo reconciliation (no duplicate),
 * send failure, consecutive-send ordering, identical-text robustness,
 * timeout, retry and discard.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePendingMessages } from '../usePendingMessages';
import type { ChatMessage } from '@/types/models';

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

/** Let floating microtasks (the fire-and-forget send) settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('usePendingMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a pending bubble immediately on sendOptimistic', () => {
    const sendFn = vi.fn().mockResolvedValue({ success: true });
    const { result } = renderHook(() =>
      usePendingMessages({ worktreeId: 'w1', serverMessages: [], sendFn }),
    );

    act(() => {
      result.current.sendOptimistic('hello', { cliToolId: 'claude' });
    });

    expect(result.current.messages).toHaveLength(1);
    const bubble = result.current.messages[0];
    expect(bubble.content).toBe('hello');
    expect(bubble.role).toBe('user');
    expect(bubble.optimisticState).toBe('sending');
    expect(sendFn).toHaveBeenCalledWith('hello', { cliToolId: 'claude' });
  });

  it('reconciles the pending with the server echo without duplicating', async () => {
    const sendFn = vi.fn().mockResolvedValue({ success: true });
    const { result, rerender } = renderHook(
      ({ serverMessages }) =>
        usePendingMessages({ worktreeId: 'w1', serverMessages, sendFn }),
      { initialProps: { serverMessages: [] as ChatMessage[] } },
    );

    act(() => {
      result.current.sendOptimistic('hello', { cliToolId: 'claude' });
    });
    await flush();
    expect(result.current.messages).toHaveLength(1);

    // Server echo arrives on the next poll.
    rerender({ serverMessages: [serverUserMessage('hello', 's1', 1000)] });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('s1');
    expect(result.current.messages[0].optimisticState).toBeUndefined();
    expect(result.current.pending).toHaveLength(0);
  });

  it('marks the message as error when the send fails', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() =>
      usePendingMessages({ worktreeId: 'w1', serverMessages: [], sendFn }),
    );

    act(() => {
      result.current.sendOptimistic('oops', { cliToolId: 'claude' });
    });
    await flush();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].optimisticState).toBe('error');
  });

  it('preserves order for consecutive sends (連投)', () => {
    const sendFn = vi.fn().mockResolvedValue({ success: true });
    const { result } = renderHook(() =>
      usePendingMessages({ worktreeId: 'w1', serverMessages: [], sendFn }),
    );

    act(() => {
      result.current.sendOptimistic('a', { cliToolId: 'claude' });
    });
    act(() => {
      result.current.sendOptimistic('b', { cliToolId: 'claude' });
    });

    expect(result.current.messages.map((m) => m.content)).toEqual(['a', 'b']);
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it('reconciles identical-content sends one-to-one', async () => {
    const sendFn = vi.fn().mockResolvedValue({ success: true });
    const { result, rerender } = renderHook(
      ({ serverMessages }) =>
        usePendingMessages({ worktreeId: 'w1', serverMessages, sendFn }),
      { initialProps: { serverMessages: [] as ChatMessage[] } },
    );

    act(() => {
      result.current.sendOptimistic('dup', { cliToolId: 'claude' });
    });
    act(() => {
      result.current.sendOptimistic('dup', { cliToolId: 'claude' });
    });
    await flush();
    expect(result.current.messages).toHaveLength(2);

    // Only ONE server echo so far: exactly one pending should remain.
    rerender({ serverMessages: [serverUserMessage('dup', 's1', 1000)] });
    expect(result.current.messages).toHaveLength(2);
    expect(
      result.current.messages.filter((m) => m.optimisticState === 'sending'),
    ).toHaveLength(1);

    // Second echo arrives: both reconciled, no pending left.
    rerender({
      serverMessages: [
        serverUserMessage('dup', 's1', 1000),
        serverUserMessage('dup', 's2', 2000),
      ],
    });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.pending).toHaveLength(0);
  });

  it('does not reconcile against a pre-existing identical message', async () => {
    const sendFn = vi.fn().mockResolvedValue({ success: true });
    const initial = [serverUserMessage('hello', 'old', 500)];
    const { result, rerender } = renderHook(
      ({ serverMessages }) =>
        usePendingMessages({ worktreeId: 'w1', serverMessages, sendFn }),
      { initialProps: { serverMessages: initial } },
    );

    act(() => {
      result.current.sendOptimistic('hello', { cliToolId: 'claude' });
    });
    await flush();
    // Old message + the new pending bubble — the old one must not swallow it.
    expect(result.current.messages).toHaveLength(2);
    expect(
      result.current.messages.filter((m) => m.optimisticState === 'sending'),
    ).toHaveLength(1);

    // A genuinely new echo reconciles it.
    rerender({
      serverMessages: [...initial, serverUserMessage('hello', 'new', 1500)],
    });
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.messages).toHaveLength(2);
  });

  it('times out an unconfirmed send into an error state', async () => {
    vi.useFakeTimers();
    try {
      // Never resolves — simulates a hung request with no server echo.
      const sendFn = vi.fn().mockReturnValue(new Promise<never>(() => {}));
      const { result } = renderHook(() =>
        usePendingMessages({
          worktreeId: 'w1',
          serverMessages: [],
          sendFn,
          timeoutMs: 1000,
        }),
      );

      act(() => {
        result.current.sendOptimistic('slow', { cliToolId: 'claude' });
      });
      expect(result.current.messages[0].optimisticState).toBe('sending');

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current.messages[0].optimisticState).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry re-sends a failed message and returns it to sending', async () => {
    const sendFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ success: true });
    const { result } = renderHook(() =>
      usePendingMessages({ worktreeId: 'w1', serverMessages: [], sendFn }),
    );

    act(() => {
      result.current.sendOptimistic('retry-me', { cliToolId: 'claude' });
    });
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('error');

    const tempId = result.current.pending[0].tempId;
    act(() => {
      result.current.retry(tempId);
    });
    expect(result.current.messages[0].optimisticState).toBe('sending');
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it('discard removes the pending and returns its content', () => {
    const sendFn = vi.fn().mockResolvedValue({ success: true });
    const { result } = renderHook(() =>
      usePendingMessages({ worktreeId: 'w1', serverMessages: [], sendFn }),
    );

    act(() => {
      result.current.sendOptimistic('bye', { cliToolId: 'claude' });
    });
    const tempId = result.current.pending[0].tempId;

    let returned: string | undefined;
    act(() => {
      returned = result.current.discard(tempId);
    });

    expect(returned).toBe('bye');
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.pending).toHaveLength(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
