/**
 * Tests for MobilePromptSheet component
 *
 * Tests the mobile bottom sheet for prompt responses
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { MobilePromptSheet, optionTakesTypedText } from '@/components/mobile/MobilePromptSheet';
import type { MobilePromptSheetProps } from '@/components/mobile/MobilePromptSheet';
import { isTypedTextFieldOption } from '@/lib/detection/prompt-detect-multiple-choice';
import type { YesNoPromptData, MultipleChoicePromptData } from '@/types/models';

describe('MobilePromptSheet', () => {
  const yesNoPrompt: YesNoPromptData = {
    type: 'yes_no',
    question: 'Do you want to continue?',
    options: ['yes', 'no'],
    status: 'pending',
  };

  const defaultProps: MobilePromptSheetProps = {
    promptData: null,
    visible: false,
    answering: false,
    onRespond: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Visibility', () => {
    it('should not render when visible is false', () => {
      render(<MobilePromptSheet {...defaultProps} visible={false} />);
      expect(screen.queryByTestId('mobile-prompt-sheet')).not.toBeInTheDocument();
    });

    it('should render when visible is true and promptData exists', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );
      expect(screen.getByTestId('mobile-prompt-sheet')).toBeInTheDocument();
    });

    it('should not render when visible is true but promptData is null', () => {
      render(<MobilePromptSheet {...defaultProps} visible={true} promptData={null} />);
      expect(screen.queryByTestId('mobile-prompt-sheet')).not.toBeInTheDocument();
    });
  });

  describe('Overlay', () => {
    it('should render overlay when visible', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );
      expect(screen.getByTestId('prompt-overlay')).toBeInTheDocument();
    });

    it('should call onDismiss when overlay is clicked', () => {
      const onDismiss = vi.fn();
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
          onDismiss={onDismiss}
        />
      );

      fireEvent.click(screen.getByTestId('prompt-overlay'));

      expect(onDismiss).toHaveBeenCalled();
    });

    it('should not close when clicking the sheet content (not overlay)', () => {
      const onDismiss = vi.fn();
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
          onDismiss={onDismiss}
        />
      );

      fireEvent.click(screen.getByTestId('mobile-prompt-sheet'));

      expect(onDismiss).not.toHaveBeenCalled();
    });
  });

  describe('Bottom Sheet Styling', () => {
    it('should be positioned at bottom of screen', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');
      expect(sheet.className).toMatch(/bottom|fixed/);
    });

    it('should have rounded top corners', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');
      expect(sheet.className).toMatch(/rounded-t/);
    });

    it('should span full width', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');
      expect(sheet.className).toMatch(/w-full|inset-x-0/);
    });

    it('should have safe area padding at bottom', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');
      expect(sheet.className).toMatch(/pb-|safe/);
    });
  });

  describe('Drag Handle', () => {
    it('should render drag handle indicator', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      expect(screen.getByTestId('drag-handle')).toBeInTheDocument();
    });

    it('should have appropriate styling for drag handle', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const handle = screen.getByTestId('drag-handle');
      expect(handle.className).toMatch(/bg-|rounded/);
    });
  });

  describe('Prompt Content', () => {
    it('should display prompt question', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      expect(screen.getByText('Do you want to continue?')).toBeInTheDocument();
    });

    it('should display Yes and No buttons for yes_no prompt', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      expect(screen.getByRole('button', { name: /yes/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /no/i })).toBeInTheDocument();
    });

    it('should display options for multiple_choice prompt', () => {
      const multipleChoice: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select an option:',
        options: [
          { number: 1, label: 'Option A', isDefault: false },
          { number: 2, label: 'Option B', isDefault: true },
        ],
        status: 'pending',
      };

      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={multipleChoice}
          visible={true}
        />
      );

      expect(screen.getByText(/Option A/)).toBeInTheDocument();
      expect(screen.getByText(/Option B/)).toBeInTheDocument();
    });
  });

  describe('Options that read as taking text (Issue #2573)', () => {
    /**
     * Command Code 1.53.1's permission dialog, as the generic parser reads it off
     * `tests/fixtures/command-code-live-2250/dialog-shell-command.txt`. Row 3 is
     * `requiresTextInput` by its words and a plain menu row on screen.
     */
    const commandCodePermission: MultipleChoicePromptData = {
      type: 'multiple_choice',
      question: 'Command Code needs to execute sleep 30.',
      options: [
        { number: 1, label: 'Yes', isDefault: true, requiresTextInput: false },
        { number: 2, label: "Yes, don't ask again for `sleep` commands in this project", isDefault: false, requiresTextInput: false },
        { number: 3, label: 'No, tell Command Code what to do differently', isDefault: false, requiresTextInput: true },
      ],
      status: 'pending',
    };

    /** Command Code's `AskUserQuestion`, whose last row is a real text field (#2522). */
    const commandCodeQuestion: MultipleChoicePromptData = {
      type: 'multiple_choice',
      question: 'Which commit message should the PR use?',
      options: [
        { number: 1, label: 'Use the generated message', isDefault: true, requiresTextInput: false },
        { number: 2, label: 'Type something...', isDefault: false, requiresTextInput: true },
      ],
      status: 'pending',
      submitMode: 'answer_only',
      isAskUserQuestion: true,
    };

    it('offers no text field for the menu row and sends its NUMBER', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <MobilePromptSheet {...defaultProps} promptData={commandCodePermission} visible={true} onRespond={onRespond} />
      );

      fireEvent.click(screen.getAllByRole('radio')[2]);
      await waitFor(() => {
        expect(screen.getAllByRole('radio')[2]).toBeChecked();
      });
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /submit|send|confirm/i }));
      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('3');
      });
    });

    it('still offers the field for `Type something...` and sends the text', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <MobilePromptSheet {...defaultProps} promptData={commandCodeQuestion} visible={true} onRespond={onRespond} />
      );

      fireEvent.click(screen.getAllByRole('radio')[1]);
      const textInput = await screen.findByRole('textbox');
      fireEvent.change(textInput, { target: { value: 'Fix the flaky test first' } });
      fireEvent.click(screen.getByRole('button', { name: /submit|send|confirm/i }));

      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('Fix the flaky test first');
      });
    });

    it('agrees with the detection module about which rows take typed text', () => {
      const labels = [
        'Yes',
        'No, tell Command Code what to do differently',
        'No, and tell Codex what to do differently (esc)',
        'No, and tell Claude what to do differently (esc)',
        'Type something...',
        'Type something... Give me a branch name and I will check it out before dispatching.',
        'Type something.',
        'Enter custom value',
        'Type here to explain',
        "Yes, and always allow for commands that start with 'npm run custom'",
        'Something to type something',
      ];
      for (const label of labels) {
        for (const requiresTextInput of [true, false, undefined]) {
          const option = { number: 1, label, requiresTextInput };
          expect(optionTakesTypedText(option), `${label} / ${String(requiresTextInput)}`).toBe(
            isTypedTextFieldOption(option),
          );
        }
      }
    });
  });

  describe('Response Handling', () => {
    it('should call onRespond when Yes button is clicked', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
          onRespond={onRespond}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /yes/i }));

      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('yes');
      });
    });

    it('should call onRespond when No button is clicked', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
          onRespond={onRespond}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /no/i }));

      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('no');
      });
    });
  });

  describe('Answering State', () => {
    it('should disable buttons when answering is true', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
          answering={true}
        />
      );

      expect(screen.getByRole('button', { name: /yes/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /no/i })).toBeDisabled();
    });

    it('should show loading indicator when answering', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
          answering={true}
        />
      );

      expect(screen.getByTestId('answering-indicator')).toBeInTheDocument();
    });
  });

  describe('Animation', () => {
    it('should have slide-up animation class when visible', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');
      expect(sheet.className).toMatch(/translate|transform|animate|slide/);
    });

    it('should have transition duration', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');
      expect(sheet.className).toMatch(/transition|duration/);
    });
  });

  describe('Swipe to Dismiss (Issue #1128: unified on useSwipeGesture)', () => {
    it('should handle swipe down gesture to dismiss when exceeding threshold', async () => {
      const onDismiss = vi.fn();
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
          onDismiss={onDismiss}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');

      // Simulate touch swipe down exceeding threshold (100px). The shared hook
      // attaches native listeners and reads touchend from `changedTouches`.
      fireEvent.touchStart(sheet, { touches: [{ clientX: 0, clientY: 0 }] });
      fireEvent.touchMove(sheet, { touches: [{ clientX: 0, clientY: 150 }] });
      fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 0, clientY: 150 }] });

      await waitFor(() => {
        expect(onDismiss).toHaveBeenCalled();
      });
    });

    it('should not dismiss when swipe is below threshold', () => {
      const onDismiss = vi.fn();
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
          onDismiss={onDismiss}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');

      // Simulate small touch move (below threshold)
      fireEvent.touchStart(sheet, { touches: [{ clientX: 0, clientY: 0 }] });
      fireEvent.touchMove(sheet, { touches: [{ clientX: 0, clientY: 50 }] });
      fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 0, clientY: 50 }] });

      expect(onDismiss).not.toHaveBeenCalled();
    });

    it('should NOT dismiss on a predominantly horizontal drag (direction lock)', () => {
      const onDismiss = vi.fn();
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
          onDismiss={onDismiss}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');

      // A horizontal-dominant gesture commits to the horizontal axis and is
      // cancelled by the vertical-axis direction lock — no dismiss.
      fireEvent.touchStart(sheet, { touches: [{ clientX: 0, clientY: 0 }] });
      fireEvent.touchMove(sheet, { touches: [{ clientX: 160, clientY: 20 }] });
      fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 160, clientY: 120 }] });

      expect(onDismiss).not.toHaveBeenCalled();
    });

    it('should handle touch events without onDismiss callback', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');

      // Should not throw when no onDismiss is provided
      expect(() => {
        fireEvent.touchStart(sheet, { touches: [{ clientX: 0, clientY: 0 }] });
        fireEvent.touchMove(sheet, { touches: [{ clientX: 0, clientY: 150 }] });
        fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 0, clientY: 150 }] });
      }).not.toThrow();
    });
  });

  describe('Accessibility', () => {
    it('should have dialog role', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('should have aria-modal attribute', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    it('should trap focus within the sheet', () => {
      // Issue #1127: Tab / Shift+Tab cycle within the sheet instead of escaping
      // to the page behind the overlay.
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');
      // Initial focus lands on the sheet dialog itself.
      expect(document.activeElement).toBe(sheet);

      const buttons = Array.from(sheet.querySelectorAll('button'));
      expect(buttons.length).toBeGreaterThan(0);
      const first = buttons[0];
      const last = buttons[buttons.length - 1];

      last.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(first);

      first.focus();
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
    });
  });

  describe('Z-Index', () => {
    it('should have high z-index for overlay', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const overlay = screen.getByTestId('prompt-overlay');
      expect(overlay.className).toMatch(/z-/);
    });

    it('should have higher z-index for sheet than overlay', () => {
      render(
        <MobilePromptSheet
          {...defaultProps}
          promptData={yesNoPrompt}
          visible={true}
        />
      );

      const sheet = screen.getByTestId('mobile-prompt-sheet');
      expect(sheet.className).toMatch(/z-/);
    });
  });
});
