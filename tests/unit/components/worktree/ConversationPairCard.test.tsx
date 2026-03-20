/**
 * Tests for ConversationPairCard component
 *
 * Tests insert-to-message button functionality (Issue #485).
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import type { ConversationPair } from '@/types/conversation';
import type { ChatMessage } from '@/types/models';

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? `msg-${Date.now()}`,
    worktreeId: 'test-worktree',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'Test message',
    timestamp: overrides.timestamp ?? new Date('2024-01-01T10:00:00'),
    messageType: 'normal',
    archived: false,
    ...overrides,
  };
}

describe('ConversationPairCard', () => {
  const defaultPair: ConversationPair = {
    id: 'pair-1',
    userMessage: createMessage({ id: 'user-1', role: 'user', content: 'Hello world' }),
    assistantMessages: [
      createMessage({ id: 'asst-1', role: 'assistant', content: 'Hi there' }),
    ],
    status: 'completed',
  };

  const defaultProps = {
    pair: defaultPair,
    onFilePathClick: vi.fn(),
    onCopy: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Insert to message button (Issue #485)', () => {
    it('should render insert button when onInsertToMessage is provided', () => {
      const onInsert = vi.fn();
      render(
        <ConversationPairCard
          {...defaultProps}
          onInsertToMessage={onInsert}
        />
      );

      expect(screen.getByTestId('insert-user-message')).toBeInTheDocument();
    });

    it('should not render insert button when onInsertToMessage is not provided', () => {
      render(<ConversationPairCard {...defaultProps} />);

      expect(screen.queryByTestId('insert-user-message')).not.toBeInTheDocument();
    });

    it('should call onInsertToMessage with user message content when insert button is clicked', () => {
      const onInsert = vi.fn();
      render(
        <ConversationPairCard
          {...defaultProps}
          onInsertToMessage={onInsert}
        />
      );

      fireEvent.click(screen.getByTestId('insert-user-message'));
      expect(onInsert).toHaveBeenCalledWith('Hello world');
    });

    it('should not render insert button for orphan pairs (no user message)', () => {
      const orphanPair: ConversationPair = {
        id: 'pair-orphan',
        userMessage: null,
        assistantMessages: [
          createMessage({ id: 'asst-orphan', role: 'assistant', content: 'System message' }),
        ],
        status: 'orphan',
      };

      const onInsert = vi.fn();
      render(
        <ConversationPairCard
          {...defaultProps}
          pair={orphanPair}
          onInsertToMessage={onInsert}
        />
      );

      expect(screen.queryByTestId('insert-user-message')).not.toBeInTheDocument();
    });
  });

  describe('Basic rendering', () => {
    it('should render conversation pair card', () => {
      render(<ConversationPairCard {...defaultProps} />);
      expect(screen.getByTestId('conversation-pair-card')).toBeInTheDocument();
    });

    it('should render user message content', () => {
      render(<ConversationPairCard {...defaultProps} />);
      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });

    it('should render assistant message content', () => {
      render(<ConversationPairCard {...defaultProps} />);
      expect(screen.getByText('Hi there')).toBeInTheDocument();
    });
  });
});
