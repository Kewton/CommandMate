/**
 * Tests for HistoryPane component
 *
 * Tests the message history display with conversation pair grouping, independent scrolling,
 * and file path click handling.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import type { ChatMessage } from '@/types/models';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

// [Issue #744] Spy on the highlight engine so we can assert which namespace a
// given HistoryPane uses (legacy global vs per-split). We keep the real
// implementation (via importOriginal) so the engine still behaves normally.
const applyHistoryHighlightsSpy = vi.fn();
const clearHistoryHighlightsSpy = vi.fn();
vi.mock('@/lib/terminal-highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/terminal-highlight')>();
  return {
    ...actual,
    applyHistoryHighlights: (...args: unknown[]) => {
      applyHistoryHighlightsSpy(...args);
      return (actual.applyHistoryHighlights as (...a: unknown[]) => void)(...args);
    },
    clearHistoryHighlights: (...args: unknown[]) => {
      clearHistoryHighlightsSpy(...args);
      return (actual.clearHistoryHighlights as (...a: unknown[]) => void)(...args);
    },
  };
});

// Helper to create test messages
function createTestMessage(
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id: overrides.id || `msg-${Date.now()}-${Math.random()}`,
    worktreeId: overrides.worktreeId || 'test-worktree',
    role: overrides.role || 'user',
    content: overrides.content || 'Test message',
    timestamp: overrides.timestamp || new Date(),
    messageType: overrides.messageType || 'normal',
    archived: false,
    ...overrides,
  };
}

describe('HistoryPane', () => {
  const mockOnFilePathClick = vi.fn();
  const defaultWorktreeId = 'test-worktree';

  // [Issue #1123] The list is virtualized; jsdom reports zero-size layout so the
  // virtualizer would mount no rows. Give it a real viewport for these tests.
  let restoreLayout: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreLayout = installVirtualLayout();
  });

  afterEach(() => {
    restoreLayout();
    vi.restoreAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render message history', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'Hello from user', role: 'user' }),
        createTestMessage({ content: 'Hello from assistant', role: 'assistant' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.getByText('Hello from user')).toBeInTheDocument();
      expect(screen.getByText('Hello from assistant')).toBeInTheDocument();
    });

    it('should have accessible region role', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'Test message' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.getByRole('region')).toBeInTheDocument();
    });

    it('should have aria-label for screen readers', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const region = screen.getByRole('region');
      expect(region).toHaveAttribute('aria-label', 'Message history');
    });
  });

  describe('Conversation pair grouping', () => {
    it('should display messages as conversation pair cards', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'User message', role: 'user' }),
        createTestMessage({ content: 'Assistant message', role: 'assistant' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // New structure uses conversation-pair-card instead of individual message elements
      const pairCard = screen.getByTestId('conversation-pair-card');
      expect(pairCard).toBeInTheDocument();
      // Check for user and assistant labels
      expect(screen.getByText('You')).toBeInTheDocument();
      expect(screen.getByText('Assistant')).toBeInTheDocument();
    });

    it('should show pending indicator for user message without response', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'Waiting for response', role: 'user' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.getByTestId('pending-indicator')).toBeInTheDocument();
    });
  });

  describe('File path click handling', () => {
    it('should detect file paths in content', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'Check this file: /path/to/file.ts' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const fileLink = screen.getByRole('button', { name: /\/path\/to\/file\.ts/i });
      expect(fileLink).toBeInTheDocument();
    });

    it('should call onFilePathClick when file path is clicked', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'Check this file: /path/to/file.ts' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const fileLink = screen.getByRole('button', { name: /\/path\/to\/file\.ts/i });
      fireEvent.click(fileLink);

      expect(mockOnFilePathClick).toHaveBeenCalledWith('/path/to/file.ts');
    });

    it('should handle multiple file paths in content', () => {
      const messages: ChatMessage[] = [
        createTestMessage({
          content: 'Files: /path/to/first.ts and /path/to/second.ts',
        }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const links = screen.getAllByRole('button');
      expect(links.length).toBeGreaterThanOrEqual(2);
    });

    it('should not detect non-file paths', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'This is just regular text with no paths', role: 'user' }),
        createTestMessage({ content: 'And a simple response', role: 'assistant' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Only expand/collapse button may be present, no file path buttons
      const buttons = screen.queryAllByRole('button');
      const filePathButtons = buttons.filter(btn =>
        btn.getAttribute('aria-label')?.includes('Open file:')
      );
      expect(filePathButtons.length).toBe(0);
    });
  });

  describe('Empty state', () => {
    it('should show empty state when no messages', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.getByText(/no messages|empty/i)).toBeInTheDocument();
    });

    it('should render container even when empty', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.getByRole('region')).toBeInTheDocument();
    });
  });

  describe('Loading state', () => {
    it('should show loading indicator when isLoading is true', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          isLoading={true}
        />
      );

      expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
    });

    it('should render card-shaped skeletons without naked loading text (Issue #1118)', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          isLoading={true}
        />
      );

      const indicator = screen.getByTestId('loading-indicator');
      expect(indicator.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
      expect(indicator.textContent).not.toContain('Loading');
    });

    it('should not show loading indicator when isLoading is false', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          isLoading={false}
        />
      );

      expect(screen.queryByTestId('loading-indicator')).not.toBeInTheDocument();
    });
  });

  describe('Independent scrolling', () => {
    // Issue #1019: The header and search bar are fixed rows; only the dedicated
    // inner scroll container scrolls, so messages never pass behind the header.
    it('should confine scrolling to the inner scroll container, not the outer region', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'Test message' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // The outer region only clips its rounded corners — it must NOT scroll.
      const region = screen.getByRole('region');
      expect(region.className).toMatch(/overflow-hidden/);
      expect(region.className).not.toMatch(/overflow-y-auto/);

      // The inner scroll container is the single vertical scroll surface.
      const scrollContainer = screen.getByTestId('history-scroll-container');
      expect(scrollContainer.className).toMatch(/overflow-y-auto/);
    });

    it('should have flexible height for scrolling on the scroll container', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'Test message' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Outer region keeps the flex column layout that pins the header rows.
      const region = screen.getByRole('region');
      expect(region.className).toMatch(/h-full|flex/);

      // Scroll container grows to fill the remaining space (flex-1 min-h-0).
      const scrollContainer = screen.getByTestId('history-scroll-container');
      expect(scrollContainer.className).toMatch(/flex-1/);
      expect(scrollContainer.className).toMatch(/min-h-0/);
    });
  });

  describe('Message ordering', () => {
    it('should display messages in chronological order', () => {
      const messages: ChatMessage[] = [
        createTestMessage({
          content: 'First message',
          role: 'user',
          timestamp: new Date('2024-01-01T10:00:00'),
        }),
        createTestMessage({
          content: 'First response',
          role: 'assistant',
          timestamp: new Date('2024-01-01T10:00:30'),
        }),
        createTestMessage({
          content: 'Second message',
          role: 'user',
          timestamp: new Date('2024-01-01T10:01:00'),
        }),
        createTestMessage({
          content: 'Second response',
          role: 'assistant',
          timestamp: new Date('2024-01-01T10:01:30'),
        }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const pairCards = screen.getAllByTestId('conversation-pair-card');
      expect(pairCards).toHaveLength(2);

      // Check first pair content
      expect(pairCards[0]).toHaveTextContent('First message');
      expect(pairCards[0]).toHaveTextContent('First response');

      // Check second pair content
      expect(pairCards[1]).toHaveTextContent('Second message');
      expect(pairCards[1]).toHaveTextContent('Second response');
    });
  });

  describe('Edge cases', () => {
    it('should handle very long messages', () => {
      const longContent = 'a'.repeat(10000);
      const messages: ChatMessage[] = [
        createTestMessage({ content: longContent }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.getByRole('region')).toBeInTheDocument();
    });

    it('should handle messages with special characters', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: '<div>HTML content</div>' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Should escape HTML and not render as actual HTML
      // The escaped version should be visible as text
      expect(screen.getByText('<div>HTML content</div>')).toBeInTheDocument();
      // The region should not contain raw HTML div tags (should be escaped)
      const region = screen.getByRole('region');
      // Check that there's no actual div with HTML content as its only text
      const htmlDivs = region.querySelectorAll('div');
      const hasRawHtmlDiv = Array.from(htmlDivs).some(
        (div) => div.textContent === 'HTML content' && div.children.length === 0
      );
      expect(hasRawHtmlDiv).toBe(false);
    });

    it('should handle Japanese characters', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'これは日本語のメッセージです' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.getByText('これは日本語のメッセージです')).toBeInTheDocument();
    });
  });

  describe('Insert to message propagation (Issue #485)', () => {
    it('should pass onInsertToMessage to ConversationPairCard', () => {
      const onInsertToMessage = vi.fn();
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'User message', role: 'user' }),
        createTestMessage({ content: 'Response', role: 'assistant' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          onInsertToMessage={onInsertToMessage}
        />
      );

      // The insert button should be rendered via ConversationPairCard
      const insertButton = screen.getByTestId('insert-user-message');
      expect(insertButton).toBeInTheDocument();
      fireEvent.click(insertButton);
      expect(onInsertToMessage).toHaveBeenCalledWith('User message');
    });

    it('should not render insert button when onInsertToMessage is not provided', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'User message', role: 'user' }),
        createTestMessage({ content: 'Response', role: 'assistant' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.queryByTestId('insert-user-message')).not.toBeInTheDocument();
    });
  });

  describe('className prop', () => {
    it('should accept additional className prop', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          className="custom-class"
        />
      );

      const region = screen.getByRole('region');
      expect(region.className).toContain('custom-class');
    });
  });

  // ============================================================================
  // [Issue #716] Search feature
  // ============================================================================

  describe('Search feature (Issue #716)', () => {
    it('does not render the search bar by default', () => {
      const messages: ChatMessage[] = [createTestMessage({ content: 'hello' })];
      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );
      expect(screen.queryByRole('search')).not.toBeInTheDocument();
    });

    it('renders a toggle button with Open search aria-label', () => {
      const messages: ChatMessage[] = [createTestMessage({ content: 'hello' })];
      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );
      const toggle = screen.getByRole('button', { name: /open search/i });
      expect(toggle).toBeInTheDocument();
    });

    it('toggles the search bar visibility and updates aria-label', () => {
      const messages: ChatMessage[] = [createTestMessage({ content: 'hello' })];
      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );
      const toggle = screen.getByRole('button', { name: /open search/i });
      fireEvent.click(toggle);

      expect(screen.getByRole('search')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /close search/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /close search/i }));
      expect(screen.queryByRole('search')).not.toBeInTheDocument();
    });

    it('exposes data-message-id on user message content for highlight targeting', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ id: 'user-1', content: 'sentinel', role: 'user' }),
      ];
      const { container } = render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );
      const el = container.querySelector('[data-message-id="user-1"]');
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain('sentinel');
    });

    it('exposes data-message-id on assistant message content for highlight targeting', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ id: 'u-1', content: 'q', role: 'user' }),
        createTestMessage({ id: 'a-1', content: 'sentinel answer', role: 'assistant' }),
      ];
      const { container } = render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );
      const el = container.querySelector('[data-message-id="a-1"]');
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain('sentinel answer');
    });
  });

  describe('Collapse button (Issue #727)', () => {
    it('does not render the collapse button when onCollapse is omitted', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );
      expect(screen.queryByTestId('history-pane-collapse-button')).not.toBeInTheDocument();
    });

    it('renders the collapse button when onCollapse is provided', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          onCollapse={() => {}}
        />
      );
      const btn = screen.getByTestId('history-pane-collapse-button');
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveAttribute('aria-controls', 'worktree-history-pane');
      expect(btn).toHaveAttribute('aria-expanded', 'true');
    });

    it('calls onCollapse when the collapse button is clicked', () => {
      const onCollapse = vi.fn();
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          onCollapse={onCollapse}
        />
      );
      fireEvent.click(screen.getByTestId('history-pane-collapse-button'));
      expect(onCollapse).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // [Issue #744] Per-split namespace + cliToolId props (additive / backward-compat)
  // ============================================================================

  describe('Per-split search namespace (Issue #744)', () => {
    beforeEach(() => {
      applyHistoryHighlightsSpy.mockClear();
      clearHistoryHighlightsSpy.mockClear();
    });

    function renderAndSearch(extraProps: Record<string, unknown>) {
      const messages: ChatMessage[] = [
        createTestMessage({ id: 'u-1', content: 'sentinel keyword here', role: 'user' }),
      ];
      const utils = render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          {...extraProps}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /open search/i }));
      const input = screen.getByLabelText('検索キーワード') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'sentinel' } });
      return utils;
    }

    it('uses the legacy global namespace when splitIndex is not provided (backward compat)', async () => {
      renderAndSearch({});
      await waitFor(() => {
        expect(applyHistoryHighlightsSpy).toHaveBeenCalled();
      });
      // 4th arg (namespace) is undefined → engine falls back to history-search.
      const namespaceArgs = applyHistoryHighlightsSpy.mock.calls.map((c) => c[3]);
      // No per-split namespace object should be passed.
      const hasPerSplit = namespaceArgs.some(
        (ns) =>
          ns &&
          typeof ns === 'object' &&
          'highlightName' in ns &&
          String((ns as { highlightName: string }).highlightName).startsWith(
            'history-search-'
          )
      );
      expect(hasPerSplit).toBe(false);
    });

    it('uses a per-split namespace (history-search-1) when splitIndex=1', async () => {
      renderAndSearch({ splitIndex: 1 });
      await waitFor(() => {
        expect(applyHistoryHighlightsSpy).toHaveBeenCalled();
      });
      const namespaceArgs = applyHistoryHighlightsSpy.mock.calls.map((c) => c[3]);
      const usedSplit1 = namespaceArgs.some(
        (ns) =>
          ns &&
          typeof ns === 'object' &&
          (ns as { highlightName?: string }).highlightName === 'history-search-1'
      );
      expect(usedSplit1).toBe(true);
    });

    it('accepts an optional cliToolId prop without altering rendering (no client-side filter)', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'visible message', role: 'user' }),
      ];
      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          splitIndex={0}
          cliToolId="codex"
        />
      );
      // S1-008: messages are pre-filtered by the caller's fetch; HistoryPane does
      // not drop messages by cliToolId, so all passed messages still render.
      expect(screen.getByText('visible message')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // [Issue #744] Per-split collapse button identity (no duplicate testids /
  // no dangling aria-controls when multiple splits are mounted simultaneously)
  // ============================================================================

  describe('Per-split collapse button identity (Issue #744)', () => {
    it('keeps the legacy testid + aria-controls=HISTORY_PANE_ID when splitIndex is omitted', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
          onCollapse={() => {}}
        />
      );
      const btn = screen.getByTestId('history-pane-collapse-button');
      expect(btn).toBeInTheDocument();
      // Legacy: points at the PC-wide history pane id (rendered by TerminalContainer).
      expect(btn).toHaveAttribute('aria-controls', 'worktree-history-pane');
    });

    it('suffixes the testid and points aria-controls at the per-split slot id when splitIndex is provided', () => {
      render(
        <div>
          {/* Simulate the per-split slot wrapper that TerminalSplitPaneContent
              renders, so aria-controls resolves to a real element. */}
          <div id="split-history-slot-0">
            <HistoryPane
              messages={[]}
              worktreeId={defaultWorktreeId}
              onFilePathClick={mockOnFilePathClick}
              onCollapse={() => {}}
              splitIndex={0}
              cliToolId="claude"
            />
          </div>
          <div id="split-history-slot-1">
            <HistoryPane
              messages={[]}
              worktreeId={defaultWorktreeId}
              onFilePathClick={mockOnFilePathClick}
              onCollapse={() => {}}
              splitIndex={1}
              cliToolId="codex"
            />
          </div>
        </div>
      );

      const btn0 = screen.getByTestId('history-pane-collapse-button-0');
      const btn1 = screen.getByTestId('history-pane-collapse-button-1');

      // Distinct per-split testids — no duplicate `history-pane-collapse-button`.
      expect(btn0).toBeInTheDocument();
      expect(btn1).toBeInTheDocument();
      expect(screen.queryByTestId('history-pane-collapse-button')).toBeNull();

      // aria-controls resolves to each split's own (real, non-dangling) slot id.
      expect(btn0).toHaveAttribute('aria-controls', 'split-history-slot-0');
      expect(btn1).toHaveAttribute('aria-controls', 'split-history-slot-1');
      expect(document.getElementById('split-history-slot-0')).not.toBeNull();
      expect(document.getElementById('split-history-slot-1')).not.toBeNull();

      // Neither split dangles at the PC-wide HISTORY_PANE_ID (not rendered on PC).
      expect(btn0).not.toHaveAttribute('aria-controls', 'worktree-history-pane');
      expect(btn1).not.toHaveAttribute('aria-controls', 'worktree-history-pane');
    });
  });
});
