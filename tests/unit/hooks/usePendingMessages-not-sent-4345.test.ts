/**
 * Issue #4345 1c 再指示 2 (K1, T4): the optimistic layer tells "not sent" (the hand-off page's gate
 * refused the send: `HandoffPageOperationRefusedError`) apart from a failure.
 *
 * - A retry of a failed row that is not sent: the row goes back to failed as it was — no new
 *   attempt is counted, nothing looks sent.
 * - An automatic resend on the recovery edge that is not sent: the row stays parked, its automatic
 *   resend NOT spent (`autoResendAttempted` false) — the person retries after the recovery.
 * - A new send that is not sent: no bubble is left (nothing looks sent) and its text is handed back
 *   (`onNotSent`) for the composer to keep.
 * Negative controls (green before and after): a real failure still fails the row; without
 * `isNotSent` the refusal is a failure as any rejection (the hook's other users are unchanged).
 *
 * Positive controls are red before 再指示 2 (the hook had no "not sent").
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePendingMessages, type PendingConnectivity, type SendFn } from '@/hooks/usePendingMessages';
import { HandoffPageOperationRefusedError, isHandoffPageOperationRefused } from '@/lib/handoff/page-registration';
import type { ChatMessage } from '@/types/models';

const OFFLINE: PendingConnectivity = { offline: true, reachable: false };
const ONLINE: PendingConnectivity = { offline: false, reachable: true };
const GRACE_MS = 5;
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, GRACE_MS * 5)));

function renderPending(sendFn: SendFn, connectivity: PendingConnectivity, onNotSent?: (content: string) => void, notSent = true) {
  return renderHook(
    ({ serverMessages, connectivity: c }: { serverMessages: ChatMessage[]; connectivity: PendingConnectivity }) =>
      usePendingMessages({
        worktreeId: 'w1',
        serverMessages,
        sendFn,
        connectivity: c,
        resendGraceMs: GRACE_MS,
        ...(notSent ? { isNotSent: isHandoffPageOperationRefused, onNotSent } : {}),
      }),
    { initialProps: { serverMessages: [], connectivity } },
  );
}

describe('[#4345 1c 再指示 2] (T4) the optimistic layer: "not sent" is not a failure', () => {
  it('a retry not sent: the row goes back to failed, as it was', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(new Error('500')).mockRejectedValueOnce(new HandoffPageOperationRefusedError());
    const { result } = renderPending(sendFn, ONLINE);
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'claude' }));
    await flush();
    const failed = result.current.pending[0];
    expect(failed.status).toBe('error');
    act(() => result.current.retry(failed.tempId));
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toEqual([failed]);
    expect(result.current.messages[0].optimisticState).toBe('error');
  });

  it('an automatic resend not sent: stays parked, its resend not spent', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new HandoffPageOperationRefusedError());
    const { result, rerender } = renderPending(sendFn, OFFLINE);
    act(() => result.current.sendOptimistic('in the tunnel', { cliToolId: 'claude' }));
    await flush();
    expect(result.current.pending[0].queued).toBe(true);
    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.pending[0].queued).toBe(true);
    expect(result.current.pending[0].autoResendAttempted).toBe(false);
    expect(result.current.pending[0].status).toBe('sending');
    // Held: nothing resends it on its own again (no loop while the session is expired).
    await flush();
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(result.current.pending[0].heldNotSent).toBe(true);
  });

  it('a new send not sent: no bubble left, its text handed back', async () => {
    const onNotSent = vi.fn();
    const sendFn = vi.fn().mockRejectedValueOnce(new HandoffPageOperationRefusedError());
    const { result } = renderPending(sendFn, ONLINE, onNotSent);
    act(() => result.current.sendOptimistic('draft text', { cliToolId: 'claude' }));
    await flush();
    expect(result.current.pending).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(onNotSent).toHaveBeenCalledWith('draft text');
  });

  it('(negative control) a real failure still fails the row', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(new Error('500'));
    const { result } = renderPending(sendFn, ONLINE, vi.fn());
    act(() => result.current.sendOptimistic('x', { cliToolId: 'claude' }));
    await flush();
    expect(result.current.pending[0].status).toBe('error');
  });

  it('(negative control) without isNotSent a refusal is a failure as before', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(new HandoffPageOperationRefusedError());
    const { result } = renderPending(sendFn, ONLINE, undefined, false);
    act(() => result.current.sendOptimistic('x', { cliToolId: 'claude' }));
    await flush();
    expect(result.current.pending[0].status).toBe('error');
  });
});
