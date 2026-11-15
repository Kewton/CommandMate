/**
 * Issue #4385 (A4 差し戻し): the optimistic layer and a send the server refused because of the role
 * (409 `roleRefusal`, nothing typed). The row fails at once with the reason (never parked, even
 * while the network is measured down — the server answered), `onRoleRefused` hears it with
 * `firstAttempt` (a new send's text goes back to the composer), and `discard()` does not hand the
 * text back a second time. Negative controls: without `readRoleRefusal` (the hook's other users,
 * e.g. the sessions tile) a 409 is a failure as before, and a failure that is not a role refusal
 * carries no reason and is handed back on discard as before.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook, act, render, screen } from '@testing-library/react';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { usePendingMessages, type PendingConnectivity, type SendFn } from '@/hooks/usePendingMessages';
import { ApiError } from '@/lib/api-client';
import { readSendRoleRefusal, sendRoleRefusalMessageKey } from '@/components/worktree/role-refusal-notice';

const ONLINE: PendingConnectivity = { offline: false, reachable: true };
const OFFLINE: PendingConnectivity = { offline: true, reachable: false };
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const refusal = (roleRefusal: string) =>
  new ApiError('refused', 409, { error: 'refused', code: 'ROLE_LAUNCH_REFUSED', roleRefusal, sendOutcome: 'not_sent' });

function renderPending(sendFn: SendFn, opts: { connectivity?: PendingConnectivity; withReason?: boolean; handBack?: boolean; timeoutMs?: number } = {}) {
  const onRoleRefused = vi.fn(() => opts.handBack ?? true);
  const hook = renderHook(() =>
    usePendingMessages({
      worktreeId: 'w1',
      serverMessages: [],
      sendFn,
      connectivity: opts.connectivity ?? ONLINE,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.withReason === false ? {} : { readRoleRefusal: readSendRoleRefusal, onRoleRefused }),
    }),
  );
  return { ...hook, onRoleRefused };
}

describe('[#4385 A4] the optimistic layer and a role refusal', () => {
  it.each(['not-applied', 'not-confirmed', 'artifact-failed'] as const)('%s: the row fails with the reason', async (reason) => {
    const { result, onRoleRefused } = renderPending(vi.fn().mockRejectedValue(refusal(reason)));
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('error');
    expect(result.current.messages[0].optimisticRoleRefusal).toBe(reason);
    expect(onRoleRefused).toHaveBeenCalledWith('hello', reason, { firstAttempt: true });
    let restored: string | undefined = 'unset';
    act(() => {
      restored = result.current.discard(result.current.pending[0].tempId);
    });
    expect(restored).toBeUndefined();
  });

  it('is never parked while the network is measured down (the server answered)', async () => {
    const { result } = renderPending(vi.fn().mockRejectedValue(refusal('not-confirmed')), { connectivity: OFFLINE });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.pending[0].queued).toBe(false);
    expect(result.current.messages[0].optimisticState).toBe('error');
  });

  it('a retry clears the reason while it is on its way, and is heard as not the first attempt', async () => {
    let answer: (v: unknown) => void = () => undefined;
    const sendFn = vi
      .fn()
      .mockRejectedValueOnce(refusal('not-applied'))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { answer = reject; }));
    const { result, onRoleRefused } = renderPending(sendFn);
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    act(() => result.current.retry(result.current.pending[0].tempId));
    expect(result.current.messages[0].optimisticState).toBe('sending');
    expect(result.current.messages[0].optimisticRoleRefusal).toBeUndefined();
    await act(async () => answer(refusal('not-confirmed')));
    await flush();
    expect(result.current.messages[0].optimisticRoleRefusal).toBe('not-confirmed');
    expect(onRoleRefused).toHaveBeenLastCalledWith('hello', 'not-confirmed', { firstAttempt: false });
  });

  it('when the text was not handed back, discard hands it back as before', async () => {
    const { result } = renderPending(vi.fn().mockRejectedValue(refusal('not-applied')), { handBack: false });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    let restored: string | undefined;
    act(() => {
      restored = result.current.discard(result.current.pending[0].tempId);
    });
    expect(restored).toBe('hello');
  });
});

describe('[#4385 A4] (negative controls) the hook as before', () => {
  it('without readRoleRefusal a 409 is a plain failure, handed back on discard', async () => {
    const { result } = renderPending(vi.fn().mockRejectedValue(refusal('not-applied')), { withReason: false });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('error');
    expect(result.current.messages[0].optimisticRoleRefusal).toBeUndefined();
    let restored: string | undefined;
    act(() => {
      restored = result.current.discard(result.current.pending[0].tempId);
    });
    expect(restored).toBe('hello');
  });

  it('a 500 carries no reason and is not heard as a role refusal', async () => {
    const { result, onRoleRefused } = renderPending(vi.fn().mockRejectedValue(new ApiError('boom', 500, { error: 'boom' })));
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'claude' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('error');
    expect(result.current.messages[0].optimisticRoleRefusal).toBeUndefined();
    expect(onRoleRefused).not.toHaveBeenCalled();
  });
});

describe('[#4385 A4 再指示 1] a role refusal that lands after the clock failed the row', () => {
  function deferredSend() {
    const answers: Array<(e: unknown) => void> = [];
    const sendFn = vi.fn(() => new Promise((_resolve, reject) => { answers.push(reject); }));
    return { sendFn, answers };
  }

  it.each(['not-applied', 'not-confirmed', 'artifact-failed'] as const)(
    '%s: the failed row still takes the reason and the record, so discard hands nothing back twice',
    async (reason) => {
      const { sendFn, answers } = deferredSend();
      const { result, onRoleRefused } = renderPending(sendFn, { timeoutMs: 5 });
      act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
      await flush();
      // The clock failed it first (the 30 s window, shortened here).
      expect(result.current.messages[0].optimisticState).toBe('error');
      expect(result.current.messages[0].optimisticRoleRefusal).toBeUndefined();
      await act(async () => answers[0](refusal(reason)));
      await flush();
      expect(onRoleRefused).toHaveBeenCalledWith('hello', reason, { firstAttempt: true });
      expect(result.current.messages[0].optimisticState).toBe('error');
      expect(result.current.messages[0].optimisticRoleRefusal).toBe(reason);
      // The history row shows it, next to "Failed to send".
      const row = result.current.messages[0];
      render(<ConversationPairCard pair={{ id: row.id, userMessage: row, assistantMessages: [], status: 'pending' }} onFilePathClick={() => undefined} />);
      expect(screen.getByTestId('optimistic-error-reason')).toHaveTextContent(sendRoleRefusalMessageKey(reason));
      let restored: string | undefined = 'unset';
      act(() => {
        restored = result.current.discard(result.current.pending[0].tempId);
      });
      expect(restored).toBeUndefined();
    },
  );

  it('a late answer to the attempt before a retry does not touch the retried row', async () => {
    const { sendFn, answers } = deferredSend();
    const { result, onRoleRefused } = renderPending(sendFn, { timeoutMs: 5 });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('error');
    act(() => result.current.retry(result.current.pending[0].tempId));
    expect(result.current.messages[0].optimisticState).toBe('sending');
    // The first attempt's 409 arrives while the retry is on its way.
    await act(async () => answers[0](refusal('not-applied')));
    expect(onRoleRefused).not.toHaveBeenCalled();
    expect(result.current.messages[0].optimisticState).toBe('sending');
    expect(result.current.messages[0].optimisticRoleRefusal).toBeUndefined();
    expect(result.current.pending[0].returnedToComposer).toBeFalsy();
  });

  it('a late answer to a discarded row changes nothing', async () => {
    const { sendFn, answers } = deferredSend();
    const { result, onRoleRefused } = renderPending(sendFn, { timeoutMs: 5 });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    act(() => {
      result.current.discard(result.current.pending[0].tempId);
    });
    await act(async () => answers[0](refusal('not-applied')));
    expect(onRoleRefused).not.toHaveBeenCalled();
    expect(result.current.pending).toEqual([]);
  });
});

describe('[#4385 A4 再指示 2] a discarded late answer and a not-sent retry keep the row’s attempt straight', () => {
  const NOT_SENT = new Error('not sent (the page gate refused it)');

  function renderWithConnectivity(sendFn: SendFn) {
    const onRoleRefused = vi.fn(() => true);
    const hook = renderHook(
      ({ connectivity }: { connectivity: PendingConnectivity }) =>
        usePendingMessages({
          worktreeId: 'w1',
          serverMessages: [],
          sendFn,
          connectivity,
          timeoutMs: 5,
          resendGraceMs: 0,
          isNotSent: (error) => error === NOT_SENT,
          readRoleRefusal: readSendRoleRefusal,
          onRoleRefused,
        }),
      { initialProps: { connectivity: ONLINE } },
    );
    return { ...hook, onRoleRefused };
  }

  it('A times out → retry B → A’s 409 → offline → recovery: B (still unanswered) is not resent', async () => {
    const answers: Array<(e: unknown) => void> = [];
    const sendFn = vi.fn(() => new Promise<void>((_resolve, reject) => { answers.push(reject); }));
    const { result, rerender } = renderWithConnectivity(sendFn);
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('error');
    await act(async () => {
      result.current.retry(result.current.pending[0].tempId);
      // A's 409 lands while B is on its way; A's answer is set aside.
      answers[0](refusal('not-applied'));
    });
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(result.current.messages[0].optimisticState).toBe('sending');
    rerender({ connectivity: OFFLINE });
    expect(result.current.pending[0].queued).toBe(true);
    rerender({ connectivity: ONLINE });
    await flush();
    // B's outcome is unknown (still in flight): never sent a second time.
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it('A times out → retry B not sent (row back to A) → A’s 409: the row takes A’s reason and the text goes back', async () => {
    const answers: Array<(e: unknown) => void> = [];
    const sendFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { answers.push(reject); }))
      .mockRejectedValueOnce(NOT_SENT);
    const { result, onRoleRefused } = renderWithConnectivity(sendFn as unknown as SendFn);
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('error');
    act(() => result.current.retry(result.current.pending[0].tempId));
    await flush();
    // Not sent: the row is back as it was (failed, no reason yet).
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(result.current.messages[0].optimisticState).toBe('error');
    expect(result.current.messages[0].optimisticRoleRefusal).toBeUndefined();
    await act(async () => answers[0](refusal('not-confirmed')));
    await flush();
    expect(onRoleRefused).toHaveBeenCalledWith('hello', 'not-confirmed', { firstAttempt: true });
    expect(result.current.messages[0].optimisticRoleRefusal).toBe('not-confirmed');
    let restored: string | undefined = 'unset';
    act(() => {
      restored = result.current.discard(result.current.pending[0].tempId);
    });
    expect(restored).toBeUndefined();
  });
});
