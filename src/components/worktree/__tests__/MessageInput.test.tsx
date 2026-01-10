/**
 * Tests for MessageInput component
 *
 * Tests keyboard behavior for message submission on desktop and mobile devices
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageInput } from '../MessageInput';

// Mock the API client
vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    sendMessage: vi.fn().mockResolvedValue({}),
  },
  handleApiError: vi.fn((err) => err?.message || 'Unknown error'),
}));

// Mock the slash commands hook
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: [],
  })),
}));

// Variable to control isMobile return value
let mockIsMobile = false;

// Mock the useIsMobile hook
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => mockIsMobile),
}));

describe('MessageInput', () => {
  const defaultProps = {
    worktreeId: 'test-worktree',
    onMessageSent: vi.fn(),
    cliToolId: 'claude' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
  });

  afterEach(() => {
    mockIsMobile = false;
  });

  // Helper function to set mobile mode
  const setMobileMode = (isMobile: boolean) => {
    mockIsMobile = isMobile;
  };

  // ===== Desktop behavior =====

  describe('Desktop behavior', () => {
    beforeEach(() => {
      setMobileMode(false);
    });

    it('should submit message when Enter is pressed on desktop', async () => {
      const { worktreeApi } = await import('@/lib/api-client');
      const onMessageSent = vi.fn();

      render(<MessageInput {...defaultProps} onMessageSent={onMessageSent} />);

      const textarea = screen.getByPlaceholderText(/Type your message/i);
      fireEvent.change(textarea, { target: { value: 'Hello world' } });

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalledWith(
          'test-worktree',
          'Hello world',
          'claude'
        );
      });
    });

    it('should insert newline when Shift+Enter is pressed on desktop', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      const textarea = screen.getByPlaceholderText(/Type your message/i);
      fireEvent.change(textarea, { target: { value: 'Line 1' } });

      // Shift+Enter should not call preventDefault (allowing default newline behavior)
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      // Give time for any async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Message should NOT be sent
      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ===== Mobile behavior =====

  describe('Mobile behavior', () => {
    beforeEach(() => {
      setMobileMode(true);
    });

    it('should insert newline when Enter is pressed on mobile (not submit)', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      const textarea = screen.getByPlaceholderText(/Type your message/i);
      fireEvent.change(textarea, { target: { value: 'Hello mobile' } });

      // Enter on mobile should NOT submit
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Give time for any async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Message should NOT be sent via Enter on mobile
      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
    });

    it('should submit message when send button is clicked on mobile', async () => {
      const { worktreeApi } = await import('@/lib/api-client');
      const onMessageSent = vi.fn();

      render(<MessageInput {...defaultProps} onMessageSent={onMessageSent} />);

      const textarea = screen.getByPlaceholderText(/Type your message/i);
      fireEvent.change(textarea, { target: { value: 'Hello from mobile' } });

      // Click the send button
      const sendButton = screen.getByRole('button', { name: /send message/i });
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalledWith(
          'test-worktree',
          'Hello from mobile',
          'claude'
        );
      });
    });
  });

  // ===== IME behavior =====

  describe('IME composition behavior', () => {
    beforeEach(() => {
      setMobileMode(false);
    });

    it('should not submit when Enter is pressed during IME composition', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      const textarea = screen.getByPlaceholderText(/Type your message/i);
      fireEvent.change(textarea, { target: { value: 'Hello' } });

      // Start IME composition
      fireEvent.compositionStart(textarea);

      // Press Enter during composition (with keyCode 229 which indicates IME)
      fireEvent.keyDown(textarea, {
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { keyCode: 229 },
      });

      // Give time for any async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Message should NOT be sent during IME composition
      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
    });

    it('should not submit immediately after IME composition ends', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      const textarea = screen.getByPlaceholderText(/Type your message/i);
      fireEvent.change(textarea, { target: { value: 'Hello' } });

      // Start and end IME composition
      fireEvent.compositionStart(textarea);
      fireEvent.compositionEnd(textarea);

      // Press Enter immediately after composition ends
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Give time for any async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Message should NOT be sent immediately after composition ends
      // (due to justFinishedComposingRef protection)
      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ===== Accessibility =====

  describe('Accessibility', () => {
    it('should have aria-label on send button', () => {
      render(<MessageInput {...defaultProps} />);

      const sendButton = screen.getByRole('button', { name: /send message/i });
      expect(sendButton).toBeInTheDocument();
      expect(sendButton).toHaveAttribute('aria-label', 'Send message');
    });

    it('should have accessible placeholder text', () => {
      render(<MessageInput {...defaultProps} />);

      const textarea = screen.getByPlaceholderText(/Type your message/i);
      expect(textarea).toBeInTheDocument();
    });
  });

  // ===== Basic rendering =====

  describe('Basic rendering', () => {
    it('should render textarea and send button', () => {
      render(<MessageInput {...defaultProps} />);

      expect(screen.getByPlaceholderText(/Type your message/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
    });

    it('should disable send button when message is empty', () => {
      render(<MessageInput {...defaultProps} />);

      const sendButton = screen.getByRole('button', { name: /send message/i });
      expect(sendButton).toBeDisabled();
    });

    it('should enable send button when message has content', () => {
      render(<MessageInput {...defaultProps} />);

      const textarea = screen.getByPlaceholderText(/Type your message/i);
      fireEvent.change(textarea, { target: { value: 'Hello' } });

      const sendButton = screen.getByRole('button', { name: /send message/i });
      expect(sendButton).not.toBeDisabled();
    });
  });
});
