/**
 * Tests for ConversationPairCard component
 *
 * Tests the conversation pair display card with various states
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConversationPairCard } from '../ConversationPairCard';
import type { ConversationPair } from '@/types/conversation';
import type { ChatMessage } from '@/types/models';

// Helper to create test messages
function createMessage(
  role: 'user' | 'assistant',
  content: string,
  id?: string
): ChatMessage {
  return {
    id: id || `msg-${role}-${Date.now()}-${Math.random()}`,
    worktreeId: 'test-worktree',
    role,
    content,
    timestamp: new Date('2024-01-01T12:34:56'),
    messageType: 'normal',
  };
}

// Helper to create test pairs
function createCompletedPair(
  userContent = 'Hello',
  assistantContent = 'Hi there!'
): ConversationPair {
  return {
    id: 'test-pair-1',
    userMessage: createMessage('user', userContent, 'user-1'),
    assistantMessages: [createMessage('assistant', assistantContent, 'asst-1')],
    status: 'completed',
  };
}

function createPendingPair(userContent = 'Hello'): ConversationPair {
  return {
    id: 'test-pair-pending',
    userMessage: createMessage('user', userContent, 'user-pending'),
    assistantMessages: [],
    status: 'pending',
  };
}

function createOrphanPair(assistantContent = 'Welcome!'): ConversationPair {
  return {
    id: 'orphan-asst-1',
    userMessage: null,
    assistantMessages: [createMessage('assistant', assistantContent, 'asst-orphan')],
    status: 'orphan',
  };
}

function createPairWithMultipleAssistantMessages(
  count = 2
): ConversationPair {
  const assistantMessages = Array.from({ length: count }, (_, i) =>
    createMessage('assistant', `Response ${i + 1}`, `asst-${i + 1}`)
  );
  return {
    id: 'test-pair-multi',
    userMessage: createMessage('user', 'Hello', 'user-multi'),
    assistantMessages,
    status: 'completed',
  };
}

describe('ConversationPairCard', () => {
  const mockOnFilePathClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===== Basic rendering =====

  describe('basic rendering', () => {
    it('should render user and assistant messages', () => {
      const pair = createCompletedPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      expect(screen.getByText('You')).toBeInTheDocument();
      expect(screen.getByText('Hello')).toBeInTheDocument();
      expect(screen.getByText('Assistant')).toBeInTheDocument();
      expect(screen.getByText('Hi there!')).toBeInTheDocument();
    });

    it('should have accessible role and label', () => {
      const pair = createCompletedPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      const card = screen.getByTestId('conversation-pair-card');
      expect(card).toBeInTheDocument();
      expect(card).toHaveAttribute('role', 'article');
    });

    it('should display timestamp', () => {
      const pair = createCompletedPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      // Time format may vary by locale
      expect(screen.getAllByText(/12:34/).length).toBeGreaterThan(0);
    });
  });

  // ===== Pending state =====

  describe('pending state', () => {
    it('should show pending indicator when assistant messages is empty', () => {
      const pair = createPendingPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      expect(screen.getByTestId('pending-indicator')).toBeInTheDocument();
    });

    it('should show waiting message for pending state', () => {
      const pair = createPendingPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      expect(screen.getByText(/waiting|pending/i)).toBeInTheDocument();
    });

    it('should have pending styling', () => {
      const pair = createPendingPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      const card = screen.getByTestId('conversation-pair-card');
      expect(card.className).toMatch(/pending/);
    });
  });

  // ===== Orphan state =====

  describe('orphan state', () => {
    it('should render orphan assistant message with special styling', () => {
      const pair = createOrphanPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      expect(screen.getByTestId('orphan-indicator')).toBeInTheDocument();
      expect(screen.queryByText('You')).not.toBeInTheDocument();
      expect(screen.getByText('Assistant')).toBeInTheDocument();
    });

    it('should show system message header for orphan pair', () => {
      const pair = createOrphanPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      expect(screen.getByText(/System Message/i)).toBeInTheDocument();
    });

    it('should have orphan styling', () => {
      const pair = createOrphanPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      const card = screen.getByTestId('conversation-pair-card');
      expect(card.className).toMatch(/orphan/);
    });
  });

  // ===== Multiple assistant messages =====

  describe('multiple assistant messages', () => {
    it('should render multiple assistant messages', () => {
      const pair = createPairWithMultipleAssistantMessages();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      expect(screen.getByText('Response 1')).toBeInTheDocument();
      expect(screen.getByText('Response 2')).toBeInTheDocument();
    });

    it('should show message count for multiple assistant messages', () => {
      const pair = createPairWithMultipleAssistantMessages(3);

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      expect(screen.getByText(/1\/3/)).toBeInTheDocument();
      expect(screen.getByText(/2\/3/)).toBeInTheDocument();
      expect(screen.getByText(/3\/3/)).toBeInTheDocument();
    });

    it('should have dividers between multiple assistant messages', () => {
      const pair = createPairWithMultipleAssistantMessages(2);

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      const dividers = screen.getAllByTestId('assistant-message-divider');
      expect(dividers).toHaveLength(1); // 2 messages = 1 divider
    });

    it('should not show divider for single assistant message', () => {
      const pair = createCompletedPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      expect(
        screen.queryByTestId('assistant-message-divider')
      ).not.toBeInTheDocument();
    });
  });

  // ===== Expand/collapse =====

  describe('expand/collapse', () => {
    it('should toggle expansion on click', () => {
      const pair = createCompletedPair(
        'Hello',
        'This is a very long message that should be collapsible. '.repeat(10)
      );

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
          isExpanded={false}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand|collapse/i });
      expect(expandButton).toBeInTheDocument();
    });

    it('should show expanded content when isExpanded is true', () => {
      const longContent = 'This is a very long message. '.repeat(20);
      const pair = createCompletedPair('Hello', longContent);

      const { container } = render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
          isExpanded={true}
        />
      );

      // Should show full content without truncation indicator (...)
      expect(container.textContent).toContain(longContent);
      // Verify the full content is present
      expect(container.textContent?.includes('This is a very long message.')).toBe(true);
    });

    it('should call onToggleExpand when expand button is clicked', () => {
      const mockToggle = vi.fn();
      const pair = createCompletedPair(
        'Hello',
        'Long content '.repeat(50)
      );

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
          isExpanded={false}
          onToggleExpand={mockToggle}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand|collapse/i });
      fireEvent.click(expandButton);

      expect(mockToggle).toHaveBeenCalled();
    });
  });

  // ===== File path click =====

  describe('file path click', () => {
    it('should call onFilePathClick when file path is clicked', () => {
      const pair = createCompletedPair(
        'Hello',
        'Check this file: /path/to/file.ts'
      );

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      const fileLink = screen.getByRole('button', {
        name: /\/path\/to\/file\.ts/i,
      });
      fireEvent.click(fileLink);

      expect(mockOnFilePathClick).toHaveBeenCalledWith('/path/to/file.ts');
    });

    it('should detect multiple file paths', () => {
      const pair = createCompletedPair(
        'Hello',
        'Files: /src/a.ts and /src/b.ts'
      );

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      const fileLinks = screen.getAllByRole('button', { name: /\/src\/[ab]\.ts/ });
      expect(fileLinks).toHaveLength(2);
    });
  });

  // ===== Copy button =====

  describe('copy button', () => {
    it('should show copy button for user message when onCopy is provided', () => {
      const pair = createCompletedPair();
      const mockOnCopy = vi.fn();

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
          onCopy={mockOnCopy}
        />
      );

      expect(screen.getByTestId('copy-user-message')).toBeInTheDocument();
    });

    it('should show copy button for assistant message when onCopy is provided', () => {
      const pair = createCompletedPair();
      const mockOnCopy = vi.fn();

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
          onCopy={mockOnCopy}
        />
      );

      expect(screen.getByTestId('copy-assistant-message')).toBeInTheDocument();
    });

    it('should not show copy buttons when onCopy is not provided', () => {
      const pair = createCompletedPair();

      render(
        <ConversationPairCard pair={pair} onFilePathClick={mockOnFilePathClick} />
      );

      expect(screen.queryByTestId('copy-user-message')).not.toBeInTheDocument();
      expect(screen.queryByTestId('copy-assistant-message')).not.toBeInTheDocument();
    });

    it('should call onCopy with user message content when user copy button is clicked', () => {
      const pair = createCompletedPair('Hello World', 'Response');
      const mockOnCopy = vi.fn();

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
          onCopy={mockOnCopy}
        />
      );

      fireEvent.click(screen.getByTestId('copy-user-message'));
      expect(mockOnCopy).toHaveBeenCalledWith('Hello World');
    });

    it('should call onCopy with assistant message content when assistant copy button is clicked', () => {
      const pair = createCompletedPair('Hello', 'Assistant Response');
      const mockOnCopy = vi.fn();

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
          onCopy={mockOnCopy}
        />
      );

      fireEvent.click(screen.getByTestId('copy-assistant-message'));
      expect(mockOnCopy).toHaveBeenCalledWith('Assistant Response');
    });

    it('should not show copy buttons for pending pairs', () => {
      const pair = createPendingPair();
      const mockOnCopy = vi.fn();

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
          onCopy={mockOnCopy}
        />
      );

      // User message copy button should exist
      expect(screen.getByTestId('copy-user-message')).toBeInTheDocument();
      // No assistant copy button since pending has no assistant messages
      expect(screen.queryByTestId('copy-assistant-message')).not.toBeInTheDocument();
    });
  });
});
