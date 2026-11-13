/**
 * Issue #4345 1c-2 (K1): a parked message whose automatic resend was refused (`heldNotSent`) is not
 * left drawn as "sending" with no way out. Both surfaces (the PC pair card and the mobile / chat
 * bubble) offer retry and discard for it; nothing resends it on its own; after the recovery a
 * retry sends it once.
 *
 * Positive controls: red before 1c-2 (the row was drawn 'sending': no retry / discard).
 * Negative controls: an ordinary parked row (not held) is still drawn 'sending' with no buttons.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, render, screen, fireEvent } from '@testing-library/react';
import { usePendingMessages, type PendingConnectivity, type SendFn } from '@/hooks/usePendingMessages';
import { HandoffPageOperationRefusedError, isHandoffPageOperationRefused } from '@/lib/handoff/page-registration';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { ChatMessageBubble } from '@/components/worktree/ChatMessageBubble';
import type { ChatMessage } from '@/types/models';
import type { ConversationPair } from '@/types/conversation';

const OFFLINE: PendingConnectivity = { offline: true, reachable: false };
const ONLINE: PendingConnectivity = { offline: false, reachable: true };
const GRACE_MS = 5;
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, GRACE_MS * 5)));

function renderPending(sendFn: SendFn) {
  return renderHook(
    ({ serverMessages, connectivity }: { serverMessages: ChatMessage[]; connectivity: PendingConnectivity }) =>
      usePendingMessages({
        worktreeId: 'w1',
        serverMessages,
        sendFn,
        connectivity,
        resendGraceMs: GRACE_MS,
        isNotSent: isHandoffPageOperationRefused,
      }),
    { initialProps: { serverMessages: [] as ChatMessage[], connectivity: OFFLINE } },
  );
}

/** A row parked in the tunnel whose automatic resend on recovery is refused (held). */
async function heldRow(sendFn: SendFn) {
  const hook = renderPending(sendFn);
  act(() => hook.result.current.sendOptimistic('in the tunnel', { cliToolId: 'claude' }));
  await flush();
  hook.rerender({ serverMessages: [], connectivity: ONLINE });
  await flush();
  await flush();
  return hook;
}

function pairOf(message: ChatMessage): ConversationPair {
  return { id: 'pair', userMessage: message, assistantMessages: [], status: 'pending' };
}

describe('[#4345 1c-2] a held (refused) automatic resend can be retried or discarded by the person', () => {
  it('draws the held row as unsent (error) so both surfaces offer retry and discard', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new HandoffPageOperationRefusedError());
    const { result } = await heldRow(sendFn);
    expect(result.current.pending[0].heldNotSent).toBe(true);
    const message = result.current.messages[0];
    expect(message.optimisticState).toBe('error');

    const onRetryPending = vi.fn();
    const onDiscardPending = vi.fn();
    // PC pair card
    const pc = render(<ConversationPairCard pair={pairOf(message)} onFilePathClick={vi.fn()} onRetryPending={onRetryPending} onDiscardPending={onDiscardPending} />);
    fireEvent.click(screen.getByTestId('pending-retry'));
    fireEvent.click(screen.getByTestId('pending-discard'));
    expect(onRetryPending).toHaveBeenCalledWith(message.id);
    expect(onDiscardPending).toHaveBeenCalledWith(message.id);
    pc.unmount();
    // Mobile / chat bubble
    render(<ChatMessageBubble message={message} showHeader onFilePathClick={vi.fn()} onRetryPending={onRetryPending} onDiscardPending={onDiscardPending} />);
    expect(screen.getByTestId('chat-pending-retry')).toBeInTheDocument();
    expect(screen.getByTestId('chat-pending-discard')).toBeInTheDocument();
  });

  it('never resends on its own; after the recovery a retry sends it once, discard drops it', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new HandoffPageOperationRefusedError()).mockResolvedValue(undefined);
    const { result } = await heldRow(sendFn);
    await flush();
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);
    const tempId = result.current.pending[0].tempId;
    act(() => result.current.retry(tempId));
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(3);
    expect(result.current.pending[0].heldNotSent).toBe(false);
    expect(result.current.messages[0].optimisticState).toBe('sending');

    const second = await heldRow(vi.fn().mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new HandoffPageOperationRefusedError()));
    act(() => second.result.current.discard(second.result.current.pending[0].tempId));
    expect(second.result.current.pending).toEqual([]);
  });

  it('(negative control) a parked row that is not held is still drawn sending, with no buttons', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(new Error('down'));
    const { result } = renderPending(sendFn);
    act(() => result.current.sendOptimistic('waiting', { cliToolId: 'claude' }));
    await flush();
    expect(result.current.pending[0].queued).toBe(true);
    expect(result.current.messages[0].optimisticState).toBe('sending');
    render(<ChatMessageBubble message={result.current.messages[0]} showHeader onFilePathClick={vi.fn()} onRetryPending={vi.fn()} onDiscardPending={vi.fn()} />);
    expect(screen.queryByTestId('chat-pending-retry')).toBeNull();
  });
});
