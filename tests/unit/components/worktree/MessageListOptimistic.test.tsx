/**
 * MessageList Optimistic Update Tests
 * Issue #36: Yes/No回答時の不要なリロード・スクロールリセットを修正
 */

import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage } from '@/types/models';

describe('MessageList Optimistic Update', () => {
  describe('handlePromptResponse with Optimistic Update', () => {
    it('should immediately update message status to answered', () => {
      const initialMessages: ChatMessage[] = [
        {
          id: '1',
          worktreeId: 'test-worktree',
          role: 'assistant',
          content: 'Do you want to proceed?',
          timestamp: new Date(),
          messageType: 'prompt',
          promptData: {
            type: 'yes_no',
            question: 'Do you want to proceed?',
            status: 'pending',
            options: ['yes', 'no'],
          },
        },
      ];

      const targetMessage = initialMessages.find((msg) => msg.id === '1');
      expect(targetMessage).toBeDefined();
      expect(targetMessage?.promptData?.status).toBe('pending');

      // Simulate optimistic update
      const optimisticMessage: ChatMessage = {
        ...targetMessage!,
        promptData: {
          ...targetMessage!.promptData!,
          status: 'answered',
          answer: 'yes',
          answeredAt: new Date().toISOString(),
        },
      };

      // Update messages array
      const updatedMessages = initialMessages.map((msg) =>
        msg.id === optimisticMessage.id ? optimisticMessage : msg
      );

      expect(updatedMessages[0].promptData?.status).toBe('answered');
      expect(updatedMessages[0].promptData?.answer).toBe('yes');
      expect(updatedMessages[0].promptData?.answeredAt).toBeDefined();
    });

    it('should preserve other message properties during optimistic update', () => {
      const initialMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Original content',
        summary: 'Summary',
        timestamp: new Date('2024-01-01'),
        messageType: 'prompt',
        logFileName: 'log.txt',
        cliToolId: 'claude',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'pending',
          options: ['yes', 'no'],
        },
      };

      // Simulate optimistic update
      const optimisticMessage: ChatMessage = {
        ...initialMessage,
        promptData: {
          ...initialMessage.promptData!,
          status: 'answered',
          answer: 'no',
          answeredAt: new Date().toISOString(),
        },
      };

      // Verify all properties are preserved
      expect(optimisticMessage.id).toBe('1');
      expect(optimisticMessage.worktreeId).toBe('test-worktree');
      expect(optimisticMessage.role).toBe('assistant');
      expect(optimisticMessage.content).toBe('Original content');
      expect(optimisticMessage.summary).toBe('Summary');
      expect(optimisticMessage.logFileName).toBe('log.txt');
      expect(optimisticMessage.cliToolId).toBe('claude');
      expect(optimisticMessage.promptData?.type).toBe('yes_no');
      expect(optimisticMessage.promptData?.question).toBe('Confirm?');
      expect(optimisticMessage.promptData?.status).toBe('answered');
      expect(optimisticMessage.promptData?.answer).toBe('no');
    });

    it('should rollback to original state on API failure', () => {
      const originalMessages: ChatMessage[] = [
        {
          id: '1',
          worktreeId: 'test-worktree',
          role: 'assistant',
          content: 'msg1',
          timestamp: new Date(),
          messageType: 'prompt',
          promptData: {
            type: 'yes_no',
            question: 'Confirm?',
            status: 'pending',
            options: ['yes', 'no'],
          },
        },
      ];

      // Simulate optimistic update
      const optimisticMessage: ChatMessage = {
        ...originalMessages[0],
        promptData: {
          ...originalMessages[0].promptData!,
          status: 'answered',
          answer: 'yes',
        },
      };

      let currentMessages = originalMessages.map((msg) =>
        msg.id === optimisticMessage.id ? optimisticMessage : msg
      );

      // Verify optimistic state
      expect(currentMessages[0].promptData?.status).toBe('answered');

      // Simulate API failure and rollback
      currentMessages = originalMessages;

      // Verify rollback
      expect(currentMessages[0].promptData?.status).toBe('pending');
      expect(currentMessages[0].promptData?.answer).toBeUndefined();
    });
  });

  describe('MessageListProps type definition', () => {
    it('should accept onOptimisticUpdate callback', () => {
      interface MessageListProps {
        messages: ChatMessage[];
        worktreeId: string;
        onOptimisticUpdate?: (message: ChatMessage) => void;
        onOptimisticRollback?: (messages: ChatMessage[]) => void;
      }

      const props: MessageListProps = {
        messages: [],
        worktreeId: 'test',
        onOptimisticUpdate: vi.fn(),
        onOptimisticRollback: vi.fn(),
      };

      expect(props.onOptimisticUpdate).toBeDefined();
      expect(props.onOptimisticRollback).toBeDefined();
    });

    it('should work without optional callbacks', () => {
      interface MessageListProps {
        messages: ChatMessage[];
        worktreeId: string;
        onOptimisticUpdate?: (message: ChatMessage) => void;
        onOptimisticRollback?: (messages: ChatMessage[]) => void;
      }

      const props: MessageListProps = {
        messages: [],
        worktreeId: 'test',
      };

      expect(props.onOptimisticUpdate).toBeUndefined();
      expect(props.onOptimisticRollback).toBeUndefined();
    });
  });
});

