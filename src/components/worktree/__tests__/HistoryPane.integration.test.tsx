/**
 * Integration tests for HistoryPane with ConversationPairCard
 *
 * Tests the integration of message grouping in HistoryPane
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HistoryPane } from '../HistoryPane';
import type { ChatMessage } from '@/types/models';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

// Helper to create test messages
function createTestMessage(
  role: 'user' | 'assistant',
  content: string,
  timestamp: Date,
  id?: string
): ChatMessage {
  return {
    id: id || `msg-${role}-${timestamp.getTime()}-${Math.random()}`,
    worktreeId: 'test-worktree',
    role,
    content,
    timestamp,
    messageType: 'normal',
    archived: false,
  };
}

// Test timestamps
const T1 = new Date('2024-01-01T10:00:00');
const T2 = new Date('2024-01-01T10:01:00');
const T3 = new Date('2024-01-01T10:02:00');
const T4 = new Date('2024-01-01T10:03:00');
const T5 = new Date('2024-01-01T10:04:00');
const T6 = new Date('2024-01-01T10:05:00');

describe('HistoryPane Integration', () => {
  const mockOnFilePathClick = vi.fn();

  // [Issue #1123] Virtualized list needs a non-zero viewport under jsdom.
  let restoreLayout: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreLayout = installVirtualLayout();
  });

  afterEach(() => {
    restoreLayout();
  });

  describe('conversation pair grouping', () => {
    it('should display messages grouped by conversation pairs', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1),
        createTestMessage('assistant', 'Hi there!', T2),
        createTestMessage('user', 'How are you?', T3),
        createTestMessage('assistant', 'I am fine.', T4),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Should have 2 conversation pair cards
      const pairCards = screen.getAllByTestId('conversation-pair-card');
      expect(pairCards).toHaveLength(2);
    });

    it('should display pending conversation when no assistant response', () => {
      const messages = [createTestMessage('user', 'Hello, waiting for response', T1)];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Should have pending indicator
      expect(screen.getByTestId('pending-indicator')).toBeInTheDocument();
    });

    it('should handle consecutive assistant messages', () => {
      const messages = [
        createTestMessage('user', 'Run the tests', T1),
        createTestMessage('assistant', 'Running tests...', T2),
        createTestMessage('assistant', 'Tests complete!', T3),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Should have only 1 conversation pair
      const pairCards = screen.getAllByTestId('conversation-pair-card');
      expect(pairCards).toHaveLength(1);

      // Should show both assistant messages
      expect(screen.getByText('Running tests...')).toBeInTheDocument();
      expect(screen.getByText('Tests complete!')).toBeInTheDocument();
    });

    it('should handle orphan assistant messages at the beginning', () => {
      const messages = [
        createTestMessage('assistant', 'Welcome! I am ready to help.', T1),
        createTestMessage('user', 'Hello', T2),
        createTestMessage('assistant', 'Hi there!', T3),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Should have 2 conversation pairs (1 orphan + 1 normal)
      const pairCards = screen.getAllByTestId('conversation-pair-card');
      expect(pairCards).toHaveLength(2);

      // Should show orphan indicator for system message
      expect(screen.getByTestId('orphan-indicator')).toBeInTheDocument();
      expect(screen.getByText(/System Message/i)).toBeInTheDocument();
    });
  });

  describe('file path click handling', () => {
    it('should maintain file path click functionality in grouped view', () => {
      const messages = [
        createTestMessage('user', 'Show the file', T1),
        createTestMessage('assistant', 'Here is the file: /src/test.ts', T2),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const fileLink = screen.getByRole('button', { name: /\/src\/test\.ts/i });
      fireEvent.click(fileLink);

      expect(mockOnFilePathClick).toHaveBeenCalledWith('/src/test.ts');
    });
  });

  describe('expand/collapse functionality', () => {
    it('should allow expanding long assistant messages', () => {
      const longContent = 'This is a long response. '.repeat(30);
      const messages = [
        createTestMessage('user', 'Give me a long response', T1),
        createTestMessage('assistant', longContent, T2),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Should have expand button
      const expandButton = screen.getByRole('button', { name: /expand/i });
      expect(expandButton).toBeInTheDocument();

      // Click to expand
      fireEvent.click(expandButton);

      // Button should now say collapse
      expect(screen.getByRole('button', { name: /collapse/i })).toBeInTheDocument();
    });
  });

  describe('empty and loading states', () => {
    it('should show empty state when no messages', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.getByText(/no messages/i)).toBeInTheDocument();
    });

    it('should show loading state when isLoading is true', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          isLoading={true}
        />
      );

      expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
    });
  });

  describe('message ordering', () => {
    it('should display pairs in chronological order', () => {
      const messages = [
        createTestMessage('user', 'Third message', T5),
        createTestMessage('assistant', 'Third response', T6),
        createTestMessage('user', 'First message', T1),
        createTestMessage('assistant', 'First response', T2),
        createTestMessage('user', 'Second message', T3),
        createTestMessage('assistant', 'Second response', T4),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const pairCards = screen.getAllByTestId('conversation-pair-card');
      expect(pairCards).toHaveLength(3);

      // Check order by content
      const allText = pairCards.map((card) => card.textContent).join('|');
      expect(allText.indexOf('First message')).toBeLessThan(
        allText.indexOf('Second message')
      );
      expect(allText.indexOf('Second message')).toBeLessThan(
        allText.indexOf('Third message')
      );
    });
  });

  describe('copy functionality', () => {
    it('should show copy buttons when showToast is provided', () => {
      const mockShowToast = vi.fn();
      const messages = [
        createTestMessage('user', 'Hello', T1),
        createTestMessage('assistant', 'Hi there!', T2),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          showToast={mockShowToast}
        />
      );

      expect(screen.getByTestId('copy-user-message')).toBeInTheDocument();
      expect(screen.getByTestId('copy-assistant-message')).toBeInTheDocument();
    });

    it('should call showToast with success on copy button click', async () => {
      const mockShowToast = vi.fn();
      // Mock clipboard API
      Object.assign(navigator, {
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      });

      const messages = [
        createTestMessage('user', 'Hello', T1),
        createTestMessage('assistant', 'Hi there!', T2),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          showToast={mockShowToast}
        />
      );

      fireEvent.click(screen.getByTestId('copy-user-message'));

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith('Copied to clipboard', 'success');
      });
    });

    it('should call showToast with error when clipboard fails', async () => {
      const mockShowToast = vi.fn();
      Object.assign(navigator, {
        clipboard: {
          writeText: vi.fn().mockRejectedValue(new Error('Clipboard denied')),
        },
      });

      const messages = [
        createTestMessage('user', 'Hello', T1),
        createTestMessage('assistant', 'Hi there!', T2),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          showToast={mockShowToast}
        />
      );

      fireEvent.click(screen.getByTestId('copy-user-message'));

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith('Failed to copy', 'error');
      });
    });

    it('should work without showToast (no toast feedback)', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1),
        createTestMessage('assistant', 'Hi there!', T2),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Copy buttons should still be present (onCopy is always provided by handleCopy)
      expect(screen.getByTestId('copy-user-message')).toBeInTheDocument();
      expect(screen.getByTestId('copy-assistant-message')).toBeInTheDocument();
    });
  });

  describe('Issue #1019: fixed header + isolated scroll region', () => {
    it('should keep the header outside the scroll container and messages inside it', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi there!', T2, 'asst-1'),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const scrollContainer = screen.getByTestId('history-scroll-container');

      // The header ("Message History") must NOT live inside the scroll region,
      // otherwise messages would scroll behind it (the Issue #1019 defect).
      const header = screen.getByText('Message History');
      expect(scrollContainer.contains(header)).toBe(false);

      // Messages must render inside the scroll region.
      const pairCard = screen.getByTestId('conversation-pair-card');
      expect(scrollContainer.contains(pairCard)).toBe(true);
    });

    it('should keep the search bar outside the scroll container when open', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi there!', T2, 'asst-1'),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Open the in-pane search bar.
      fireEvent.click(screen.getByRole('button', { name: /open search/i }));

      const scrollContainer = screen.getByTestId('history-scroll-container');
      const searchInput = screen.getByLabelText('検索キーワード');

      // The search bar is a fixed row above the scroll region, not inside it.
      expect(scrollContainer.contains(searchInput)).toBe(false);
    });
  });

  describe('Issue #725: User only filter', () => {
    it('should hide assistant message section when historyUserOnly is true', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi there!', T2, 'asst-1'),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          historyUserOnly={true}
          onHistoryUserOnlyChange={vi.fn()}
        />
      );

      // User message still visible
      expect(screen.getByText('Hello')).toBeInTheDocument();
      // Assistant content + label should be hidden
      expect(screen.queryByText('Hi there!')).not.toBeInTheDocument();
      expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
    });

    it('should still show assistant section when historyUserOnly is false', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi there!', T2, 'asst-1'),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          historyUserOnly={false}
          onHistoryUserOnlyChange={vi.fn()}
        />
      );

      expect(screen.getByText('Hello')).toBeInTheDocument();
      expect(screen.getByText('Hi there!')).toBeInTheDocument();
      expect(screen.getByText('Assistant')).toBeInTheDocument();
    });

    it('should skip orphan pairs (no userMessage) when historyUserOnly is true', () => {
      const messages = [
        // Orphan: assistant-only at the beginning
        createTestMessage('assistant', 'Welcome! I am ready to help.', T1, 'asst-orphan'),
        createTestMessage('user', 'Hello', T2, 'user-1'),
        createTestMessage('assistant', 'Hi there!', T3, 'asst-1'),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          historyUserOnly={true}
          onHistoryUserOnlyChange={vi.fn()}
        />
      );

      // Only one card (the user-pair) should render. Orphan is skipped.
      const pairCards = screen.getAllByTestId('conversation-pair-card');
      expect(pairCards).toHaveLength(1);

      // Orphan indicator and welcome content must not appear
      expect(screen.queryByTestId('orphan-indicator')).not.toBeInTheDocument();
      expect(screen.queryByText(/Welcome! I am ready to help/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/System Message/i)).not.toBeInTheDocument();
    });

    it('toggle button should reflect aria-pressed based on historyUserOnly', () => {
      const { rerender } = render(
        <HistoryPane
          messages={[]}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          historyUserOnly={false}
          onHistoryUserOnlyChange={vi.fn()}
        />
      );

      const offBtn = screen.getByRole('button', { name: /show user messages only/i });
      expect(offBtn).toHaveAttribute('aria-pressed', 'false');

      rerender(
        <HistoryPane
          messages={[]}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          historyUserOnly={true}
          onHistoryUserOnlyChange={vi.fn()}
        />
      );

      const onBtn = screen.getByRole('button', { name: /show user messages only/i });
      expect(onBtn).toHaveAttribute('aria-pressed', 'true');
    });

    it('should call onHistoryUserOnlyChange with negated value when toggle is clicked', () => {
      const handleChange = vi.fn();

      render(
        <HistoryPane
          messages={[]}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          historyUserOnly={false}
          onHistoryUserOnlyChange={handleChange}
        />
      );

      const toggleBtn = screen.getByRole('button', { name: /show user messages only/i });
      fireEvent.click(toggleBtn);
      expect(handleChange).toHaveBeenCalledWith(true);
    });

    it('should not render assistant section even when search query matches only assistant content (userOnly takes priority)', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'unique-assistant-text-xyz', T2, 'asst-1'),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
          historyUserOnly={true}
          onHistoryUserOnlyChange={vi.fn()}
        />
      );

      // Assistant content must not be present in the DOM (showAssistant=false)
      expect(screen.queryByText('unique-assistant-text-xyz')).not.toBeInTheDocument();
      // The user message still renders
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });

    it('should not render toggle button when onHistoryUserOnlyChange is not provided', () => {
      render(
        <HistoryPane
          messages={[]}
          worktreeId="test"
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(
        screen.queryByRole('button', { name: /show user messages only/i })
      ).not.toBeInTheDocument();
    });
  });
});
