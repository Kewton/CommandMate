/**
 * Tests for HistoryPane component
 *
 * Tests the message history display with independent scrolling and file path click handling
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import type { ChatMessage } from '@/types/models';

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
    ...overrides,
  };
}

describe('HistoryPane', () => {
  const mockOnFilePathClick = vi.fn();
  const defaultWorktreeId = 'test-worktree';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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

  describe('Message styling by role', () => {
    it('should apply user role styling', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'User message', role: 'user' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const messageElement = screen.getByTestId('message-user');
      expect(messageElement).toBeInTheDocument();
      expect(messageElement.className).toMatch(/user|blue|right/i);
    });

    it('should apply assistant role styling', () => {
      const messages: ChatMessage[] = [
        createTestMessage({ content: 'Assistant message', role: 'assistant' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const messageElement = screen.getByTestId('message-assistant');
      expect(messageElement).toBeInTheDocument();
      expect(messageElement.className).toMatch(/assistant|gray|left/i);
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
        createTestMessage({ content: 'This is just regular text with no paths' }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
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

      expect(screen.getByText(/no messages|empty|履歴がありません/i)).toBeInTheDocument();
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
    it('should have overflow-y-auto for independent scrolling', () => {
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

      const region = screen.getByRole('region');
      expect(region.className).toMatch(/overflow/);
    });

    it('should have flexible height for scrolling', () => {
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

      const region = screen.getByRole('region');
      expect(region.className).toMatch(/h-full|flex|min-h/);
    });
  });

  describe('Message ordering', () => {
    it('should display messages in chronological order', () => {
      const messages: ChatMessage[] = [
        createTestMessage({
          content: 'First message',
          timestamp: new Date('2024-01-01T10:00:00'),
        }),
        createTestMessage({
          content: 'Second message',
          timestamp: new Date('2024-01-01T10:01:00'),
        }),
        createTestMessage({
          content: 'Third message',
          timestamp: new Date('2024-01-01T10:02:00'),
        }),
      ];

      render(
        <HistoryPane
          messages={messages}
          worktreeId={defaultWorktreeId}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      const messageContents = screen.getAllByTestId(/message-/);
      expect(messageContents[0]).toHaveTextContent('First message');
      expect(messageContents[2]).toHaveTextContent('Third message');
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
      const region = screen.getByRole('region');
      expect(region.innerHTML).not.toContain('<div>HTML content</div>');
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
});
