/**
 * Integration tests for ConversationPairCard component
 *
 * Tests CSS constraints for long text wrapping and display
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import type { ConversationPair } from '@/types/conversation';

describe('ConversationPairCard', () => {
  const mockOnFilePathClick = vi.fn();

  const createMockPair = (overrides: Partial<ConversationPair> = {}): ConversationPair => ({
    id: 'pair-1',
    status: 'completed',
    userMessage: {
      id: 'user-1',
      worktreeId: 'wt-1',
      role: 'user',
      content: 'Hello',
      timestamp: new Date('2024-01-01T12:00:00Z'),
      messageType: 'normal',
    },
    assistantMessages: [
      {
        id: 'assistant-1',
        worktreeId: 'wt-1',
        role: 'assistant',
        content: 'Response',
        timestamp: new Date('2024-01-01T12:01:00Z'),
        messageType: 'normal',
      },
    ],
    ...overrides,
  });

  describe('CSS constraints for text wrapping', () => {
    it('should apply word-break constraint to assistant message container', () => {
      const pair = createMockPair({
        assistantMessages: [
          {
            id: 'assistant-1',
            worktreeId: 'wt-1',
            role: 'assistant',
            content: 'This is a long response with potentially long words and URLs',
            timestamp: new Date('2024-01-01T12:01:00Z'),
            messageType: 'normal',
          },
        ],
      });

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Find the assistant message container
      const assistantSection = screen.getByText('Assistant').closest('.assistant-message-item');
      expect(assistantSection).toBeTruthy();

      // Find the content container (sibling div with text)
      const contentContainer = assistantSection?.querySelector('.text-sm.text-gray-200');
      expect(contentContainer).toBeTruthy();

      // Check for required CSS classes for text wrapping (Safari compatible)
      expect(contentContainer?.className).toContain('whitespace-pre-wrap');
      expect(contentContainer?.className).toContain('break-words');
      // Check for word-break:break-word (Safari compatible alternative to overflow-wrap:anywhere)
      expect(contentContainer?.className).toContain('[word-break:break-word]');
      expect(contentContainer?.className).toContain('max-w-full');
      expect(contentContainer?.className).toContain('overflow-x-hidden');
    });

    it('should handle very long URLs without horizontal overflow', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(200) + '/path/to/file.txt';
      const pair = createMockPair({
        assistantMessages: [
          {
            id: 'assistant-1',
            worktreeId: 'wt-1',
            role: 'assistant',
            content: `Check this file: ${longUrl}`,
            timestamp: new Date('2024-01-01T12:01:00Z'),
            messageType: 'normal',
          },
        ],
      });

      const { container } = render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // Verify the content is rendered
      const card = container.querySelector('[data-testid="conversation-pair-card"]');
      expect(card).toBeTruthy();

      // Verify assistant section has overflow-x-hidden
      const assistantSection = card?.querySelector('.assistant-message-item');
      const contentContainer = assistantSection?.querySelector('.text-sm.text-gray-200');
      expect(contentContainer?.className).toContain('overflow-x-hidden');
    });

    it('should handle code blocks with long lines', () => {
      const longCodeLine = 'const veryLongVariableName = "' + 'x'.repeat(300) + '";';
      const pair = createMockPair({
        assistantMessages: [
          {
            id: 'assistant-1',
            worktreeId: 'wt-1',
            role: 'assistant',
            content: `Here is the code:\n${longCodeLine}`,
            timestamp: new Date('2024-01-01T12:01:00Z'),
            messageType: 'normal',
          },
        ],
      });

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // The content should be rendered without throwing
      expect(screen.getByText('Assistant')).toBeInTheDocument();
    });

    it('should handle mixed Japanese and ASCII text correctly', () => {
      const mixedContent = 'This is a test with Japanese: これは日本語のテストです。And some ASCII text that continues on.';
      const pair = createMockPair({
        assistantMessages: [
          {
            id: 'assistant-1',
            worktreeId: 'wt-1',
            role: 'assistant',
            content: mixedContent,
            timestamp: new Date('2024-01-01T12:01:00Z'),
            messageType: 'normal',
          },
        ],
      });

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // The content should be rendered
      expect(screen.getByText('Assistant')).toBeInTheDocument();
    });
  });

  describe('User message rendering', () => {
    it('should render user message with correct CSS classes', () => {
      const pair = createMockPair();

      render(
        <ConversationPairCard
          pair={pair}
          onFilePathClick={mockOnFilePathClick}
        />
      );

      // User message should also have word-break classes
      const userSection = screen.getByText('You').closest('.bg-blue-900\\/30');
      expect(userSection).toBeTruthy();

      const userContentContainer = userSection?.querySelector('.text-sm.text-gray-200');
      expect(userContentContainer).toBeTruthy();
      expect(userContentContainer?.className).toContain('whitespace-pre-wrap');
      expect(userContentContainer?.className).toContain('break-words');
    });
  });
});
