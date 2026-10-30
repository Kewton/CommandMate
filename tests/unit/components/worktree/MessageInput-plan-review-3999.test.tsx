/**
 * The composer does not send into Command Code's plan review (Issue #3999).
 *
 * The server refuses a message while the REVIEW screen is up
 * (`not-sent / plan-review`). On the optimistic path the composer had already
 * cleared the draft by then and the only trace was a failed pending row; on
 * either path nothing said where the review could be answered. So the guard is
 * at `submitMessage`'s door, which the send button AND a PC's Enter both go
 * through:
 *
 *  - planReviewActive: nothing is sent, no pending row is handed to the
 *    history layer, the draft (state and localStorage) is kept, and a notice
 *    with a link to the controls is shown;
 *  - not planReviewActive (another instance, or the review is over): the very
 *    same draft sends as before.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import {
  mockCommandGroups,
  createDefaultProps,
  getSendButton,
  getTextarea,
  typeMessage,
  pressEnter,
} from '@tests/helpers/message-input-test-utils';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    sendMessage: sendMessageMock,
    uploadImageFile: vi.fn().mockResolvedValue({ path: '.commandmate/attachments/test.png' }),
  },
  handleApiError: vi.fn((err: Error) => err?.message || 'Unknown error'),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups,
    filteredGroups: mockCommandGroups,
    allCommands: mockCommandGroups.flatMap((g) => g.commands),
    loading: false,
    error: null,
    isCatalogStale: false,
  })),
}));

const { isMobileMock } = vi.hoisted(() => ({ isMobileMock: vi.fn(() => false) }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: isMobileMock }));

const DRAFT_KEY = 'commandmate:draft-message:test-worktree:0';
const DRAFT = 'please also handle NaN';

describe('[#3999] MessageInput: no send into a plan review', () => {
  const defaultProps = createDefaultProps({ cliToolId: 'command-code', isSessionRunning: true });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    isMobileMock.mockReturnValue(false);
    sendMessageMock.mockResolvedValue({ id: 'srv-1' });
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it.each([
    ['the send button', () => fireEvent.click(getSendButton())],
    ['Enter on a PC', () => pressEnter()],
  ])('optimistic path: %s sends nothing, makes no pending row, keeps the draft', async (_name, submit) => {
    const onOptimisticSend = vi.fn();
    const onMessageSent = vi.fn();
    render(
      <MessageInput
        {...defaultProps}
        onMessageSent={onMessageSent}
        onOptimisticSend={onOptimisticSend}
        planReviewActive
      />,
    );

    typeMessage(DRAFT);
    // Let the debounced draft save land, as it would while the user typed.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    submit();
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(onOptimisticSend).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(onMessageSent).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe(DRAFT);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe(DRAFT);
    // The notice says why, louder once a send was stopped, with the way out.
    const notice = screen.getByTestId('composer-plan-review-notice');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent('waiting for your review');
    expect(screen.getByTestId('composer-plan-review-goto')).toBeInTheDocument();
  });

  it('await path: the button sends nothing and keeps the draft', async () => {
    render(<MessageInput {...defaultProps} planReviewActive />);
    typeMessage(DRAFT);
    fireEvent.click(getSendButton());
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(getTextarea().value).toBe(DRAFT);
  });

  it('shows the notice while the review is up, before anything is pressed', () => {
    render(<MessageInput {...defaultProps} planReviewActive />);
    const notice = screen.getByTestId('composer-plan-review-notice');
    expect(notice).toHaveAttribute('role', 'status');
  });

  it('control: without a plan review (another instance) the same draft is sent', async () => {
    const onOptimisticSend = vi.fn();
    render(<MessageInput {...createDefaultProps({ cliToolId: 'claude' })} onOptimisticSend={onOptimisticSend} />);
    typeMessage(DRAFT);
    pressEnter();
    expect(onOptimisticSend).toHaveBeenCalledWith(DRAFT, { cliToolId: 'claude' });
    expect(screen.queryByTestId('composer-plan-review-notice')).not.toBeInTheDocument();
  });

  it('once the review is over the kept draft goes out, button and Enter alike', async () => {
    const onOptimisticSend = vi.fn();
    const { rerender } = render(
      <MessageInput {...defaultProps} onOptimisticSend={onOptimisticSend} planReviewActive />,
    );
    typeMessage(DRAFT);
    pressEnter();
    expect(onOptimisticSend).not.toHaveBeenCalled();

    rerender(<MessageInput {...defaultProps} onOptimisticSend={onOptimisticSend} planReviewActive={false} />);
    expect(screen.queryByTestId('composer-plan-review-notice')).not.toBeInTheDocument();
    expect(getTextarea().value).toBe(DRAFT);
    fireEvent.click(getSendButton());
    await waitFor(() => {
      expect(onOptimisticSend).toHaveBeenCalledWith(DRAFT, { cliToolId: 'command-code' });
    });
  });

  it('the link focuses this instance’s controls and not another’s', () => {
    const other = document.createElement('div');
    other.dataset.planReviewTarget = 'test-worktree:command-code-2';
    other.tabIndex = -1;
    const mine = document.createElement('div');
    mine.dataset.planReviewTarget = 'test-worktree:command-code';
    mine.tabIndex = -1;
    document.body.append(other, mine);
    try {
      render(<MessageInput {...defaultProps} planReviewActive />);
      fireEvent.click(screen.getByTestId('composer-plan-review-goto'));
      expect(document.activeElement).toBe(mine);
    } finally {
      other.remove();
      mine.remove();
    }
  });
});
