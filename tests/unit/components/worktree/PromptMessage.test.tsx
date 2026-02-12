/**
 * PromptMessage Component Tests
 * Issue #235: Verify rawContent display in prompt messages
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PromptMessage } from '@/components/worktree/PromptMessage';
import type { ChatMessage } from '@/types/models';

// Helper to create a ChatMessage for testing
function createPromptMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'test-msg-1',
    worktreeId: 'test-worktree',
    role: 'assistant',
    content: '',
    timestamp: new Date('2026-02-11T10:00:00Z'),
    messageType: 'prompt',
    promptData: {
      type: 'yes_no',
      question: 'Do you want to proceed?',
      options: ['yes', 'no'],
      status: 'pending',
    },
    ...overrides,
  };
}

describe('PromptMessage - Issue #235: rawContent display', () => {
  const mockOnRespond = vi.fn().mockResolvedValue(undefined);

  it('should display message.content as instruction text when content differs from question', () => {
    const message = createPromptMessage({
      content: 'Here is some instruction text.\nPlease review the changes.\nDo you want to proceed?',
    });

    render(
      <PromptMessage
        message={message}
        worktreeId="test-worktree"
        onRespond={mockOnRespond}
      />
    );

    // The instruction text should be displayed
    expect(screen.getByText(/Here is some instruction text/)).toBeDefined();
  });

  it('should not display instruction text when message.content is empty', () => {
    const message = createPromptMessage({
      content: '',
    });

    render(
      <PromptMessage
        message={message}
        worktreeId="test-worktree"
        onRespond={mockOnRespond}
      />
    );

    // The question should still be displayed
    expect(screen.getByText('Do you want to proceed?')).toBeDefined();
  });

  it('should display content when it contains the question text (instruction + question)', () => {
    const message = createPromptMessage({
      content: 'I will modify the following files:\n- src/index.ts\n- src/lib/utils.ts\nDo you want to proceed?',
    });

    render(
      <PromptMessage
        message={message}
        worktreeId="test-worktree"
        onRespond={mockOnRespond}
      />
    );

    // The full content should be displayed (including instruction before question)
    expect(screen.getByText(/I will modify the following files/)).toBeDefined();
  });

  it('should handle long text content without rendering errors', () => {
    const longContent = Array.from({ length: 50 }, (_, i) => `Instruction line ${i + 1}`).join('\n') +
      '\nDo you want to proceed?';
    const message = createPromptMessage({
      content: longContent,
    });

    const { container } = render(
      <PromptMessage
        message={message}
        worktreeId="test-worktree"
        onRespond={mockOnRespond}
      />
    );

    // Should render without errors
    expect(container).toBeDefined();
    // The long content should be in the DOM
    expect(screen.getByText(/Instruction line 1/)).toBeDefined();
    expect(screen.getByText(/Instruction line 50/)).toBeDefined();
  });
});
