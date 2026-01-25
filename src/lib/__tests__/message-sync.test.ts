/**
 * Tests for message-sync module
 * Issue #54: Message synchronization utilities
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  mergeMessages,
  addOptimisticMessage,
  confirmOptimisticMessage,
  removeOptimisticMessage,
  MAX_MESSAGES,
} from '../message-sync';
import type { ChatMessage } from '@/types/models';

// Helper to create test messages
function createTestMessage(
  id: string,
  role: 'user' | 'assistant' = 'user',
  timestamp: Date = new Date()
): ChatMessage {
  return {
    id,
    worktreeId: 'test-worktree',
    role,
    content: `Test message ${id}`,
    timestamp,
    messageType: 'normal',
  };
}

describe('message-sync', () => {
  describe('MAX_MESSAGES', () => {
    it('should be 200', () => {
      expect(MAX_MESSAGES).toBe(200);
    });
  });

  describe('mergeMessages', () => {
    it('should merge messages without duplicates', () => {
      const existing = [
        createTestMessage('1', 'user', new Date('2026-01-15T10:00:00Z')),
      ];
      const incoming = [
        createTestMessage('1', 'user', new Date('2026-01-15T10:00:00Z')), // duplicate
        createTestMessage('2', 'assistant', new Date('2026-01-15T10:01:00Z')),
      ];

      const result = mergeMessages(existing, incoming);

      expect(result).toHaveLength(2);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });

    it('should sort messages by timestamp', () => {
      const existing = [
        createTestMessage('1', 'user', new Date('2026-01-15T10:05:00Z')),
      ];
      const incoming = [
        createTestMessage('2', 'assistant', new Date('2026-01-15T10:00:00Z')), // earlier
        createTestMessage('3', 'user', new Date('2026-01-15T10:10:00Z')), // later
      ];

      const result = mergeMessages(existing, incoming);

      expect(result.map(m => m.id)).toEqual(['2', '1', '3']);
    });

    it('should respect max limit and remove old messages', () => {
      const existing = Array.from({ length: 200 }, (_, i) =>
        createTestMessage(`old-${i}`, 'user', new Date(Date.now() + i * 1000))
      );
      const incoming = [
        createTestMessage('new-1', 'user', new Date(Date.now() + 300000)),
      ];

      const result = mergeMessages(existing, incoming, 200);

      expect(result).toHaveLength(200);
      // Should keep newest messages
      expect(result.some(m => m.id === 'new-1')).toBe(true);
      // Should remove oldest
      expect(result.some(m => m.id === 'old-0')).toBe(false);
    });

    it('should use default max limit when not specified', () => {
      const existing = Array.from({ length: 250 }, (_, i) =>
        createTestMessage(`msg-${i}`, 'user', new Date(Date.now() + i * 1000))
      );

      const result = mergeMessages(existing, []);

      expect(result).toHaveLength(MAX_MESSAGES); // 200
    });

    it('should handle empty arrays', () => {
      expect(mergeMessages([], [])).toEqual([]);
      expect(mergeMessages([], [createTestMessage('1')])).toHaveLength(1);
      expect(mergeMessages([createTestMessage('1')], [])).toHaveLength(1);
    });

    it('should allow custom max limit', () => {
      const existing = Array.from({ length: 10 }, (_, i) =>
        createTestMessage(`msg-${i}`, 'user', new Date(Date.now() + i * 1000))
      );

      const result = mergeMessages(existing, [], 5);

      expect(result).toHaveLength(5);
    });
  });

  describe('addOptimisticMessage', () => {
    it('should add message with temp ID', () => {
      const messages: ChatMessage[] = [
        createTestMessage('1', 'user'),
      ];

      const newMessage = {
        worktreeId: 'test-worktree',
        role: 'user' as const,
        content: 'New message',
        messageType: 'normal' as const,
      };

      const result = addOptimisticMessage(messages, newMessage, 'temp-123');

      expect(result).toHaveLength(2);
      expect(result[1].id).toBe('temp-123');
      expect(result[1].content).toBe('New message');
    });

    it('should set timestamp on new message', () => {
      const messages: ChatMessage[] = [];
      const newMessage = {
        worktreeId: 'test-worktree',
        role: 'user' as const,
        content: 'New message',
        messageType: 'normal' as const,
      };

      const before = Date.now();
      const result = addOptimisticMessage(messages, newMessage, 'temp-123');
      const after = Date.now();

      const timestamp = result[0].timestamp.getTime();
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it('should respect MAX_MESSAGES limit', () => {
      const messages = Array.from({ length: MAX_MESSAGES }, (_, i) =>
        createTestMessage(`msg-${i}`, 'user', new Date(Date.now() + i * 1000))
      );
      const newMessage = {
        worktreeId: 'test-worktree',
        role: 'user' as const,
        content: 'New message',
        messageType: 'normal' as const,
      };

      const result = addOptimisticMessage(messages, newMessage, 'temp-new');

      expect(result).toHaveLength(MAX_MESSAGES);
      expect(result.some(m => m.id === 'temp-new')).toBe(true);
    });
  });

  describe('confirmOptimisticMessage', () => {
    it('should replace temp ID with real ID', () => {
      const messages: ChatMessage[] = [
        createTestMessage('1', 'user'),
        { ...createTestMessage('temp-123', 'user'), id: 'temp-123' },
      ];

      const result = confirmOptimisticMessage(messages, 'temp-123', 'real-456');

      expect(result).toHaveLength(2);
      expect(result[1].id).toBe('real-456');
      expect(result.some(m => m.id === 'temp-123')).toBe(false);
    });

    it('should preserve other message properties', () => {
      const originalMessage = {
        ...createTestMessage('temp-123', 'user'),
        content: 'My content',
        summary: 'My summary',
      };
      const messages: ChatMessage[] = [originalMessage];

      const result = confirmOptimisticMessage(messages, 'temp-123', 'real-456');

      expect(result[0].content).toBe('My content');
      expect(result[0].summary).toBe('My summary');
    });

    it('should not modify messages if temp ID not found', () => {
      const messages: ChatMessage[] = [
        createTestMessage('1', 'user'),
        createTestMessage('2', 'assistant'),
      ];

      const result = confirmOptimisticMessage(messages, 'nonexistent', 'real-123');

      expect(result).toEqual(messages);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });
  });

  describe('removeOptimisticMessage', () => {
    it('should remove message with temp ID', () => {
      const messages: ChatMessage[] = [
        createTestMessage('1', 'user'),
        { ...createTestMessage('temp-123', 'user'), id: 'temp-123' },
        createTestMessage('3', 'assistant'),
      ];

      const result = removeOptimisticMessage(messages, 'temp-123');

      expect(result).toHaveLength(2);
      expect(result.map(m => m.id)).toEqual(['1', '3']);
    });

    it('should return same array if ID not found', () => {
      const messages: ChatMessage[] = [
        createTestMessage('1', 'user'),
        createTestMessage('2', 'assistant'),
      ];

      const result = removeOptimisticMessage(messages, 'nonexistent');

      expect(result).toHaveLength(2);
      expect(result.map(m => m.id)).toEqual(['1', '2']);
    });

    it('should handle empty array', () => {
      const result = removeOptimisticMessage([], 'temp-123');
      expect(result).toEqual([]);
    });
  });
});
