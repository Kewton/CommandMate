/**
 * Tests for conversation-grouper module
 *
 * Tests message grouping logic for conversation history display
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@/types/models';
import type { ConversationPair } from '@/types/conversation';
import {
  groupMessagesIntoPairs,
  isCompletedPair,
  isPendingPair,
  isOrphanPair,
  getCombinedAssistantContent,
} from '../conversation-grouper';

// Test timestamps
const T1 = new Date('2024-01-01T10:00:00');
const T2 = new Date('2024-01-01T10:01:00');
const T3 = new Date('2024-01-01T10:02:00');
const T4 = new Date('2024-01-01T10:03:00');
const T5 = new Date('2024-01-01T10:04:00');

// Helper to create test messages
function createMessage(
  role: 'user' | 'assistant',
  content: string,
  timestamp: Date,
  id?: string
): ChatMessage {
  return {
    id: id || `msg-${role}-${timestamp.getTime()}`,
    worktreeId: 'test-worktree',
    role,
    content,
    timestamp,
    messageType: 'normal',
  };
}

describe('groupMessagesIntoPairs', () => {
  // ===== Basic grouping =====

  describe('basic grouping', () => {
    it('should group user-assistant messages into pairs', () => {
      const messages = [
        createMessage('user', 'Hello', T1),
        createMessage('assistant', 'Hi there!', T2),
        createMessage('user', 'How are you?', T3),
        createMessage('assistant', 'I am fine.', T4),
      ];

      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(2);
      expect(pairs[0].userMessage?.content).toBe('Hello');
      expect(pairs[0].assistantMessages[0].content).toBe('Hi there!');
      expect(pairs[0].status).toBe('completed');
      expect(pairs[1].userMessage?.content).toBe('How are you?');
      expect(pairs[1].assistantMessages[0].content).toBe('I am fine.');
      expect(pairs[1].status).toBe('completed');
    });

    it('should handle pending responses', () => {
      const messages = [createMessage('user', 'Hello', T1)];

      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].status).toBe('pending');
      expect(pairs[0].assistantMessages).toEqual([]);
      expect(pairs[0].userMessage?.content).toBe('Hello');
    });

    it('should use user message id as pair id', () => {
      const messages = [
        createMessage('user', 'Hello', T1, 'user-msg-123'),
        createMessage('assistant', 'Hi!', T2),
      ];

      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs[0].id).toBe('user-msg-123');
    });
  });

  // ===== Consecutive assistant messages (MF-1) =====

  describe('consecutive assistant messages', () => {
    it('should handle consecutive assistant messages in same pair', () => {
      const messages = [
        createMessage('user', 'Create a file', T1),
        createMessage('assistant', 'Creating file...', T2),
        createMessage('assistant', 'File created successfully!', T3),
      ];

      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].assistantMessages).toHaveLength(2);
      expect(pairs[0].assistantMessages[0].content).toBe('Creating file...');
      expect(pairs[0].assistantMessages[1].content).toBe(
        'File created successfully!'
      );
      expect(pairs[0].status).toBe('completed');
    });

    it('should handle multiple consecutive assistant messages', () => {
      const messages = [
        createMessage('user', 'Run tests', T1),
        createMessage('assistant', 'Running tests...', T2),
        createMessage('assistant', 'Test 1 passed', T3),
        createMessage('assistant', 'Test 2 passed', T4),
        createMessage('assistant', 'All tests passed!', T5),
      ];

      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].assistantMessages).toHaveLength(4);
    });

    it('should handle new user message after consecutive assistant messages', () => {
      const messages = [
        createMessage('user', 'First question', T1),
        createMessage('assistant', 'Response 1', T2),
        createMessage('assistant', 'Response 2', T3),
        createMessage('user', 'Second question', T4),
        createMessage('assistant', 'Response 3', T5),
      ];

      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(2);
      expect(pairs[0].assistantMessages).toHaveLength(2);
      expect(pairs[1].assistantMessages).toHaveLength(1);
    });
  });

  // ===== Orphan assistant messages (MF-2) =====

  describe('orphan assistant messages', () => {
    it('should handle orphan assistant messages at the beginning', () => {
      const messages = [
        createMessage('assistant', 'Welcome! How can I help?', T1, 'orphan-1'),
        createMessage('user', 'Hello', T2),
        createMessage('assistant', 'Hi there!', T3),
      ];

      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(2);
      // First is orphan message
      expect(pairs[0].userMessage).toBeNull();
      expect(pairs[0].assistantMessages[0].content).toBe(
        'Welcome! How can I help?'
      );
      expect(pairs[0].status).toBe('orphan');
      expect(pairs[0].id).toBe('orphan-orphan-1');
      // Second is normal conversation
      expect(pairs[1].userMessage?.content).toBe('Hello');
      expect(pairs[1].status).toBe('completed');
    });

    it('should group consecutive orphan assistant messages together', () => {
      const messages = [
        createMessage('assistant', 'System initialized', T1),
        createMessage('assistant', 'Ready to assist', T2),
        createMessage('user', 'Hello', T3),
      ];

      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(2);
      // Orphan messages in one pair
      expect(pairs[0].userMessage).toBeNull();
      expect(pairs[0].assistantMessages).toHaveLength(2);
      expect(pairs[0].status).toBe('orphan');
    });
  });

  // ===== Edge cases =====

  describe('edge cases', () => {
    it('should handle out-of-order timestamps gracefully', () => {
      const messages = [
        createMessage('assistant', 'Response', T2), // Out of order
        createMessage('user', 'Question', T1),
      ];

      const pairs = groupMessagesIntoPairs(messages);

      // Should be sorted by timestamp and grouped correctly
      expect(pairs).toHaveLength(1);
      expect(pairs[0].userMessage?.content).toBe('Question');
      expect(pairs[0].assistantMessages[0].content).toBe('Response');
    });

    it('should handle empty messages array', () => {
      const pairs = groupMessagesIntoPairs([]);
      expect(pairs).toHaveLength(0);
    });

    it('should handle single user message', () => {
      const messages = [createMessage('user', 'Hello', T1)];
      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].status).toBe('pending');
    });

    it('should handle single assistant message', () => {
      const messages = [createMessage('assistant', 'Hello', T1, 'single-a')];
      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].status).toBe('orphan');
      expect(pairs[0].userMessage).toBeNull();
      expect(pairs[0].id).toBe('orphan-single-a');
    });

    it('should handle multiple pending pairs', () => {
      const messages = [
        createMessage('user', 'First', T1),
        createMessage('user', 'Second', T2),
        createMessage('user', 'Third', T3),
      ];

      const pairs = groupMessagesIntoPairs(messages);

      expect(pairs).toHaveLength(3);
      expect(pairs[0].status).toBe('pending');
      expect(pairs[1].status).toBe('pending');
      expect(pairs[2].status).toBe('pending');
    });
  });
});

// ===== Helper functions tests =====

describe('ConversationPair helpers', () => {
  // Helper to create a pair for testing
  function createPair(
    userContent: string | null,
    assistantContents: string[],
    status: 'pending' | 'completed' | 'orphan'
  ): ConversationPair {
    return {
      id: 'test-pair',
      userMessage: userContent
        ? createMessage('user', userContent, T1)
        : null,
      assistantMessages: assistantContents.map((content, i) =>
        createMessage('assistant', content, new Date(T1.getTime() + (i + 1) * 60000))
      ),
      status,
    };
  }

  describe('isCompletedPair', () => {
    it('should return true for completed pairs', () => {
      const pair = createPair('user', ['assistant'], 'completed');
      expect(isCompletedPair(pair)).toBe(true);
    });

    it('should return false for pending pairs', () => {
      const pair = createPair('user', [], 'pending');
      expect(isCompletedPair(pair)).toBe(false);
    });

    it('should return false for orphan pairs', () => {
      const pair = createPair(null, ['assistant'], 'orphan');
      expect(isCompletedPair(pair)).toBe(false);
    });
  });

  describe('isPendingPair', () => {
    it('should return true for pending pairs', () => {
      const pair = createPair('user', [], 'pending');
      expect(isPendingPair(pair)).toBe(true);
    });

    it('should return false for completed pairs', () => {
      const pair = createPair('user', ['assistant'], 'completed');
      expect(isPendingPair(pair)).toBe(false);
    });

    it('should return false for orphan pairs', () => {
      const pair = createPair(null, ['assistant'], 'orphan');
      expect(isPendingPair(pair)).toBe(false);
    });
  });

  describe('isOrphanPair', () => {
    it('should return true for orphan pairs', () => {
      const pair = createPair(null, ['assistant'], 'orphan');
      expect(isOrphanPair(pair)).toBe(true);
    });

    it('should return false for completed pairs', () => {
      const pair = createPair('user', ['assistant'], 'completed');
      expect(isOrphanPair(pair)).toBe(false);
    });

    it('should return false for pending pairs', () => {
      const pair = createPair('user', [], 'pending');
      expect(isOrphanPair(pair)).toBe(false);
    });
  });

  describe('getCombinedAssistantContent', () => {
    it('should join multiple messages with separator', () => {
      const pair = createPair('user', ['Part 1', 'Part 2'], 'completed');

      const combined = getCombinedAssistantContent(pair);
      expect(combined).toBe('Part 1\n\n---\n\nPart 2');
    });

    it('should return single message as is', () => {
      const pair = createPair('user', ['Single response'], 'completed');

      const combined = getCombinedAssistantContent(pair);
      expect(combined).toBe('Single response');
    });

    it('should return empty string for no assistant messages', () => {
      const pair = createPair('user', [], 'pending');

      const combined = getCombinedAssistantContent(pair);
      expect(combined).toBe('');
    });

    it('should handle multiple consecutive messages', () => {
      const pair = createPair(
        'user',
        ['First', 'Second', 'Third'],
        'completed'
      );

      const combined = getCombinedAssistantContent(pair);
      expect(combined).toBe('First\n\n---\n\nSecond\n\n---\n\nThird');
    });
  });
});
