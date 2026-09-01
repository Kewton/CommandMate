/**
 * The composer forwards the created row (Issue #2213).
 *
 * `worktreeApi.sendMessage` now resolves with the `ChatMessage` `/send` created
 * instead of throwing the 201 body away in the type, and the composer passes it
 * on. Two facts are pinned:
 *
 *  - the await-then-clear path (no optimistic history — the phone in terminal
 *    mode, the assistant chat) hands the row to `onMessageSent`, so a caller that
 *    has nowhere to reconcile it from can adopt it directly;
 *  - the optimistic path passes NOTHING for it, because there the API call is
 *    fired in the background by `usePendingMessages` and the row arrives through
 *    reconciliation. A row reported here would be a second, racing source of the
 *    same message.
 *
 * The first argument is unchanged in both cases: every pre-#2213 caller declares
 * one parameter and must keep working untouched.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import {
  mockCommandGroups,
  createDefaultProps,
  getSendButton,
  typeMessage,
} from '@tests/helpers/message-input-test-utils';
import type { ChatMessage } from '@/types/models';

const CREATED: ChatMessage = {
  id: 'srv-42',
  worktreeId: 'test-worktree',
  role: 'user',
  content: 'ship it',
  timestamp: new Date('2026-09-01T10:20:30.000Z'),
  messageType: 'normal',
  archived: false,
  cliToolId: 'claude',
};

// The send button is located by its real aria-label, so this suite needs the
// real dictionary rather than the global key-echoing mock (same reason as
// `MessageInput.test.tsx`).
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

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: vi.fn(() => false) }));

describe('[#2213] MessageInput onMessageSent payload', () => {
  const defaultProps = createDefaultProps();

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageMock.mockResolvedValue(CREATED);
  });

  it('passes the created row alongside the cli tool id', async () => {
    const onMessageSent = vi.fn();
    render(<MessageInput {...defaultProps} onMessageSent={onMessageSent} />);

    typeMessage('ship it');
    fireEvent.click(getSendButton());

    await waitFor(() => {
      expect(onMessageSent).toHaveBeenCalledWith('claude', CREATED);
    });
  });

  it('passes no row on the optimistic path', async () => {
    const onMessageSent = vi.fn();
    const onOptimisticSend = vi.fn();
    render(
      <MessageInput
        {...defaultProps}
        onMessageSent={onMessageSent}
        onOptimisticSend={onOptimisticSend}
      />,
    );

    typeMessage('ship it');
    fireEvent.click(getSendButton());

    await waitFor(() => {
      expect(onOptimisticSend).toHaveBeenCalledWith('ship it', { cliToolId: 'claude' });
    });
    // The composer must not call the API itself when it delegated the send.
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(onMessageSent).toHaveBeenCalledWith('claude');
    expect(onMessageSent.mock.calls[0][1]).toBeUndefined();
  });
});