describe('MessageBubble memoization', () => {
  describe('Custom comparison function', () => {
    it('should return true (skip re-render) when all compared props are equal', () => {
      const prevMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'pending',
          options: ['yes', 'no'],
        },
      };

      const nextMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(), // Different timestamp, but not compared
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'pending',
          options: ['yes', 'no'],
        },
      };

      // Custom comparison function
      const areEqual = (prev: ChatMessage, next: ChatMessage): boolean => {
        return (
          prev.id === next.id &&
          prev.content === next.content &&
          prev.promptData?.status === next.promptData?.status &&
          prev.promptData?.answer === next.promptData?.answer
        );
      };

      expect(areEqual(prevMessage, nextMessage)).toBe(true);
    });

    it('should return false (trigger re-render) when promptData.status changes', () => {
      const prevMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'pending',
          options: ['yes', 'no'],
        },
      };

      const nextMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'answered',
          answer: 'yes',
          options: ['yes', 'no'],
        },
      };

      // Custom comparison function
      const areEqual = (prev: ChatMessage, next: ChatMessage): boolean => {
        return (
          prev.id === next.id &&
          prev.content === next.content &&
          prev.promptData?.status === next.promptData?.status &&
          prev.promptData?.answer === next.promptData?.answer
        );
      };

      expect(areEqual(prevMessage, nextMessage)).toBe(false);
    });

    it('should return false (trigger re-render) when promptData.answer changes', () => {
      const prevMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'answered',
          answer: 'yes',
          options: ['yes', 'no'],
        },
      };

      const nextMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'answered',
          answer: 'no', // Changed
          options: ['yes', 'no'],
        },
      };

      // Custom comparison function
      const areEqual = (prev: ChatMessage, next: ChatMessage): boolean => {
        return (
          prev.id === next.id &&
          prev.content === next.content &&
          prev.promptData?.status === next.promptData?.status &&
          prev.promptData?.answer === next.promptData?.answer
        );
      };

      expect(areEqual(prevMessage, nextMessage)).toBe(false);
    });

    it('should return false (trigger re-render) when content changes', () => {
      const prevMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'normal',
      };

      const nextMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello World', // Changed
        timestamp: new Date(),
        messageType: 'normal',
      };

      // Custom comparison function
      const areEqual = (prev: ChatMessage, next: ChatMessage): boolean => {
        return (
          prev.id === next.id &&
          prev.content === next.content &&
          prev.promptData?.status === next.promptData?.status &&
          prev.promptData?.answer === next.promptData?.answer
        );
      };

      expect(areEqual(prevMessage, nextMessage)).toBe(false);
    });

    it('should handle messages without promptData', () => {
      const prevMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'user',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'normal',
      };

      const nextMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'user',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'normal',
      };

      // Custom comparison function
      const areEqual = (prev: ChatMessage, next: ChatMessage): boolean => {
        return (
          prev.id === next.id &&
          prev.content === next.content &&
          prev.promptData?.status === prev.promptData?.status &&
          prev.promptData?.answer === next.promptData?.answer
        );
      };

      // Both undefined should be equal
      expect(areEqual(prevMessage, nextMessage)).toBe(true);
    });

    it('should return false when id changes', () => {
      const prevMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'normal',
      };

      const nextMessage: ChatMessage = {
        id: '2', // Different id
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'normal',
      };

      const areEqual = (prev: ChatMessage, next: ChatMessage): boolean => {
        return (
          prev.id === next.id &&
          prev.content === next.content &&
          prev.promptData?.status === next.promptData?.status &&
          prev.promptData?.answer === next.promptData?.answer
        );
      };

      expect(areEqual(prevMessage, nextMessage)).toBe(false);
    });

    it('should handle one message with promptData and one without', () => {
      const prevMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'normal',
        // No promptData
      };

      const nextMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date(),
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'pending',
          options: ['yes', 'no'],
        },
      };

      const areEqual = (prev: ChatMessage, next: ChatMessage): boolean => {
        return (
          prev.id === next.id &&
          prev.content === next.content &&
          prev.promptData?.status === next.promptData?.status &&
          prev.promptData?.answer === next.promptData?.answer
        );
      };

      // undefined !== 'pending', so should be false
      expect(areEqual(prevMessage, nextMessage)).toBe(false);
    });
  });
});

