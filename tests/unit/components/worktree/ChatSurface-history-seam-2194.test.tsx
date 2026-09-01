/**
 * The one seam `ChatSurface` reaches through the DOM (Issue #2194).
 *
 * `HistoryPane` owns its scroll region and exposes no ref for it, so follow-the-
 * tail resolves the element by querySelector. That makes
 * {@link HISTORY_SCROLL_CONTAINER_SELECTOR} a contract between two components
 * that the type checker cannot see: rename the pane's testid and every follow
 * test in `ChatSurface-2194.test.tsx` stays green (they stub the pane), while the
 * shipped surface silently stops following.
 *
 * This file is what closes that gap — the REAL pane, rendered inside the REAL
 * surface, asked whether the selector still finds anything.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatSurface, HISTORY_SCROLL_CONTAINER_SELECTOR } from '@/components/worktree/ChatSurface';
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

describe('[#2194] ChatSurface ↔ HistoryPane scroll seam', () => {
  let restoreLayout: () => void;

  beforeEach(() => {
    restoreLayout = installVirtualLayout();
  });

  afterEach(() => {
    restoreLayout();
    vi.clearAllMocks();
  });

  it('finds the real pane scroll region through the published selector', () => {
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
    expect(root.querySelector(HISTORY_SCROLL_CONTAINER_SELECTOR)).not.toBeNull();
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

    expect(screen.getAllByTestId('history-scroll-container')).toHaveLength(1);
    expect(screen.getByText('content u1')).toBeInTheDocument();
    expect(screen.getByText('content a1')).toBeInTheDocument();
  });

  it('forwards the pane props it is handed rather than re-declaring them', () => {
    // The PC split hands over the SAME object its collapsible History column
    // gets; if the spread were dropped the pane would silently lose the search /
    // archived / limit / user-only controls the Epic requires on this surface.
    const onShowArchivedChange = vi.fn();
    render(
      <ChatSurface
        messages={[msg('u1', 'user')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        live={{}}
        onSurfaceModeChange={vi.fn()}
        history={{
          showArchived: true,
          onShowArchivedChange,
          historyUserOnly: false,
          onHistoryUserOnlyChange: vi.fn(),
          historyDisplayLimit: 100,
          onHistoryDisplayLimitChange: vi.fn(),
        }}
      />,
    );

    expect(screen.getByLabelText('worktree.history.displayLimit')).toBeInTheDocument();
    expect(screen.getByLabelText('worktree.history.showUserOnly')).toBeInTheDocument();
    expect(screen.getByLabelText('worktree.history.openSearch')).toBeInTheDocument();
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
