/**
 * Tests for MessageInput component
 *
 * Tests keyboard behavior for message submission on desktop and mobile devices.
 * Tests IME composition handling.
 * Tests free input mode behavior (Issue #288).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import {
  mockCommandGroups,
  createDefaultProps,
  getTextarea,
  getSendButton,
  queryDesktopSelector,
  typeMessage,
  openSelector,
  enterFreeInputMode,
  pressEnter,
  pressEscape,
  pressKey,
  clickMobileCommandButton,
  queryMobileSheet,
  delay,
} from '@tests/helpers/message-input-test-utils';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    sendMessage: vi.fn().mockResolvedValue({}),
  },
  handleApiError: vi.fn((err: Error) => err?.message || 'Unknown error'),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups,
  })),
}));

let mockIsMobile = false;

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => mockIsMobile),
}));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MessageInput', () => {
  const defaultProps = createDefaultProps();

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
  });

  afterEach(() => {
    mockIsMobile = false;
  });

  const setMobileMode = (isMobile: boolean) => {
    mockIsMobile = isMobile;
  };

  // ===== Basic rendering =====

  describe('Basic rendering', () => {
    it('should render textarea and send button', () => {
      render(<MessageInput {...defaultProps} />);

      expect(getTextarea()).toBeInTheDocument();
      expect(getSendButton()).toBeInTheDocument();
    });

    it('should disable send button when message is empty', () => {
      render(<MessageInput {...defaultProps} />);

      expect(getSendButton()).toBeDisabled();
    });

    it('should enable send button when message has content', () => {
      render(<MessageInput {...defaultProps} />);

      typeMessage('Hello');

      expect(getSendButton()).not.toBeDisabled();
    });
  });

  // ===== Desktop behavior =====

  describe('Desktop behavior', () => {
    beforeEach(() => {
      setMobileMode(false);
    });

    it('should submit message when Enter is pressed on desktop', async () => {
      const { worktreeApi } = await import('@/lib/api-client');
      const onMessageSent = vi.fn();

      render(<MessageInput {...defaultProps} onMessageSent={onMessageSent} />);

      typeMessage('Hello world');
      pressEnter();

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

      typeMessage('Line 1');
      pressKey('Enter', { shiftKey: true });

      await delay();

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

      typeMessage('Hello mobile');
      pressEnter();

      await delay();

      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
    });

    it('should submit message when send button is clicked on mobile', async () => {
      const { worktreeApi } = await import('@/lib/api-client');
      const onMessageSent = vi.fn();

      render(<MessageInput {...defaultProps} onMessageSent={onMessageSent} />);

      typeMessage('Hello from mobile');
      fireEvent.click(getSendButton());

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

    it('should not submit when Enter is pressed during IME composition (keyCode 229)', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      typeMessage('Hello');

      // Start IME composition
      fireEvent.compositionStart(getTextarea());

      // Press Enter during composition.
      // keyCode 229 on the native KeyboardEvent indicates IME composition
      // in progress.  fireEvent.keyDown passes init properties directly to
      // the KeyboardEvent constructor, so keyCode ends up on nativeEvent.
      fireEvent.keyDown(getTextarea(), { key: 'Enter', keyCode: 229 });

      await delay();

      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
    });

    it('should not submit immediately after IME composition ends (justFinishedComposing guard)', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      typeMessage('Hello');

      // Start and end IME composition
      fireEvent.compositionStart(getTextarea());
      fireEvent.compositionEnd(getTextarea());

      // Press Enter immediately after composition ends
      pressEnter();

      await delay();

      // Protected by justFinishedComposingRef
      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
    });

    it('should clear existing composition timeout when compositionStart fires during active timeout', async () => {
      // Covers lines 100-101 (clearTimeout in handleCompositionStart)
      // and lines 114-115 (clearTimeout in handleCompositionEnd)
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      typeMessage('Hello');

      const textarea = getTextarea();

      // First composition cycle: starts the 300ms timeout
      fireEvent.compositionStart(textarea);
      fireEvent.compositionEnd(textarea);

      // Second composition cycle while the first timeout is still pending.
      // handleCompositionStart should clearTimeout of the pending timeout (line 101).
      fireEvent.compositionStart(textarea);
      // handleCompositionEnd should clearTimeout before setting new timeout (line 115).
      fireEvent.compositionEnd(textarea);

      // Enter immediately after second compositionEnd should still be blocked
      pressEnter();

      await delay();

      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
    });

    it('should allow submit after composition timeout expires (justFinishedComposing resets)', async () => {
      // Covers line 118 (justFinishedComposingRef.current = false inside setTimeout)
      vi.useFakeTimers();
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      typeMessage('Hello');

      // Start and end composition
      fireEvent.compositionStart(getTextarea());
      fireEvent.compositionEnd(getTextarea());

      // Advance past the 300ms timeout so justFinishedComposingRef resets
      vi.advanceTimersByTime(350);

      // Now Enter should work because justFinishedComposingRef is false
      pressEnter();

      await vi.waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalledWith(
          'test-worktree',
          'Hello',
          'claude'
        );
      });

      vi.useRealTimers();
    });
  });

  // ===== Accessibility =====

  describe('Accessibility', () => {
    it('should have aria-label on send button', () => {
      render(<MessageInput {...defaultProps} />);

      const sendButton = getSendButton();
      expect(sendButton).toBeInTheDocument();
      expect(sendButton).toHaveAttribute('aria-label', 'Send message');
    });

    it('should have accessible placeholder text', () => {
      render(<MessageInput {...defaultProps} />);

      expect(getTextarea()).toBeInTheDocument();
    });
  });

  // ===== Free Input Mode (Issue #288) =====

  describe('Free Input Mode (Issue #288)', () => {
    describe('Desktop', () => {
      beforeEach(() => {
        setMobileMode(false);
      });

      it('TC-1: should keep selector hidden after handleFreeInput and custom command input', () => {
        render(<MessageInput {...defaultProps} />);

        // Type '/' to open the selector
        openSelector();
        expect(queryDesktopSelector()).toBeInTheDocument();

        // Click the free input button
        const freeInputButton = screen.getByTestId('free-input-button');
        fireEvent.click(freeInputButton);

        // Selector should be closed
        expect(queryDesktopSelector()).not.toBeInTheDocument();

        // Type a custom command - selector should remain hidden
        typeMessage('/model');
        expect(queryDesktopSelector()).not.toBeInTheDocument();
      });

      it('TC-2: should submit message with Enter key after handleFreeInput', async () => {
        const { worktreeApi } = await import('@/lib/api-client');

        render(<MessageInput {...defaultProps} />);

        enterFreeInputMode();

        // Type a custom command with a space (sendable message)
        typeMessage('/model gpt-4o');

        pressEnter();

        await waitFor(() => {
          expect(worktreeApi.sendMessage).toHaveBeenCalledWith(
            'test-worktree',
            '/model gpt-4o',
            'claude'
          );
        });
      });

      it('TC-3: should show selector again after clearing message in free input mode', () => {
        render(<MessageInput {...defaultProps} />);

        enterFreeInputMode();

        typeMessage('/model');

        // Clear the message entirely
        typeMessage('');

        // Type '/' again - selector should reappear
        openSelector();
        expect(queryDesktopSelector()).toBeInTheDocument();
      });

      it('TC-4: should reset isFreeInputMode after submitMessage', async () => {
        const { worktreeApi } = await import('@/lib/api-client');

        render(<MessageInput {...defaultProps} />);

        enterFreeInputMode();

        // Type and submit a custom command
        typeMessage('/test command');
        pressEnter();

        await waitFor(() => {
          expect(worktreeApi.sendMessage).toHaveBeenCalled();
        });

        // After submit, typing '/' should show selector again
        openSelector();
        expect(queryDesktopSelector()).toBeInTheDocument();
      });

      it('TC-5: should reset isFreeInputMode after handleCommandCancel (Escape key)', () => {
        render(<MessageInput {...defaultProps} />);

        openSelector();
        expect(queryDesktopSelector()).toBeInTheDocument();

        // Press Escape to close selector
        pressEscape();
        expect(queryDesktopSelector()).not.toBeInTheDocument();

        // Clear the message and type '/' again
        typeMessage('');
        openSelector();
        expect(queryDesktopSelector()).toBeInTheDocument();
      });

      it('TC-6: should show selector on normal "/" input (not in free input mode)', () => {
        render(<MessageInput {...defaultProps} />);

        openSelector();

        expect(queryDesktopSelector()).toBeInTheDocument();
      });
    });

    describe('Mobile', () => {
      beforeEach(() => {
        setMobileMode(true);
      });

      it('TC-7: should reset isFreeInputMode when mobile command button is clicked during free input mode', () => {
        render(<MessageInput {...defaultProps} />);

        // Click the mobile command button to open selector
        clickMobileCommandButton();
        expect(queryMobileSheet()).toBeInTheDocument();

        // Click the free input button
        const freeInputButton = screen.getByTestId('free-input-button');
        fireEvent.click(freeInputButton);
        expect(queryMobileSheet()).not.toBeInTheDocument();

        // Type a custom command
        typeMessage('/custom');

        // Click mobile command button again during free input mode
        clickMobileCommandButton();

        // Selector should appear (isFreeInputMode was reset)
        expect(queryMobileSheet()).toBeInTheDocument();
      });
    });
  });

  // ===== Error handling =====

  describe('Error handling', () => {
    it('should display error message when API call fails', async () => {
      const { worktreeApi } = await import('@/lib/api-client');
      vi.mocked(worktreeApi.sendMessage).mockRejectedValueOnce(
        new Error('Network error')
      );

      render(<MessageInput {...defaultProps} />);

      typeMessage('Hello');
      pressEnter();

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('should not submit when message is only whitespace', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      typeMessage('   ');
      pressEnter();

      await delay();

      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ===== Default cliToolId fallback =====

  describe('Default cliToolId fallback', () => {
    it('should use "claude" as default cliToolId when cliToolId prop is omitted', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      const propsWithoutCliTool = {
        worktreeId: 'test-worktree',
        onMessageSent: vi.fn(),
      };

      render(<MessageInput {...propsWithoutCliTool} />);

      typeMessage('Test message');
      pressEnter();

      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalledWith(
          'test-worktree',
          'Test message',
          'claude'
        );
      });
    });
  });
});
