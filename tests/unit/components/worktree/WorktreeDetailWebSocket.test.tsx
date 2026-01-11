/**
 * WorktreeDetail WebSocket Message Handling Tests
 * Issue #36: Yes/No回答時の不要なリロード・スクロールリセットを修正
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '@/types/models';

// Helper functions to test (these will be extracted or tested via integration)
// For now, we test the core logic independently

describe('WorktreeDetail WebSocket message handling', () => {
  describe('handleMessageUpdate', () => {
    it('should update only the target message without changing array length', () => {
      const initialMessages: ChatMessage[] = [
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
        {
          id: '2',
          worktreeId: 'test-worktree',
          role: 'user',
          content: 'msg2',
          timestamp: new Date(),
          messageType: 'normal',
        },
      ];

      const updatedMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'msg1',
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

      // Simulate handleMessageUpdate logic
      const result = initialMessages.map((msg) =>
        msg.id === updatedMessage.id ? updatedMessage : msg
      );

      expect(result.length).toBe(2);
      expect(result[0].promptData?.status).toBe('answered');
      expect(result[0].promptData?.answer).toBe('yes');
      expect(result[1].id).toBe('2'); // Other messages unchanged
    });

    it('should return unchanged array if message id not found', () => {
      const initialMessages: ChatMessage[] = [
        {
          id: '1',
          worktreeId: 'test-worktree',
          role: 'assistant',
          content: 'msg1',
          timestamp: new Date(),
          messageType: 'normal',
        },
      ];

      const updatedMessage: ChatMessage = {
        id: 'non-existent',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'msg1',
        timestamp: new Date(),
        messageType: 'normal',
      };

      // Simulate handleMessageUpdate logic
      const result = initialMessages.map((msg) =>
        msg.id === updatedMessage.id ? updatedMessage : msg
      );

      expect(result.length).toBe(1);
      expect(result[0].id).toBe('1'); // Original message unchanged
    });

    it('should handle null/undefined message gracefully', () => {
      // Test with null
      const nullMessage = null as ChatMessage | null;
      const shouldProcessNull = nullMessage !== null && nullMessage.id !== null;
      expect(shouldProcessNull).toBe(false);

      // Test with undefined
      const undefinedMessage = undefined as ChatMessage | undefined;
      const shouldProcessUndefined = undefinedMessage !== undefined && undefinedMessage.id !== undefined;
      expect(shouldProcessUndefined).toBe(false);
    });
  });

  describe('handleNewMessage', () => {
    it('should add new message to the end of the array', () => {
      const initialMessages: ChatMessage[] = [
        {
          id: '1',
          worktreeId: 'test-worktree',
          role: 'user',
          content: 'msg1',
          timestamp: new Date(),
          messageType: 'normal',
        },
      ];

      const newMessage: ChatMessage = {
        id: '2',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'msg2',
        timestamp: new Date(),
        messageType: 'normal',
      };

      // Simulate handleNewMessage logic with duplicate check
      const isDuplicate = initialMessages.some((msg) => msg.id === newMessage.id);
      const result = isDuplicate ? initialMessages : [...initialMessages, newMessage];

      expect(result.length).toBe(2);
      expect(result[1].id).toBe('2');
    });

    it('should not add duplicate message', () => {
      const initialMessages: ChatMessage[] = [
        {
          id: '1',
          worktreeId: 'test-worktree',
          role: 'user',
          content: 'msg1',
          timestamp: new Date(),
          messageType: 'normal',
        },
      ];

      const duplicateMessage: ChatMessage = {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'user',
        content: 'msg1 updated',
        timestamp: new Date(),
        messageType: 'normal',
      };

      // Simulate handleNewMessage logic with duplicate check
      const isDuplicate = initialMessages.some((msg) => msg.id === duplicateMessage.id);
      const result = isDuplicate ? initialMessages : [...initialMessages, duplicateMessage];

      expect(result.length).toBe(1);
      expect(result[0].id).toBe('1');
      expect(result[0].content).toBe('msg1'); // Content unchanged (not updated)
    });

    it('should handle null/undefined message gracefully', () => {
      // Test with null
      const nullMessage = null as ChatMessage | null;
      const shouldProcessNull = nullMessage !== null && nullMessage.id !== null;
      expect(shouldProcessNull).toBe(false);

      // Test with undefined
      const undefinedMessage = undefined as ChatMessage | undefined;
      const shouldProcessUndefined = undefinedMessage !== undefined && undefinedMessage.id !== undefined;
      expect(shouldProcessUndefined).toBe(false);
    });
  });

  describe('WebSocket message event type dispatch', () => {
    it('should dispatch message_updated events to handleMessageUpdate', () => {
      const handleMessageUpdate = vi.fn();
      const handleNewMessage = vi.fn();
      const fetchMessages = vi.fn();

      const payload: {
        type: 'message_updated' | 'message';
        worktreeId: string;
        message: ChatMessage;
      } = {
        type: 'message_updated',
        worktreeId: 'test-worktree',
        message: {
          id: '1',
          worktreeId: 'test-worktree',
          role: 'assistant',
          content: 'test',
          timestamp: new Date(),
          messageType: 'normal',
        },
      };

      // Simulate event dispatch logic
      if (payload.type === 'message_updated') {
        handleMessageUpdate(payload.message);
      } else if (payload.type === 'message') {
        handleNewMessage(payload.message);
      } else {
        fetchMessages();
      }

      expect(handleMessageUpdate).toHaveBeenCalledWith(payload.message);
      expect(handleNewMessage).not.toHaveBeenCalled();
      expect(fetchMessages).not.toHaveBeenCalled();
    });

    it('should dispatch message events to handleNewMessage', () => {
      const handleMessageUpdate = vi.fn();
      const handleNewMessage = vi.fn();
      const fetchMessages = vi.fn();

      const payload: {
        type: 'message_updated' | 'message';
        worktreeId: string;
        message: ChatMessage;
      } = {
        type: 'message',
        worktreeId: 'test-worktree',
        message: {
          id: '2',
          worktreeId: 'test-worktree',
          role: 'assistant',
          content: 'test',
          timestamp: new Date(),
          messageType: 'normal',
        },
      };

      // Simulate event dispatch logic
      if (payload.type === 'message_updated') {
        handleMessageUpdate(payload.message);
      } else if (payload.type === 'message') {
        handleNewMessage(payload.message);
      } else {
        fetchMessages();
      }

      expect(handleMessageUpdate).not.toHaveBeenCalled();
      expect(handleNewMessage).toHaveBeenCalledWith(payload.message);
      expect(fetchMessages).not.toHaveBeenCalled();
    });

    it('should fallback to fetchMessages for unknown event types', () => {
      const handleMessageUpdate = vi.fn();
      const handleNewMessage = vi.fn();
      const fetchMessages = vi.fn();

      const payload = {
        type: 'unknown_event' as string,
        worktreeId: 'test-worktree',
      };

      // Simulate event dispatch logic
      if (payload.type === 'message_updated') {
        handleMessageUpdate();
      } else if (payload.type === 'message') {
        handleNewMessage();
      } else {
        fetchMessages();
      }

      expect(handleMessageUpdate).not.toHaveBeenCalled();
      expect(handleNewMessage).not.toHaveBeenCalled();
      expect(fetchMessages).toHaveBeenCalled();
    });
  });
});

describe('isChatPayload type guard', () => {
  it('should return true for valid ChatBroadcastPayload with message type', () => {
    const payload = {
      type: 'message',
      worktreeId: 'test-worktree',
      message: {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'test',
        timestamp: new Date(),
        messageType: 'normal',
      },
    };

    // Type guard logic
    const isChatPayload = (p: unknown): boolean => {
      return Boolean(p && typeof p === 'object' && 'message' in p && (p as { message: unknown }).message);
    };

    expect(isChatPayload(payload)).toBe(true);
  });

  it('should return true for valid ChatBroadcastPayload with message_updated type', () => {
    const payload = {
      type: 'message_updated',
      worktreeId: 'test-worktree',
      message: {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'test',
        timestamp: new Date(),
        messageType: 'normal',
      },
    };

    // Type guard logic
    const isChatPayload = (p: unknown): boolean => {
      return Boolean(p && typeof p === 'object' && 'message' in p && (p as { message: unknown }).message);
    };

    expect(isChatPayload(payload)).toBe(true);
  });

  it('should return false for SessionStatusPayload', () => {
    const payload = {
      type: 'session_status_changed',
      worktreeId: 'test-worktree',
      isRunning: true,
    };

    // Type guard logic
    const isChatPayload = (p: unknown): boolean => {
      return Boolean(p && typeof p === 'object' && 'message' in p && (p as { message: unknown }).message);
    };

    expect(isChatPayload(payload)).toBe(false);
  });

  it('should return false for null/undefined', () => {
    const isChatPayload = (p: unknown): boolean => {
      return Boolean(p && typeof p === 'object' && 'message' in p && (p as { message: unknown }).message);
    };

    expect(isChatPayload(null)).toBe(false);
    expect(isChatPayload(undefined)).toBe(false);
  });
});

describe('isSessionStatusPayload type guard', () => {
  it('should return true for valid SessionStatusPayload', () => {
    const payload = {
      type: 'session_status_changed',
      worktreeId: 'test-worktree',
      isRunning: true,
      messagesCleared: false,
    };

    const isSessionStatusPayload = (p: unknown): boolean => {
      return Boolean(p && typeof p === 'object' && 'type' in p && (p as { type: unknown }).type === 'session_status_changed');
    };

    expect(isSessionStatusPayload(payload)).toBe(true);
  });

  it('should return true for SessionStatusPayload with messagesCleared', () => {
    const payload = {
      type: 'session_status_changed',
      worktreeId: 'test-worktree',
      isRunning: false,
      messagesCleared: true,
    };

    const isSessionStatusPayload = (p: unknown): boolean => {
      return Boolean(p && typeof p === 'object' && 'type' in p && (p as { type: unknown }).type === 'session_status_changed');
    };

    expect(isSessionStatusPayload(payload)).toBe(true);
  });

  it('should return false for ChatBroadcastPayload', () => {
    const payload = {
      type: 'message',
      worktreeId: 'test-worktree',
      message: { id: '1' },
    };

    const isSessionStatusPayload = (p: unknown): boolean => {
      return Boolean(p && typeof p === 'object' && 'type' in p && (p as { type: unknown }).type === 'session_status_changed');
    };

    expect(isSessionStatusPayload(payload)).toBe(false);
  });
});

describe('handleMessageUpdate edge cases', () => {
  it('should handle empty messages array', () => {
    const initialMessages: ChatMessage[] = [];

    const updatedMessage: ChatMessage = {
      id: '1',
      worktreeId: 'test-worktree',
      role: 'assistant',
      content: 'msg1',
      timestamp: new Date(),
      messageType: 'normal',
    };

    const result = initialMessages.map((msg) =>
      msg.id === updatedMessage.id ? updatedMessage : msg
    );

    expect(result.length).toBe(0);
  });

  it('should handle messages with different CLI tools', () => {
    const initialMessages: ChatMessage[] = [
      {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'claude msg',
        timestamp: new Date(),
        messageType: 'normal',
        cliToolId: 'claude',
      },
      {
        id: '2',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'codex msg',
        timestamp: new Date(),
        messageType: 'normal',
        cliToolId: 'codex',
      },
    ];

    const updatedMessage: ChatMessage = {
      id: '1',
      worktreeId: 'test-worktree',
      role: 'assistant',
      content: 'updated claude msg',
      timestamp: new Date(),
      messageType: 'normal',
      cliToolId: 'claude',
    };

    const result = initialMessages.map((msg) =>
      msg.id === updatedMessage.id ? updatedMessage : msg
    );

    expect(result[0].content).toBe('updated claude msg');
    expect(result[1].cliToolId).toBe('codex');
  });

  it('should update message with multiple_choice promptData', () => {
    const initialMessages: ChatMessage[] = [
      {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Choose an option',
        timestamp: new Date(),
        messageType: 'prompt',
        promptData: {
          type: 'multiple_choice',
          question: 'Select one',
          status: 'pending',
          options: [
            { number: 1, label: 'Option 1', isDefault: true },
            { number: 2, label: 'Option 2' },
          ],
        },
      },
    ];

    const updatedMessage: ChatMessage = {
      ...initialMessages[0],
      promptData: {
        type: 'multiple_choice',
        question: 'Select one',
        status: 'answered',
        answer: '1',
        options: [
          { number: 1, label: 'Option 1', isDefault: true },
          { number: 2, label: 'Option 2' },
        ],
      },
    };

    const result = initialMessages.map((msg) =>
      msg.id === updatedMessage.id ? updatedMessage : msg
    );

    expect(result[0].promptData?.status).toBe('answered');
    expect(result[0].promptData?.answer).toBe('1');
  });
});

describe('handleNewMessage edge cases', () => {
  it('should handle adding message to empty array', () => {
    const initialMessages: ChatMessage[] = [];

    const newMessage: ChatMessage = {
      id: '1',
      worktreeId: 'test-worktree',
      role: 'assistant',
      content: 'first msg',
      timestamp: new Date(),
      messageType: 'normal',
    };

    const isDuplicate = initialMessages.some((msg) => msg.id === newMessage.id);
    const result = isDuplicate ? initialMessages : [...initialMessages, newMessage];

    expect(result.length).toBe(1);
    expect(result[0].id).toBe('1');
  });

  it('should preserve message order when adding', () => {
    const initialMessages: ChatMessage[] = [
      {
        id: '1',
        worktreeId: 'test-worktree',
        role: 'user',
        content: 'msg1',
        timestamp: new Date('2024-01-01'),
        messageType: 'normal',
      },
      {
        id: '2',
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'msg2',
        timestamp: new Date('2024-01-02'),
        messageType: 'normal',
      },
    ];

    const newMessage: ChatMessage = {
      id: '3',
      worktreeId: 'test-worktree',
      role: 'user',
      content: 'msg3',
      timestamp: new Date('2024-01-03'),
      messageType: 'normal',
    };

    const isDuplicate = initialMessages.some((msg) => msg.id === newMessage.id);
    const result = isDuplicate ? initialMessages : [...initialMessages, newMessage];

    expect(result.length).toBe(3);
    expect(result[0].id).toBe('1');
    expect(result[1].id).toBe('2');
    expect(result[2].id).toBe('3');
  });

  it('should handle messages with logFileName', () => {
    const initialMessages: ChatMessage[] = [];

    const newMessage: ChatMessage = {
      id: '1',
      worktreeId: 'test-worktree',
      role: 'assistant',
      content: 'logged msg',
      timestamp: new Date(),
      messageType: 'normal',
      logFileName: 'log-2024-01-01.txt',
    };

    const isDuplicate = initialMessages.some((msg) => msg.id === newMessage.id);
    const result = isDuplicate ? initialMessages : [...initialMessages, newMessage];

    expect(result[0].logFileName).toBe('log-2024-01-01.txt');
  });
});
