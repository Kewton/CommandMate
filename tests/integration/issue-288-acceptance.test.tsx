/**
 * Acceptance Tests for Issue #288
 *
 * Verifies: "Enter custom command" selection followed by custom command input
 * does not cause the selector to re-display, and Enter key submits correctly.
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
  queryDesktopSelector,
  queryMobileSheet,
  typeMessage,
  openSelector,
  enterFreeInputMode,
  pressEnter,
  pressEscape,
  clickMobileCommandButton,
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

describe('Issue #288 Acceptance Tests: Free Input Mode prevents selector re-display', () => {
  const defaultProps = createDefaultProps();

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
  });

  afterEach(() => {
    mockIsMobile = false;
  });

  // =========================================================================
  // AC-1: After selecting "Enter custom command...", user can enter a custom
  //        command and submit with Enter key
  // =========================================================================
  describe('AC-1: Custom command entry and Enter submission', () => {
    it('Scenario 1: Desktop - click free input button, type /model gpt-4o, press Enter to send', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      // Step 1: Type '/' to open the selector
      openSelector();
      expect(queryDesktopSelector()).toBeInTheDocument();

      // Step 2: Click the free input button
      const freeInputButton = screen.getByTestId('free-input-button');
      fireEvent.click(freeInputButton);

      // Step 3: Selector should close
      expect(queryDesktopSelector()).not.toBeInTheDocument();

      // Step 4: Type custom command with space (sendable)
      typeMessage('/model gpt-4o');

      // Step 5: Selector should remain hidden
      expect(queryDesktopSelector()).not.toBeInTheDocument();

      // Step 6: Press Enter to submit
      pressEnter();

      // Step 7: Verify message was sent
      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalledWith(
          'test-worktree',
          '/model gpt-4o',
          'claude'
        );
      });
    });
  });

  // =========================================================================
  // AC-2: Command selector does not re-display during custom command input
  // =========================================================================
  describe('AC-2: Selector stays hidden during free input mode', () => {
    it('Scenario 2: Typing additional characters in free input mode does not re-display selector', () => {
      render(<MessageInput {...defaultProps} />);

      // Open selector and enter free input mode
      enterFreeInputMode();
      expect(queryDesktopSelector()).not.toBeInTheDocument();

      // Type various command strings - selector should never reappear
      typeMessage('/m');
      expect(queryDesktopSelector()).not.toBeInTheDocument();

      typeMessage('/model');
      expect(queryDesktopSelector()).not.toBeInTheDocument();

      typeMessage('/model gpt-4o');
      expect(queryDesktopSelector()).not.toBeInTheDocument();

      typeMessage('/model gpt-4o --temp 0.5');
      expect(queryDesktopSelector()).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // AC-3: Normal '/' input (not in free input mode) shows selector as before
  // =========================================================================
  describe('AC-3: Normal "/" input shows selector (backward compatibility)', () => {
    it('Scenario 4: Typing "/" without entering free input mode shows the selector normally', () => {
      render(<MessageInput {...defaultProps} />);

      // Type '/' normally
      openSelector();
      expect(queryDesktopSelector()).toBeInTheDocument();

      // Continue typing without space still shows selector
      typeMessage('/te');
      expect(queryDesktopSelector()).toBeInTheDocument();

      // Space hides selector (normal behavior)
      typeMessage('/test ');
      expect(queryDesktopSelector()).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // AC-4: Works for both Codex and Claude Code
  // =========================================================================
  describe('AC-4: Works for both Codex and Claude Code cliToolId', () => {
    it('should work with claude cliToolId', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...createDefaultProps({ cliToolId: 'claude' })} />);

      enterFreeInputMode();
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

    it('should work with codex cliToolId', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...createDefaultProps({ cliToolId: 'codex' })} />);

      enterFreeInputMode();
      typeMessage('/model gpt-4o');
      pressEnter();

      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalledWith(
          'test-worktree',
          '/model gpt-4o',
          'codex'
        );
      });
    });
  });

  // =========================================================================
  // AC-5: Existing slash command selection unaffected
  // =========================================================================
  describe('AC-5: Existing slash command selection unaffected', () => {
    it('selecting a command from the selector still works normally', () => {
      render(<MessageInput {...defaultProps} />);

      // Type '/' to open selector
      openSelector();
      expect(queryDesktopSelector()).toBeInTheDocument();

      // Click a command
      const command = screen.getByText('/test-command');
      fireEvent.click(command);

      // Selector should close and message should be set
      expect(queryDesktopSelector()).not.toBeInTheDocument();
      expect(getTextarea()).toHaveValue('/test-command ');
    });
  });

  // =========================================================================
  // AC-6: Clearing message in free input mode resets, then '/' shows selector
  // =========================================================================
  describe('AC-6: Clearing message in free input mode resets state', () => {
    it('Scenario 3: After clearing all text in free input mode, typing "/" shows selector again', () => {
      render(<MessageInput {...defaultProps} />);

      // Enter free input mode
      enterFreeInputMode();

      // Type some custom command
      typeMessage('/custom');
      expect(queryDesktopSelector()).not.toBeInTheDocument();

      // Clear the message entirely
      typeMessage('');

      // Type '/' again - selector should reappear (isFreeInputMode was reset)
      openSelector();
      expect(queryDesktopSelector()).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Scenario 5: isFreeInputMode resets after message submission
  // =========================================================================
  describe('Scenario 5: isFreeInputMode resets after message submission', () => {
    it('after submitting in free input mode, typing "/" shows selector', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      render(<MessageInput {...defaultProps} />);

      enterFreeInputMode();

      // Type and submit
      typeMessage('/test command');
      pressEnter();

      await waitFor(() => {
        expect(worktreeApi.sendMessage).toHaveBeenCalled();
      });

      // After submit, message is cleared and isFreeInputMode is reset
      openSelector();
      expect(queryDesktopSelector()).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Scenario 6: Escape key resets isFreeInputMode
  // =========================================================================
  describe('Scenario 6: Escape key resets isFreeInputMode', () => {
    it('pressing Escape while selector is open resets free input mode', () => {
      render(<MessageInput {...defaultProps} />);

      // Open selector
      openSelector();
      expect(queryDesktopSelector()).toBeInTheDocument();

      // Press Escape
      pressEscape();
      expect(queryDesktopSelector()).not.toBeInTheDocument();

      // Clear and re-type '/'
      typeMessage('');
      openSelector();

      // Selector should appear (isFreeInputMode was reset by handleCommandCancel)
      expect(queryDesktopSelector()).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Scenario 7: Mobile - command button resets isFreeInputMode
  // =========================================================================
  describe('Scenario 7: Mobile command button resets free input mode', () => {
    beforeEach(() => {
      mockIsMobile = true;
    });

    afterEach(() => {
      mockIsMobile = false;
    });

    it('clicking mobile command button during free input mode resets mode and shows selector', () => {
      render(<MessageInput {...defaultProps} />);

      // Click mobile command button to open selector
      clickMobileCommandButton();
      expect(queryMobileSheet()).toBeInTheDocument();

      // Click free input button
      const freeInputButton = screen.getByTestId('free-input-button');
      fireEvent.click(freeInputButton);
      expect(queryMobileSheet()).not.toBeInTheDocument();

      // Type a custom command
      typeMessage('/custom');

      // Click mobile command button again
      clickMobileCommandButton();

      // Selector should appear (isFreeInputMode was reset by the button click)
      expect(queryMobileSheet()).toBeInTheDocument();
    });
  });
});