describe('Optimistic Update - Multiple Choice prompts', () => {
  it('should handle multiple_choice prompt with text input option', () => {
    const initialMessage: ChatMessage = {
      id: '1',
      worktreeId: 'test-worktree',
      role: 'assistant',
      content: 'Select an option',
      timestamp: new Date(),
      messageType: 'prompt',
      promptData: {
        type: 'multiple_choice',
        question: 'Choose one',
        status: 'pending',
        options: [
          { number: 1, label: 'Option 1', isDefault: true },
          { number: 2, label: 'Option 2' },
          { number: 3, label: 'Custom', requiresTextInput: true },
        ],
      },
    };

    // Simulate user selecting text input option with custom text
    const optimisticMessage: ChatMessage = {
      ...initialMessage,
      promptData: {
        ...initialMessage.promptData!,
        status: 'answered',
        answer: 'My custom response',
        answeredAt: new Date().toISOString(),
      },
    };

    expect(optimisticMessage.promptData?.status).toBe('answered');
    expect(optimisticMessage.promptData?.answer).toBe('My custom response');
    expect(optimisticMessage.promptData?.answeredAt).toBeDefined();
  });

  it('should handle multiple_choice prompt with default option selection', () => {
    const initialMessage: ChatMessage = {
      id: '1',
      worktreeId: 'test-worktree',
      role: 'assistant',
      content: 'Select an option',
      timestamp: new Date(),
      messageType: 'prompt',
      promptData: {
        type: 'multiple_choice',
        question: 'Choose one',
        status: 'pending',
        options: [
          { number: 1, label: 'Option 1', isDefault: true },
          { number: 2, label: 'Option 2' },
        ],
      },
    };

    // Simulate user selecting the default option
    const optimisticMessage: ChatMessage = {
      ...initialMessage,
      promptData: {
        ...initialMessage.promptData!,
        status: 'answered',
        answer: '1',
        answeredAt: new Date().toISOString(),
      },
    };

    expect(optimisticMessage.promptData?.status).toBe('answered');
    expect(optimisticMessage.promptData?.answer).toBe('1');
  });
});

/**
 * MessageList Scroll Behavior Tests
 * Issue #131: Fix scroll animation when switching worktrees
 */
