/**
 * Tests for useConversationHistory hook
 *
 * Tests the hook for managing conversation history with grouping and expand/collapse state
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConversationHistory } from '../useConversationHistory';
import type { ChatMessage } from '@/types/models';

// Helper to create test messages
function createTestMessage(
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

// Test timestamps
const T1 = new Date('2024-01-01T10:00:00');
const T2 = new Date('2024-01-01T10:01:00');
const T3 = new Date('2024-01-01T10:02:00');
const T4 = new Date('2024-01-01T10:03:00');

describe('useConversationHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pairs grouping', () => {
    it('should group messages into pairs', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi there!', T2),
      ];

      const { result } = renderHook(() => useConversationHistory(messages));

      expect(result.current.pairs).toHaveLength(1);
      expect(result.current.pairs[0].userMessage?.content).toBe('Hello');
      expect(result.current.pairs[0].assistantMessages[0].content).toBe(
        'Hi there!'
      );
    });

    it('should memoize pairs when messages do not change', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1),
        createTestMessage('assistant', 'Hi!', T2),
      ];

      const { result, rerender } = renderHook(
        ({ msgs }) => useConversationHistory(msgs),
        { initialProps: { msgs: messages } }
      );

      const firstPairs = result.current.pairs;

      // Rerender with same messages array reference
      rerender({ msgs: messages });

      // Pairs should be the same reference (memoized)
      expect(result.current.pairs).toBe(firstPairs);
    });

    it('should recalculate pairs when messages change', () => {
      const messages1 = [createTestMessage('user', 'Hello', T1)];
      const messages2 = [
        createTestMessage('user', 'Hello', T1),
        createTestMessage('assistant', 'Hi!', T2),
      ];

      const { result, rerender } = renderHook(
        ({ msgs }) => useConversationHistory(msgs),
        { initialProps: { msgs: messages1 } }
      );

      expect(result.current.pairs).toHaveLength(1);
      expect(result.current.pairs[0].status).toBe('pending');

      rerender({ msgs: messages2 });

      expect(result.current.pairs).toHaveLength(1);
      expect(result.current.pairs[0].status).toBe('completed');
    });
  });

  describe('expand/collapse state', () => {
    it('should start with all pairs collapsed', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi!', T2),
      ];

      const { result } = renderHook(() => useConversationHistory(messages));

      expect(result.current.expandedPairs.size).toBe(0);
      expect(result.current.isExpanded('user-1')).toBe(false);
    });

    it('should toggle expand state for a pair', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi!', T2),
      ];

      const { result } = renderHook(() => useConversationHistory(messages));

      // Initially collapsed
      expect(result.current.isExpanded('user-1')).toBe(false);

      // Toggle to expand
      act(() => {
        result.current.toggleExpand('user-1');
      });

      expect(result.current.isExpanded('user-1')).toBe(true);

      // Toggle to collapse
      act(() => {
        result.current.toggleExpand('user-1');
      });

      expect(result.current.isExpanded('user-1')).toBe(false);
    });

    it('should manage multiple expanded pairs independently', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi!', T2),
        createTestMessage('user', 'How are you?', T3, 'user-2'),
        createTestMessage('assistant', 'Fine!', T4),
      ];

      const { result } = renderHook(() => useConversationHistory(messages));

      // Expand first pair
      act(() => {
        result.current.toggleExpand('user-1');
      });

      expect(result.current.isExpanded('user-1')).toBe(true);
      expect(result.current.isExpanded('user-2')).toBe(false);

      // Expand second pair
      act(() => {
        result.current.toggleExpand('user-2');
      });

      expect(result.current.isExpanded('user-1')).toBe(true);
      expect(result.current.isExpanded('user-2')).toBe(true);

      // Collapse first pair
      act(() => {
        result.current.toggleExpand('user-1');
      });

      expect(result.current.isExpanded('user-1')).toBe(false);
      expect(result.current.isExpanded('user-2')).toBe(true);
    });

    it('should provide expandedPairs as a Set', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi!', T2),
      ];

      const { result } = renderHook(() => useConversationHistory(messages));

      expect(result.current.expandedPairs).toBeInstanceOf(Set);
    });
  });

  describe('expand all / collapse all', () => {
    it('should expand all pairs', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi!', T2),
        createTestMessage('user', 'How are you?', T3, 'user-2'),
        createTestMessage('assistant', 'Fine!', T4),
      ];

      const { result } = renderHook(() => useConversationHistory(messages));

      act(() => {
        result.current.expandAll();
      });

      expect(result.current.isExpanded('user-1')).toBe(true);
      expect(result.current.isExpanded('user-2')).toBe(true);
    });

    it('should collapse all pairs', () => {
      const messages = [
        createTestMessage('user', 'Hello', T1, 'user-1'),
        createTestMessage('assistant', 'Hi!', T2),
        createTestMessage('user', 'How are you?', T3, 'user-2'),
        createTestMessage('assistant', 'Fine!', T4),
      ];

      const { result } = renderHook(() => useConversationHistory(messages));

      // First expand all
      act(() => {
        result.current.expandAll();
      });

      expect(result.current.expandedPairs.size).toBe(2);

      // Then collapse all
      act(() => {
        result.current.collapseAll();
      });

      expect(result.current.expandedPairs.size).toBe(0);
      expect(result.current.isExpanded('user-1')).toBe(false);
      expect(result.current.isExpanded('user-2')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty messages', () => {
      const { result } = renderHook(() => useConversationHistory([]));

      expect(result.current.pairs).toHaveLength(0);
      expect(result.current.expandedPairs.size).toBe(0);
    });

    it('should handle orphan pairs', () => {
      const messages = [
        createTestMessage('assistant', 'Welcome!', T1, 'orphan-1'),
      ];

      const { result } = renderHook(() => useConversationHistory(messages));

      expect(result.current.pairs).toHaveLength(1);
      expect(result.current.pairs[0].status).toBe('orphan');
    });
  });
});
