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
import { useSlashCommands } from '@/hooks/useSlashCommands';
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
    uploadImageFile: vi.fn().mockResolvedValue({ path: '.commandmate/attachments/test.png' }),
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
    vi.mocked(useSlashCommands).mockReturnValue({
      groups: mockCommandGroups,
      filteredGroups: mockCommandGroups,
      allCommands: mockCommandGroups.flatMap(g => g.commands),
      loading: false,
      error: null,
      filter: '',
      setFilter: vi.fn(),
      refresh: vi.fn(),
      cliTool: 'claude',
    });
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

    // Issue #1080: the send button switches from a ghost affordance to a filled
    // accent circle when the composer holds a sendable message.
    it('should change send button class between ghost and filled on input (Issue #1080)', () => {
      render(<MessageInput {...defaultProps} />);

      const emptyBtn = getSendButton();
      expect(emptyBtn.getAttribute('data-can-send')).toBe('false');
      expect(emptyBtn.className).toContain('text-muted-foreground/50');
      expect(emptyBtn.className).not.toContain('bg-accent-600');

      typeMessage('Hello');

      const filledBtn = getSendButton();
      expect(filledBtn.getAttribute('data-can-send')).toBe('true');
      expect(filledBtn.className).toContain('bg-accent-600');
      expect(filledBtn.className).toContain('text-white');
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
          { cliToolId: 'claude' }
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
          { cliToolId: 'claude' }
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
          { cliToolId: 'claude' }
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
            { cliToolId: 'claude' }
          );
        });
      });

      it('should insert Codex skill using $<name> format when selected (Issue #790)', async () => {
        const codexGroups = [
          {
            category: 'skill' as const,
            label: 'Skills',
            commands: [
              {
                name: 'github-insights',
                description: 'Codex skill',
                category: 'skill' as const,
                filePath: '.codex/skills/github-insights/SKILL.md',
                source: 'codex-skill' as const,
                cliTools: ['codex'] as ('codex')[],
              },
            ],
          },
        ];
        vi.mocked(useSlashCommands).mockReturnValue({
          groups: codexGroups,
          filteredGroups: codexGroups,
          allCommands: codexGroups.flatMap(g => g.commands),
          loading: false,
          error: null,
          filter: '',
          setFilter: vi.fn(),
          refresh: vi.fn(),
          cliTool: 'codex',
        });

        render(<MessageInput {...defaultProps} cliToolId="codex" />);

        openSelector();
        fireEvent.click(screen.getByText('$github-insights'));

        expect(getTextarea()).toHaveValue('$github-insights ');
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

      it('TC-8: should submit slash command without space via Enter in free input mode (Issue #288)', async () => {
        const { worktreeApi } = await import('@/lib/api-client');

        render(<MessageInput {...defaultProps} />);

        enterFreeInputMode();

        // Type a command without space (e.g., /compact)
        typeMessage('/compact');

        pressEnter();

        await waitFor(() => {
          expect(worktreeApi.sendMessage).toHaveBeenCalledWith(
            'test-worktree',
            '/compact',
            { cliToolId: 'claude' }
          );
        });
      });

      it('TC-9: should not submit when selector is open in normal mode (not free input)', async () => {
        const { worktreeApi } = await import('@/lib/api-client');

        render(<MessageInput {...defaultProps} />);

        // Type '/' to open selector (normal mode, not free input)
        openSelector();
        expect(queryDesktopSelector()).toBeInTheDocument();

        // Press Enter - should select command, not submit
        pressEnter();

        await delay();

        expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
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

  // ===== Dollar trigger for Codex skills (Issue #799) =====

  describe('Dollar trigger for Codex skills (Issue #799)', () => {
    beforeEach(() => {
      setMobileMode(false);
    });

    it('opens the command selector when "$" is typed on the Codex tab', () => {
      render(<MessageInput {...defaultProps} cliToolId="codex" />);

      expect(queryDesktopSelector()).not.toBeInTheDocument();

      typeMessage('$');

      expect(queryDesktopSelector()).toBeInTheDocument();
    });

    it('keeps the selector open while typing a "$name" command on the Codex tab', () => {
      render(<MessageInput {...defaultProps} cliToolId="codex" />);

      typeMessage('$orchestrate');

      expect(queryDesktopSelector()).toBeInTheDocument();
    });

    it('closes the selector when a space follows the "$" trigger on the Codex tab', () => {
      render(<MessageInput {...defaultProps} cliToolId="codex" />);

      typeMessage('$');
      expect(queryDesktopSelector()).toBeInTheDocument();

      typeMessage('$orchestrate now');
      expect(queryDesktopSelector()).not.toBeInTheDocument();
    });

    it('does NOT open the selector on "$" for non-Codex tabs (claude)', () => {
      render(<MessageInput {...defaultProps} cliToolId="claude" />);

      typeMessage('$');

      expect(queryDesktopSelector()).not.toBeInTheDocument();
    });

    it('does NOT open the selector on "$" when cliToolId is omitted (defaults to claude)', () => {
      const propsWithoutCliTool = {
        worktreeId: 'test-worktree',
        onMessageSent: vi.fn(),
      };

      render(<MessageInput {...propsWithoutCliTool} />);

      typeMessage('$');

      expect(queryDesktopSelector()).not.toBeInTheDocument();
    });

    it('still opens the selector on "/" on the Codex tab (existing behavior unchanged)', () => {
      render(<MessageInput {...defaultProps} cliToolId="codex" />);

      openSelector();

      expect(queryDesktopSelector()).toBeInTheDocument();
    });
  });

  // ===== pendingInsertText behavior (Issue #485) =====

  describe('pendingInsertText insertion (Issue #485)', () => {
    it('should insert text into empty message when pendingInsertText is provided', () => {
      const onInsertConsumed = vi.fn();
      render(
        <MessageInput
          {...defaultProps}
          pendingInsertText="Inserted text"
          onInsertConsumed={onInsertConsumed}
        />
      );

      expect(getTextarea().value).toBe('Inserted text');
      expect(onInsertConsumed).toHaveBeenCalled();
    });

    it('should append text with double newline when message already has content', () => {
      const onInsertConsumed = vi.fn();
      const { rerender } = render(
        <MessageInput {...defaultProps} />
      );

      // Type some existing text
      typeMessage('Existing text');

      // Rerender with pendingInsertText
      rerender(
        <MessageInput
          {...defaultProps}
          pendingInsertText="Appended text"
          onInsertConsumed={onInsertConsumed}
        />
      );

      expect(getTextarea().value).toBe('Existing text\n\nAppended text');
      expect(onInsertConsumed).toHaveBeenCalled();
    });

    it('should not insert when pendingInsertText is null', () => {
      const onInsertConsumed = vi.fn();
      render(
        <MessageInput
          {...defaultProps}
          pendingInsertText={null}
          onInsertConsumed={onInsertConsumed}
        />
      );

      expect(getTextarea().value).toBe('');
      expect(onInsertConsumed).not.toHaveBeenCalled();
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
          { cliToolId: 'claude' }
        );
      });
    });
  });

  // ===== Issue #728: splitIndex / draft scoping / migration / onFocus =====

  describe('Issue #728 — splitIndex + draft scoping', () => {
    beforeEach(() => {
      window.localStorage.clear();
    });

    it('persists drafts under per-split keys', async () => {
      const { rerender } = render(
        <MessageInput {...defaultProps} splitIndex={0} />
      );
      typeMessage('first split text');
      await waitFor(() => {
        expect(
          window.localStorage.getItem('commandmate:draft-message:test-worktree:0'),
        ).toBe('first split text');
      });

      rerender(<MessageInput {...defaultProps} splitIndex={1} />);
      // After rerender with splitIndex=1, draft for index 0 should still be there.
      expect(
        window.localStorage.getItem('commandmate:draft-message:test-worktree:0'),
      ).toBe('first split text');
      typeMessage('second split text');
      await waitFor(() => {
        expect(
          window.localStorage.getItem('commandmate:draft-message:test-worktree:1'),
        ).toBe('second split text');
      });
      expect(
        window.localStorage.getItem('commandmate:draft-message:test-worktree:0'),
      ).toBe('first split text');
    });

    it('migrates legacy draft key to splitIndex=0 on mount', () => {
      window.localStorage.setItem(
        'commandmate:draft-message:test-worktree',
        'legacy-draft',
      );
      render(<MessageInput {...defaultProps} splitIndex={0} />);
      expect(
        window.localStorage.getItem('commandmate:draft-message:test-worktree'),
      ).toBeNull();
      expect(
        window.localStorage.getItem('commandmate:draft-message:test-worktree:0'),
      ).toBe('legacy-draft');
      const textarea = getTextarea();
      expect(textarea.value).toBe('legacy-draft');
    });

    it('migration does not overwrite an existing splitIndex=0 draft', () => {
      window.localStorage.setItem(
        'commandmate:draft-message:test-worktree:0',
        'newer-draft',
      );
      window.localStorage.setItem(
        'commandmate:draft-message:test-worktree',
        'older-legacy-draft',
      );
      render(<MessageInput {...defaultProps} splitIndex={0} />);
      // Legacy key is still cleaned up.
      expect(
        window.localStorage.getItem('commandmate:draft-message:test-worktree'),
      ).toBeNull();
      // But the existing new-format draft is preserved.
      expect(
        window.localStorage.getItem('commandmate:draft-message:test-worktree:0'),
      ).toBe('newer-draft');
    });

    it('migration is skipped for splitIndex !== 0', () => {
      window.localStorage.setItem(
        'commandmate:draft-message:test-worktree',
        'legacy-draft',
      );
      render(<MessageInput {...defaultProps} splitIndex={1} />);
      // Legacy key remains because splitIndex=1 should not run migration
      expect(
        window.localStorage.getItem('commandmate:draft-message:test-worktree'),
      ).toBe('legacy-draft');
    });

    it('calls onFocus prop when the textarea gains focus', () => {
      const onFocus = vi.fn();
      render(<MessageInput {...defaultProps} onFocus={onFocus} />);
      fireEvent.focus(getTextarea());
      expect(onFocus).toHaveBeenCalled();
    });
  });

  // ===== Issue #806: queued (session busy) toast =====

  describe('Issue #806 — queued (session busy) toast', () => {
    beforeEach(() => {
      setMobileMode(false);
    });

    it('shows a warning toast after a successful send when the session is busy (isProcessing=true)', async () => {
      const { worktreeApi } = await import('@/lib/api-client');
      const showToast = vi.fn();

      render(
        <MessageInput {...defaultProps} isProcessing showToast={showToast} />
      );

      typeMessage('queued while busy');
      pressEnter();

      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalled();
      });
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Queued (session busy)'),
        'warning'
      );
    });

    it('does NOT show a toast when the session is idle (isProcessing=false)', async () => {
      const { worktreeApi } = await import('@/lib/api-client');
      const showToast = vi.fn();

      render(
        <MessageInput
          {...defaultProps}
          isProcessing={false}
          showToast={showToast}
        />
      );

      typeMessage('sent while idle');
      pressEnter();

      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalled();
      });
      expect(showToast).not.toHaveBeenCalled();
    });

    it('does NOT show a toast when isProcessing is omitted (default idle behavior unchanged)', async () => {
      const { worktreeApi } = await import('@/lib/api-client');
      const showToast = vi.fn();

      render(<MessageInput {...defaultProps} showToast={showToast} />);

      typeMessage('no isProcessing prop');
      pressEnter();

      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalled();
      });
      expect(showToast).not.toHaveBeenCalled();
    });

    it('does NOT show a toast when the send fails even if the session is busy', async () => {
      const { worktreeApi } = await import('@/lib/api-client');
      vi.mocked(worktreeApi.sendMessage).mockRejectedValueOnce(
        new Error('Network error')
      );
      const showToast = vi.fn();

      render(
        <MessageInput {...defaultProps} isProcessing showToast={showToast} />
      );

      typeMessage('busy but fails');
      pressEnter();

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
      expect(showToast).not.toHaveBeenCalled();
    });

    it('does not throw when busy but no showToast is provided', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} isProcessing />);

      typeMessage('busy without toast surface');
      pressEnter();

      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalled();
      });
    });
  });

  // ===== Keyboard follow (Issue #1128) =====

  describe('Keyboard follow (Issue #1128)', () => {
    const originalVisualViewport = window.visualViewport;

    afterEach(() => {
      Object.defineProperty(window, 'visualViewport', {
        value: originalVisualViewport,
        configurable: true,
        writable: true,
      });
    });

    /** Mock a visualViewport shrunk by `heightDiff` (i.e. keyboard height). */
    function mockKeyboard(heightDiff: number) {
      Object.defineProperty(window, 'visualViewport', {
        value: {
          height: window.innerHeight - heightDiff,
          width: 375,
          offsetTop: 0,
          offsetLeft: 0,
          pageTop: 0,
          pageLeft: 0,
          scale: 1,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        },
        configurable: true,
        writable: true,
      });
    }

    it('translates the composer up by the keyboard height when keyboardAware', () => {
      mockKeyboard(300);
      render(<MessageInput {...defaultProps} keyboardAware />);

      const container = screen.getByTestId('message-input-container');
      expect(container.style.transform).toBe('translateY(-300px)');
    });

    it('does not translate when keyboardAware is off', () => {
      mockKeyboard(300);
      render(<MessageInput {...defaultProps} />);

      const container = screen.getByTestId('message-input-container');
      expect(container.style.transform).toBe('');
    });

    it('does not translate when the keyboard is hidden', () => {
      // Below the 100px keyboard threshold → treated as no keyboard.
      mockKeyboard(0);
      render(<MessageInput {...defaultProps} keyboardAware />);

      const container = screen.getByTestId('message-input-container');
      expect(container.style.transform).toBe('');
    });
  });
});