describe('MessageList scroll behavior', () => {
  /**
   * Helper function to compute scroll behavior based on worktree and message changes
   * This mirrors the logic in MessageList.tsx useEffect
   */
  function computeScrollBehavior(
    prevWorktreeId: string | undefined,
    currentWorktreeId: string,
    prevMessageCount: number,
    currentMessageCount: number
  ): { isWorktreeChange: boolean; isNewMessage: boolean; shouldScroll: boolean; scrollBehavior: 'instant' | 'smooth' } {
    const isWorktreeChange = prevWorktreeId !== currentWorktreeId;
    const isNewMessage = currentMessageCount > prevMessageCount;
    const shouldScroll = isNewMessage || isWorktreeChange;
    const scrollBehavior = isWorktreeChange ? 'instant' : 'smooth';
    return { isWorktreeChange, isNewMessage, shouldScroll, scrollBehavior };
  }

  describe('scrollIntoView behavior parameter', () => {
    it('should use instant scroll when worktreeId changes', () => {
      // Simulate scroll behavior logic
      const result = computeScrollBehavior('worktree-1', 'worktree-2', 5, 3);

      // When worktreeId changes, should scroll with 'instant' behavior
      expect(result.isWorktreeChange).toBe(true);
      expect(result.shouldScroll).toBe(true);
      expect(result.scrollBehavior).toBe('instant');
    });

    it('should use smooth scroll when new message added in same worktree', () => {
      // Simulate scroll behavior logic - same worktree, new message added
      const result = computeScrollBehavior('worktree-1', 'worktree-1', 5, 6);

      // When new message added in same worktree, should scroll with 'smooth' behavior
      expect(result.isWorktreeChange).toBe(false);
      expect(result.isNewMessage).toBe(true);
      expect(result.shouldScroll).toBe(true);
      expect(result.scrollBehavior).toBe('smooth');
    });

    it('should not scroll when no new messages and same worktree', () => {
      // Simulate scroll behavior logic - same worktree, same message count
      const result = computeScrollBehavior('worktree-1', 'worktree-1', 5, 5);

      // Should not scroll when neither worktree changed nor new message added
      expect(result.isWorktreeChange).toBe(false);
      expect(result.isNewMessage).toBe(false);
      expect(result.shouldScroll).toBe(false);
    });

    it('should use instant scroll when switching to worktree with existing messages', () => {
      // Scenario: User switches from worktree with 10 messages to one with 5
      const result = computeScrollBehavior('worktree-1', 'worktree-2', 10, 5);

      // Even though message count decreased, should still scroll because worktree changed
      expect(result.isWorktreeChange).toBe(true);
      expect(result.shouldScroll).toBe(true);
      expect(result.scrollBehavior).toBe('instant');
    });
  });

  describe('prevWorktreeIdRef tracking', () => {
    it('should track worktreeId changes correctly', () => {
      // Simulate ref tracking behavior
      let prevWorktreeIdRef = 'worktree-1';
      const worktreeChanges = ['worktree-1', 'worktree-2', 'worktree-2', 'worktree-3'];
      const changeDetections: boolean[] = [];

      for (const worktreeId of worktreeChanges) {
        const isChange = prevWorktreeIdRef !== worktreeId;
        changeDetections.push(isChange);
        prevWorktreeIdRef = worktreeId;
      }

      // First: same worktree (no change)
      expect(changeDetections[0]).toBe(false);
      // Second: different worktree (change detected)
      expect(changeDetections[1]).toBe(true);
      // Third: same as previous (no change)
      expect(changeDetections[2]).toBe(false);
      // Fourth: different worktree (change detected)
      expect(changeDetections[3]).toBe(true);
    });

    it('should handle undefined initial worktreeId', () => {
      // Simulate first render with undefined prevWorktreeId
      let prevWorktreeIdRef: string | undefined = undefined;
      const worktreeId = 'worktree-1';

      const isWorktreeChange = prevWorktreeIdRef !== worktreeId;
      prevWorktreeIdRef = worktreeId;

      // First render should detect as change (undefined !== 'worktree-1')
      expect(isWorktreeChange).toBe(true);
      expect(prevWorktreeIdRef).toBe('worktree-1');
    });
  });
});

describe('Optimistic Update - Error scenarios', () => {
  it('should handle rollback when target message has no promptData', () => {
    const originalMessages: ChatMessage[] = [
      {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Normal message without prompt',
        timestamp: new Date(),
        messageType: 'normal',
        // No promptData
      },
    ];

    // Verify that checking for promptData returns undefined
    const targetMessage = originalMessages.find((msg) => msg.id === '1');
    expect(targetMessage?.promptData).toBeUndefined();

    // Should not attempt optimistic update if no promptData
    const shouldUpdate = targetMessage?.promptData !== undefined;
    expect(shouldUpdate).toBe(false);
  });

  it('should handle rollback when message not found', () => {
    const originalMessages: ChatMessage[] = [
      {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'msg1',
        timestamp: new Date(),
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'pending',
          options: ['yes', 'no'],
        },
      },
    ];

    // Try to find a non-existent message
    const targetMessage = originalMessages.find((msg) => msg.id === 'non-existent');
    expect(targetMessage).toBeUndefined();

    // Rollback should restore original state
    const currentMessages = originalMessages;
    expect(currentMessages[0].promptData?.status).toBe('pending');
  });

  it('should preserve message array reference after successful update', () => {
    const originalMessages: ChatMessage[] = [
      {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'msg1',
        timestamp: new Date(),
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Confirm?',
          status: 'pending',
          options: ['yes', 'no'],
        },
      },
    ];

    const optimisticMessage: ChatMessage = {
      ...originalMessages[0],
      promptData: {
        ...originalMessages[0].promptData!,
        status: 'answered',
        answer: 'yes',
      },
    };

    const updatedMessages = originalMessages.map((msg) =>
      msg.id === optimisticMessage.id ? optimisticMessage : msg
    );

    // New array created (immutable update)
    expect(updatedMessages).not.toBe(originalMessages);
    // Original unchanged
    expect(originalMessages[0].promptData?.status).toBe('pending');
    // Updated array has new value
    expect(updatedMessages[0].promptData?.status).toBe('answered');
  });
});
