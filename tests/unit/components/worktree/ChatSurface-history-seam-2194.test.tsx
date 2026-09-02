/**
 * The one seam `ChatSurface` reaches through the DOM (Issue #2194 / #2232).
 *
 * `ChatTranscript` owns its scroll region and exposes no ref for it, so follow-
 * the-tail resolves the element by querySelector. That makes
 * {@link CHAT_SCROLL_CONTAINER_SELECTOR} a contract between two components that
 * the type checker cannot see: rename the transcript's testid and every follow
 * test in `ChatSurface-2194.test.tsx` stays green (they stub the transcript),
 * while the shipped surface silently stops following.
 *
 * This file is what closes that gap — the REAL transcript, rendered inside the
 * REAL surface, asked whether the selector still finds anything.
 *
 * Issue #2232 also moved the chrome question here. The surface used to forward
 * `HistoryPane`'s display-limit / archived / user-only controls and render them
 * over a conversation; it must not any more, and search must survive that
 * removal — deleting the only way to search a transcript would be a straight
 * regression, which is the failure this file's last two cases describe.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatSurface, CHAT_SCROLL_CONTAINER_SELECTOR } from '@/components/worktree/ChatSurface';
import type { ChatMessage } from '@/types/models';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

const WORKTREE_ID = 'wt-2194-seam';

function msg(id: string, role: ChatMessage['role'], offsetMs = 0): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content ${id}`,
    timestamp: new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + offsetMs),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

describe('[#2194] ChatSurface ↔ ChatTranscript scroll seam', () => {
  let restoreLayout: () => void;

  beforeEach(() => {
    restoreLayout = installVirtualLayout({
      scrollContainerTestId: 'chat-transcript-scroll-container',
    });
  });

  afterEach(() => {
    restoreLayout();
    vi.clearAllMocks();
  });

  it('finds the real transcript scroll region through the published selector', () => {
    render(
      <ChatSurface
        messages={[msg('u1', 'user'), msg('a1', 'assistant', 1000)]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={{}}
        onSurfaceModeChange={vi.fn()}
      />,
    );

    const root = screen.getByTestId('chat-surface');
    expect(root.querySelector(CHAT_SCROLL_CONTAINER_SELECTOR)).not.toBeNull();
  });

  it('mounts the transcript exactly once and hands it every message', () => {
    render(
      <ChatSurface
        messages={[msg('u1', 'user'), msg('a1', 'assistant', 1000)]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={{}}
        onSurfaceModeChange={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId('chat-transcript-scroll-container')).toHaveLength(1);
    expect(screen.getByText('content u1')).toBeInTheDocument();
    expect(screen.getByText('content a1')).toBeInTheDocument();
  });

  it('forwards the transcript props it is handed rather than re-declaring them', () => {
    // The PC split hands over the SAME object its collapsible History column
    // gets. Only the transcript-shaped half of it reaches here now, and dropping
    // the spread would silently take the file-path / insert / retry callbacks
    // with it.
    const onInsertToMessage = vi.fn();
    render(
      <ChatSurface
        messages={[msg('u1', 'user')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={{}}
        onSurfaceModeChange={vi.fn()}
        history={{ onInsertToMessage, splitIndex: 0 }}
      />,
    );

    fireEvent.click(screen.getByTestId('chat-insert-user-message'));
    expect(onInsertToMessage).toHaveBeenCalledWith('content u1');
  });

  it('renders none of the History browser chrome over the conversation', () => {
    // Issue #2232: a display-limit select, an archived checkbox, a user-only
    // toggle and a "Message History" title are a BROWSER's controls. The PC
    // split still hands the whole object over, so this is asserting that the
    // surface ignores the half it must not render — not that the caller stopped
    // sending it.
    // A VARIABLE, not an inline literal: that is what the PC split actually
    // passes, and it is why the extra keys are legal at this call site at all
    // (TypeScript's excess-property check does not apply to a variable).
    const splitProps = {
      onFilePathClick: vi.fn(),
      showArchived: true,
      onShowArchivedChange: vi.fn(),
      historyUserOnly: false,
      onHistoryUserOnlyChange: vi.fn(),
      historyDisplayLimit: 100,
      onHistoryDisplayLimitChange: vi.fn(),
    };
    render(
      <ChatSurface
        messages={[msg('u1', 'user')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={{}}
        onSurfaceModeChange={vi.fn()}
        history={splitProps}
      />,
    );

    expect(screen.queryByLabelText('worktree.history.displayLimit')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('worktree.history.showUserOnly')).not.toBeInTheDocument();
    expect(screen.queryByText('worktree.history.title')).not.toBeInTheDocument();
  });

  it('keeps a way to search the conversation', () => {
    // Removing the chrome above must not take search with it: chat can search
    // today, so losing it would be a regression rather than a simplification.
    render(
      <ChatSurface
        messages={[msg('u1', 'user')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={{}}
        onSurfaceModeChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-transcript-search-toggle')).toBeInTheDocument();
  });

  it('gives the output surface no collapse button', () => {
    // Collapsing the OUTPUT half would leave the split showing nothing at all,
    // which is why `onCollapse` is not part of the forwarded prop set.
    render(
      <ChatSurface
        messages={[msg('u1', 'user')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={{}}
        onSurfaceModeChange={vi.fn()}
        history={{ splitIndex: 0 }}
      />,
    );

    expect(screen.queryByTestId('history-pane-collapse-button-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-pane-collapse-button')).not.toBeInTheDocument();
  });
});
