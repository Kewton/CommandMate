/**
 * Tapping a path on the phone opens the file viewer (Issue #2345, phase C).
 *
 * Until this Issue `MobileTerminalTab` handed its chat surface
 * `onFilePathClick: () => {}` with a comment saying the routing had no owner:
 * `handleFilePathClick` lives in `WorktreeDetailRefactored` (where it is
 * `setMobileFileViewerPath`), and `MobileContent` — which builds this tab's
 * props — never threaded it down. So every path in every reply was inert on a
 * phone, which is the device the chat surface exists for.
 *
 * The owner is the same one; what changed is how it arrives. Two facts are
 * pinned here, because they are the two that a future prop-list edit could
 * silently undo:
 *
 *  1. the screen's `openFile` reaches the transcript, and
 *  2. the screen's `worktreePath` reaches it too — stated as a PROP down this
 *     chain (`MobileTerminalTab` → `ChatSurface` → `ChatTranscript`), so the
 *     phone does not depend on the transcript reading the scope a second time.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { ChatFileLinkProvider } from '@/lib/chat/chat-file-link-scope';

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

/**
 * A stand-in that reports the two props under test and nothing else. The real
 * transcript's own behaviour is `ChatFileLink-2345`; what this file is about is
 * whether the wiring reaches it at all.
 */
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({
    worktreePath,
    onFilePathClick,
  }: {
    worktreePath?: string;
    onFilePathClick?: (path: string) => void;
  }) => (
    <div
      data-testid="chat-transcript"
      data-worktree-path={worktreePath ?? ''}
      data-has-open={onFilePathClick ? 'yes' : 'no'}
    >
      <button
        type="button"
        data-testid="open-a-path"
        onClick={() => onFilePathClick?.('/abs/wt/docs/a.md')}
      />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

const { useTerminalPanePollingMock, useSplitMessagesMock, sendMessageMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  sendMessageMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));
vi.mock('@/lib/api-client', () => ({
  worktreeApi: { sendMessage: sendMessageMock },
}));

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const WORKTREE_ID = 'wt-2345';
const WORKTREE_PATH = '/abs/wt';

const ROW: ChatMessage = {
  id: 'm1',
  worktreeId: WORKTREE_ID,
  role: 'assistant',
  content: 'body',
  timestamp: new Date('2026-09-05T09:00:00.000Z'),
  messageType: 'normal',
  archived: false,
  cliToolId: 'claude',
};

beforeEach(() => {
  window.localStorage.clear();
  useSplitMessagesMock.mockReturnValue({
    messages: [ROW],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  });
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output',
      realtimeSnippet: 'output',
      isRunning: false,
      isThinking: false,
      isSelectionListActive: false,
      isPagerActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
});

async function showChat(): Promise<void> {
  fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
  await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
}

describe('[#2345] the phone tab is wired to the screen’s file viewer', () => {
  it('opens the path through the screen’s handler', async () => {
    const openFile = vi.fn();
    render(
      <ChatFileLinkProvider value={{ worktreePath: WORKTREE_PATH, openFile }}>
        <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />
      </ChatFileLinkProvider>,
    );
    await showChat();

    expect(screen.getByTestId('chat-transcript')).toHaveAttribute('data-has-open', 'yes');
    fireEvent.click(screen.getByTestId('open-a-path'));
    expect(openFile).toHaveBeenCalledWith('/abs/wt/docs/a.md');
  });

  it('states the worktree root down the chain as a prop', async () => {
    render(
      <ChatFileLinkProvider value={{ worktreePath: WORKTREE_PATH, openFile: vi.fn() }}>
        <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />
      </ChatFileLinkProvider>,
    );
    await showChat();

    expect(screen.getByTestId('chat-transcript')).toHaveAttribute(
      'data-worktree-path',
      WORKTREE_PATH,
    );
  });

  it('wires nothing at all when the tab is mounted with no screen above it', async () => {
    // The seventeen suites that mount this tab bare must keep working, and an
    // absent handler is better than the no-op it replaced: the transcript skips
    // the #2274 probe entirely rather than firing a request it will discard.
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />);
    await showChat();

    const transcript = screen.getByTestId('chat-transcript');
    expect(transcript).toHaveAttribute('data-has-open', 'no');
    expect(transcript).toHaveAttribute('data-worktree-path', '');
  });
});
