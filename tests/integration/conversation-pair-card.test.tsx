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

// Issue #1276: the "You" / "Assistant" role labels resolve through the
// dictionary now. The global mock echoes `worktree.conversation.you`, so these
// role-label lookups need the real dictionary to keep meaning what they say.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

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
      archived: false,
    },
    assistantMessages: [
      {
        id: 'assistant-1',
        worktreeId: 'wt-1',
        role: 'assistant',
        content: 'Response',
        timestamp: new Date('2024-01-01T12:01:00Z'),
        messageType: 'normal',
        archived: false,
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
            archived: false,
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
      // Issue #725 weakened assistant style to text-xs; Issue #1075 (#1091) then
      // migrated the raw text-gray-300 to the theme-following `text-foreground`
      // token (Issue #1102: selector updated to match).
      const contentContainer = assistantSection?.querySelector('.text-xs.text-foreground');
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
            archived: false,
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

      // Verify assistant section has overflow-x-hidden. Content class migrated to
      // the `text-foreground` token in Issue #1075 (#1091) (Issue #1102).
      const assistantSection = card?.querySelector('.assistant-message-item');
      const contentContainer = assistantSection?.querySelector('.text-xs.text-foreground');
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
            archived: false,
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
            archived: false,
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

      // User message should also have word-break classes. Issue #1075 (#1091)
      // migrated the user bubble to accent tokens (bg-accent-500/10) and the
      // content to `text-foreground` (Issue #1102: selectors updated to match).
      const userSection = screen.getByText('You').closest('.bg-accent-500\\/10');
      expect(userSection).toBeTruthy();

      const userContentContainer = userSection?.querySelector('.text-sm.text-foreground');
      expect(userContentContainer).toBeTruthy();
      expect(userContentContainer?.className).toContain('whitespace-pre-wrap');
      expect(userContentContainer?.className).toContain('break-words');
    });
  });
});
