/**
 * Issue #4503 (PR-B2, design-4503.md 第 2 版 §3.2・§6.3): what the chat bubble offers for a send whose
 * outcome is unknown, and for one whose clock ran out while it is still in flight.
 *
 *  - unknown: no ［再試行］. It says that nobody knows whether it arrived, points at the terminal,
 *    and offers 「送り直す」 only behind a confirmation (a new send of the same text).
 *  - awaiting the answer: neither ［再試行］ nor ［破棄］ — the request is still travelling.
 *  - (positive control) error: ［再試行］ and ［破棄］ exactly as before.
 *
 * One test renders from the parent (the optimistic hook feeding `ChatTranscript`) with the real
 * Japanese dictionary, so the words are proved to reach the screen, not just the key.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatMessageBubble } from '@/components/worktree/ChatMessageBubble';
import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { usePendingMessages, isSendOutcomeUnknown, type SendFn } from '@/hooks/usePendingMessages';
import { ApiError } from '@/lib/api-client';
import type { ChatMessage } from '@/types/models';
import ja from '../../../../locales/ja/worktree.json';
import en from '../../../../locales/en/worktree.json';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

const JA = ja.conversation.sendUnknown;

function pendingRow(extra: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'pending-0',
    worktreeId: 'w1',
    role: 'user',
    content: 'hello agent',
    timestamp: new Date(Date.UTC(2026, 10, 21, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'antigravity',
    ...extra,
  };
}

function renderBubble(message: ChatMessage, onRetryPending = vi.fn(), onDiscardPending = vi.fn()) {
  render(
    <ChatMessageBubble
      message={message}
      showHeader={false}
      onFilePathClick={() => undefined}
      onRetryPending={onRetryPending}
      onDiscardPending={onDiscardPending}
    />,
  );
  return { onRetryPending, onDiscardPending };
}

describe('[#4503] the bubble of a send whose outcome is unknown', () => {
  it('has no ［再試行］, says it is unknown and to check the terminal', () => {
    renderBubble(pendingRow({ optimisticState: 'unknown' }));
    expect(screen.queryByTestId('chat-pending-retry')).toBeNull();
    expect(screen.queryByTestId('chat-optimistic-error')).toBeNull();
    expect(screen.getByTestId('chat-optimistic-unknown')).toHaveTextContent(JA.status);
    expect(screen.getByTestId('chat-optimistic-unknown-guidance')).toHaveTextContent(JA.guidance);
  });

  it('「送り直す」 sends nothing until it is confirmed, then asks for a confirmed resend', () => {
    const { onRetryPending } = renderBubble(pendingRow({ optimisticState: 'unknown' }));
    fireEvent.click(screen.getByTestId('chat-pending-resend'));
    expect(onRetryPending).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-pending-resend-confirm')).toHaveTextContent(JA.resendConfirm);
    fireEvent.click(screen.getByTestId('chat-pending-resend-confirm-yes'));
    expect(onRetryPending).toHaveBeenCalledTimes(1);
    expect(onRetryPending).toHaveBeenCalledWith('pending-0', { confirmedResend: true });
  });

  it('cancelling the confirmation sends nothing', () => {
    const { onRetryPending } = renderBubble(pendingRow({ optimisticState: 'unknown' }));
    fireEvent.click(screen.getByTestId('chat-pending-resend'));
    fireEvent.click(screen.getByTestId('chat-pending-resend-confirm-no'));
    expect(screen.queryByTestId('chat-pending-resend-confirm')).toBeNull();
    expect(onRetryPending).not.toHaveBeenCalled();
  });

  it('a clock that ran out while the request is in flight reads as waiting, with nothing to press', () => {
    renderBubble(pendingRow({ optimisticState: 'sending', optimisticAwaitingResponse: true }));
    expect(screen.getByTestId('chat-optimistic-awaiting')).toHaveTextContent(JA.awaiting);
    expect(screen.queryByTestId('chat-pending-retry')).toBeNull();
    expect(screen.queryByTestId('chat-pending-discard')).toBeNull();
    expect(screen.queryByTestId('chat-pending-resend')).toBeNull();
  });

  it('(positive control) a failed send still offers ［再試行］ that retries directly', () => {
    const { onRetryPending } = renderBubble(pendingRow({ optimisticState: 'error' }));
    expect(screen.getByTestId('chat-optimistic-error')).toHaveTextContent(ja.conversation.failedToSend);
    fireEvent.click(screen.getByTestId('chat-pending-retry'));
    expect(onRetryPending).toHaveBeenCalledWith('pending-0');
  });

  it('the wording exists in both languages', () => {
    for (const key of ['status', 'guidance', 'awaiting', 'resend', 'resendConfirm', 'resendConfirmYes', 'resendConfirmNo'] as const) {
      expect(typeof ja.conversation.sendUnknown[key]).toBe('string');
      expect(typeof en.conversation.sendUnknown[key]).toBe('string');
    }
  });
});

describe('[#4503] from the parent: the optimistic hook feeding ChatTranscript', () => {
  function Harness({ sendFn }: { sendFn: SendFn }) {
    const { messages, sendOptimistic, retry, discard } = usePendingMessages({
      worktreeId: 'w1',
      serverMessages: [],
      sendFn,
      isOutcomeUnknown: isSendOutcomeUnknown,
      holdInFlightOnTimeout: true,
    });
    return (
      <div>
        <button type="button" data-testid="harness-send" onClick={() => sendOptimistic('hello agent', { cliToolId: 'antigravity' })}>
          send
        </button>
        <ChatTranscript
          messages={messages}
          worktreeId="w1"
          cliToolId="antigravity"
          onRetryPending={retry}
          onDiscardPending={(id: string) => void discard(id)}
        />
      </div>
    );
  }

  it('500 sendOutcome:unknown shows the Japanese guidance and no retry; only a confirmed resend sends again', async () => {
    const sendFn = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('submit could not be confirmed', 500, { error: 'x', sendOutcome: 'unknown' }))
      .mockResolvedValue({ id: 's1' });
    render(<Harness sendFn={sendFn} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('harness-send'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText(JA.status)).toBeInTheDocument();
    expect(screen.getByText(JA.guidance)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-pending-retry')).toBeNull();
    expect(sendFn).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('chat-pending-resend'));
    expect(sendFn).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-pending-resend-confirm-yes'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sendFn).toHaveBeenCalledTimes(2);
  });
});
