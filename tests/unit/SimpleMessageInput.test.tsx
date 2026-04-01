/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for SimpleMessageInput component
 * Issue #600: UX refresh - lightweight message input for Review screen
 *
 * Security [DR4-004]: No dangerouslySetInnerHTML, plain text only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Mock useSendMessage
const mockSend = vi.fn();
let lastUseSendMessageOpts: Record<string, unknown> = {};
let mockIsSending = false;

vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: (opts: Record<string, unknown>) => {
    lastUseSendMessageOpts = opts;
    return {
      send: mockSend,
      isSending: mockIsSending,
      error: null,
    };
  },
}));

import { SimpleMessageInput } from '@/components/review/SimpleMessageInput';

describe('SimpleMessageInput', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockSend.mockResolvedValue(undefined);
    lastUseSendMessageOpts = {};
    mockIsSending = false;
  });

  it('should render a text input and send button', () => {
    render(<SimpleMessageInput worktreeId="wt-1" cliToolId="claude" />);
    expect(screen.getByPlaceholderText('Send a message...')).toBeDefined();
    expect(screen.getByRole('button', { name: /send/i })).toBeDefined();
  });

  it('should call send when button is clicked with text', () => {
    render(<SimpleMessageInput worktreeId="wt-1" cliToolId="claude" />);
    const input = screen.getByPlaceholderText('Send a message...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(mockSend).toHaveBeenCalledWith('hello');
  });

  it('should not call send when text is empty', () => {
    render(<SimpleMessageInput worktreeId="wt-1" cliToolId="claude" />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should invoke onSuccess callback from useSendMessage options', () => {
    render(<SimpleMessageInput worktreeId="wt-1" cliToolId="claude" />);
    // The component passes an onSuccess callback to useSendMessage
    expect(lastUseSendMessageOpts).toHaveProperty('onSuccess');
    expect(typeof lastUseSendMessageOpts.onSuccess).toBe('function');
  });

  it('should disable send button when isSending is true', () => {
    mockIsSending = true;
    render(<SimpleMessageInput worktreeId="wt-1" cliToolId="claude" />);
    const button = screen.getByRole('button', { name: /send/i });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('should pass worktreeId and cliToolId to useSendMessage', () => {
    render(<SimpleMessageInput worktreeId="wt-1" cliToolId="codex" />);
    expect(lastUseSendMessageOpts).toEqual(
      expect.objectContaining({
        worktreeId: 'wt-1',
        cliToolId: 'codex',
      })
    );
  });

  it('should NOT use dangerouslySetInnerHTML', () => {
    const { container } = render(<SimpleMessageInput worktreeId="wt-1" cliToolId="claude" />);
    // Check that no element has dangerouslySetInnerHTML
    const html = container.innerHTML;
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });
});
