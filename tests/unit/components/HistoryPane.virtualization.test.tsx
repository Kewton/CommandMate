/**
 * Virtualization tests for HistoryPane (Issue #1123)
 *
 * Verifies that the history list is virtualized (only the visible window +
 * overscan is mounted), that expand/collapse works while virtualized (state is
 * held by the parent so it survives card recycling), and that appending new
 * messages keeps the list virtualized.
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { generateConversationMessages } from '@tests/helpers/history-fixtures';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

describe('HistoryPane virtualization (Issue #1123)', () => {
  const onFilePathClick = vi.fn();
  let restoreLayout: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    // 2000px viewport over 200px rows → ~10 visible + overscan.
    restoreLayout = installVirtualLayout({ viewportHeight: 2000, rowHeight: 200 });
  });

  afterEach(() => {
    restoreLayout();
  });

  it('mounts only the visible window + overscan for a 1000-pair history', () => {
    const messages = generateConversationMessages(1000);

    render(
      <HistoryPane
        messages={messages}
        worktreeId="test-worktree"
        onFilePathClick={onFilePathClick}
      />
    );

    const cards = screen.getAllByTestId('conversation-pair-card');
    // Far fewer than the 1000 pairs — the whole point of virtualization.
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(100);
  });

  it('renders the top of a 1000-pair history and omits far-off-screen rows', () => {
    const messages = generateConversationMessages(1000);

    render(
      <HistoryPane
        messages={messages}
        worktreeId="test-worktree"
        onFilePathClick={onFilePathClick}
      />
    );

    // The list starts at the top (no auto-scroll on mount), so the first pair
    // is mounted while the last is not.
    expect(screen.getByText('User message 0')).toBeInTheDocument();
    expect(screen.queryByText('User message 999')).not.toBeInTheDocument();
  });

  it('reserves the full scroll height via the virtual sizer', () => {
    const messages = generateConversationMessages(1000);

    render(
      <HistoryPane
        messages={messages}
        worktreeId="test-worktree"
        onFilePathClick={onFilePathClick}
      />
    );

    const scrollContainer = screen.getByTestId('history-scroll-container');
    const sizer = scrollContainer.firstElementChild as HTMLElement;
    expect(sizer).toBeTruthy();
    // 1000 rows × measured 200px each = a tall sizer, even though only ~16
    // cards are mounted.
    const height = parseInt(sizer.style.height, 10);
    expect(height).toBeGreaterThan(1000);
  });

  it('toggles expand/collapse while virtualized (state held by parent)', () => {
    const messages = generateConversationMessages(3, { longAssistant: true });

    render(
      <HistoryPane
        messages={messages}
        worktreeId="test-worktree"
        onFilePathClick={onFilePathClick}
      />
    );

    // First pair's expand control is present; toggling flips it to collapse and
    // back without unmounting the row (expand state lives in the parent).
    const expandButtons = screen.getAllByRole('button', { name: /expand/i });
    expect(expandButtons.length).toBeGreaterThan(0);

    fireEvent.click(expandButtons[0]);
    expect(screen.getByRole('button', { name: /collapse/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /collapse/i }));
    expect(screen.getAllByRole('button', { name: /expand/i }).length).toBeGreaterThan(0);
  });

  it('keeps the list virtualized after appending a new message', () => {
    const base = generateConversationMessages(1000);
    const { rerender } = render(
      <HistoryPane
        messages={base}
        worktreeId="test-worktree"
        onFilePathClick={onFilePathClick}
      />
    );

    const before = screen.getAllByTestId('conversation-pair-card').length;
    expect(before).toBeLessThan(100);

    // Append one more pair (a new user+assistant exchange).
    const appended = generateConversationMessages(1001);
    rerender(
      <HistoryPane
        messages={appended}
        worktreeId="test-worktree"
        onFilePathClick={onFilePathClick}
      />
    );

    const after = screen.getAllByTestId('conversation-pair-card').length;
    expect(after).toBeLessThan(100);
  });
});
