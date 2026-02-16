/**
 * Tests for MessageInput component
 *
 * Tests keyboard behavior for message submission on desktop and mobile devices
 * Tests free input mode behavior (Issue #288)
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';

// Mock the API client
vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    sendMessage: vi.fn().mockResolvedValue({}),
  },
  handleApiError: vi.fn((err) => err?.message || 'Unknown error'),
}));

// Mock command groups for slash command selector tests
const mockCommandGroups = [
  {
    category: 'standard-session' as const,
    label: 'Standard (Session)',
    commands: [
      {
        name: 'test-command',
        description: 'A test command',
        category: 'standard-session' as const,
        filePath: '/test',
      },
    ],
  },
];

// Mock the slash commands hook - returns command groups so SlashCommandSelector renders
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups,
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

  // ===== Free Input Mode (Issue #288) =====

  describe('Free Input Mode (Issue #288)', () => {
    describe('Desktop', () => {
      beforeEach(() => {
        setMobileMode(false);
      });

      it('TC-1: should keep selector hidden after handleFreeInput and custom command input', async () => {
        render(<MessageInput {...defaultProps} />);

        const textarea = screen.getByPlaceholderText(/Type your message/i);

        // Type '/' to open the selector
        fireEvent.change(textarea, { target: { value: '/' } });

        // Selector should be open (desktop renders as listbox)
        expect(screen.getByRole('listbox')).toBeInTheDocument();

        // Click the free input button
        const freeInputButton = screen.getByTestId('free-input-button');
        fireEvent.click(freeInputButton);

        // After free input, selector should be closed
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

        // Type a custom command (e.g., '/model') - selector should remain hidden
        fireEvent.change(textarea, { target: { value: '/model' } });

        // Selector should remain hidden (the bug fix)
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      });

      it('TC-2: should submit message with Enter key after handleFreeInput', async () => {
        const { worktreeApi } = await import('@/lib/api-client');

        render(<MessageInput {...defaultProps} />);

        const textarea = screen.getByPlaceholderText(/Type your message/i);

        // Type '/' to open selector
        fireEvent.change(textarea, { target: { value: '/' } });

        // Click free input button
        const freeInputButton = screen.getByTestId('free-input-button');
        fireEvent.click(freeInputButton);

        // Type a custom command with a space (so it is a sendable message)
        fireEvent.change(textarea, { target: { value: '/model gpt-4o' } });

        // Press Enter to submit
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

        await waitFor(() => {
          expect(worktreeApi.sendMessage).toHaveBeenCalledWith(
            'test-worktree',
            '/model gpt-4o',
            'claude'
          );
        });
      });

      it('TC-3: should show selector again after clearing message in free input mode', async () => {
        render(<MessageInput {...defaultProps} />);

        const textarea = screen.getByPlaceholderText(/Type your message/i);

        // Type '/' to open the selector
        fireEvent.change(textarea, { target: { value: '/' } });

        // Click the free input button
        const freeInputButton = screen.getByTestId('free-input-button');
        fireEvent.click(freeInputButton);

        // Type a custom command
        fireEvent.change(textarea, { target: { value: '/model' } });

        // Clear the message entirely
        fireEvent.change(textarea, { target: { value: '' } });

        // Type '/' again - selector should reappear
        fireEvent.change(textarea, { target: { value: '/' } });

        expect(screen.getByRole('listbox')).toBeInTheDocument();
      });

      it('TC-4: should reset isFreeInputMode after submitMessage', async () => {
        const { worktreeApi } = await import('@/lib/api-client');

        render(<MessageInput {...defaultProps} />);

        const textarea = screen.getByPlaceholderText(/Type your message/i);

        // Type '/' to open the selector
        fireEvent.change(textarea, { target: { value: '/' } });

        // Click the free input button
        const freeInputButton = screen.getByTestId('free-input-button');
        fireEvent.click(freeInputButton);

        // Type and submit a custom command
        fireEvent.change(textarea, { target: { value: '/test command' } });
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

        await waitFor(() => {
          expect(worktreeApi.sendMessage).toHaveBeenCalled();
        });

        // After submit, typing '/' should show selector again
        // (message is cleared after submit, so type '/')
        fireEvent.change(textarea, { target: { value: '/' } });
        expect(screen.getByRole('listbox')).toBeInTheDocument();
      });

      it('TC-5: should reset isFreeInputMode after handleCommandCancel (Escape key)', async () => {
        render(<MessageInput {...defaultProps} />);

        const textarea = screen.getByPlaceholderText(/Type your message/i);

        // Type '/' to open the selector
        fireEvent.change(textarea, { target: { value: '/' } });
        expect(screen.getByRole('listbox')).toBeInTheDocument();

        // Press Escape to close selector (triggers handleCommandCancel)
        // The SlashCommandSelector's onClose callback fires handleCommandCancel
        // which sets showCommandSelector=false and isFreeInputMode=false
        fireEvent.keyDown(textarea, { key: 'Escape' });

        // Selector should be closed
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

        // Clear the message and type '/' again to verify handleCommandCancel
        // properly resets isFreeInputMode and selector can reopen
        fireEvent.change(textarea, { target: { value: '' } });
        fireEvent.change(textarea, { target: { value: '/' } });
        expect(screen.getByRole('listbox')).toBeInTheDocument();
      });

      it('TC-6: should show selector on normal "/" input (not in free input mode)', async () => {
        render(<MessageInput {...defaultProps} />);

        const textarea = screen.getByPlaceholderText(/Type your message/i);

        // Type '/' without entering free input mode
        fireEvent.change(textarea, { target: { value: '/' } });

        // Selector should appear (normal behavior preserved)
        expect(screen.getByRole('listbox')).toBeInTheDocument();
      });
    });

    describe('Mobile', () => {
      beforeEach(() => {
        setMobileMode(true);
      });

      it('TC-7: should reset isFreeInputMode when mobile command button is clicked during free input mode', async () => {
        render(<MessageInput {...defaultProps} />);

        // Click the mobile command button to open selector
        const mobileButton = screen.getByTestId('mobile-command-button');
        fireEvent.click(mobileButton);

        // Selector should be open (mobile renders as bottom sheet)
        expect(screen.getByTestId('slash-command-bottom-sheet')).toBeInTheDocument();

        // Click the free input button
        const freeInputButton = screen.getByTestId('free-input-button');
        fireEvent.click(freeInputButton);

        // Selector should be closed after free input
        expect(screen.queryByTestId('slash-command-bottom-sheet')).not.toBeInTheDocument();

        // Type a custom command
        const textarea = screen.getByPlaceholderText(/Type your message/i);
        fireEvent.change(textarea, { target: { value: '/custom' } });

        // Click mobile command button again during free input mode
        // This should reset isFreeInputMode and show selector
        fireEvent.click(mobileButton);

        // Selector should appear (isFreeInputMode was reset)
        expect(screen.getByTestId('slash-command-bottom-sheet')).toBeInTheDocument();
      });
    });
  });
});
