/**
 * Integration tests for HistoryPane with ConversationPairCard
 *
 * Tests the integration of message grouping in HistoryPane
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryPane } from '../HistoryPane';
import type { ChatMessage } from '@/types/models';

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

  beforeEach(() => {
    vi.clearAllMocks();
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
});
