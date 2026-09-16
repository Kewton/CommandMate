/**
 * Tests for PromptPanel component
 *
 * Tests the prompt response UI for yes/no, multiple choice, and text input prompts
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Import will be created in implementation phase
import { PromptPanel, optionTakesTypedText } from '@/components/worktree/PromptPanel';
import { isTypedTextFieldOption } from '@/lib/detection/prompt-detect-multiple-choice';
import type { YesNoPromptData, MultipleChoicePromptData, PromptData } from '@/types/models';

describe('PromptPanel', () => {
  const defaultProps = {
    promptData: null,
    messageId: null,
    visible: false,
    answering: false,
    onRespond: vi.fn(),
    onDismiss: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Visibility', () => {
    it('should not render when visible is false', () => {
      render(<PromptPanel {...defaultProps} visible={false} />);
      expect(screen.queryByTestId('prompt-panel')).not.toBeInTheDocument();
    });

    it('should render when visible is true and promptData exists', () => {
      const yesNoPrompt: YesNoPromptData = {
        type: 'yes_no',
        question: 'Continue?',
        options: ['yes', 'no'],
        status: 'pending',
      };

      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    });

    it('should not render when visible is true but promptData is null', () => {
      render(<PromptPanel {...defaultProps} visible={true} promptData={null} />);
      expect(screen.queryByTestId('prompt-panel')).not.toBeInTheDocument();
    });
  });

  describe('Yes/No Prompt', () => {
    const yesNoPrompt: YesNoPromptData = {
      type: 'yes_no',
      question: 'Do you want to continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    it('should display the question text', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      expect(screen.getByText('Do you want to continue?')).toBeInTheDocument();
    });

    it('should display Yes and No buttons', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      expect(screen.getByRole('button', { name: /yes/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /no/i })).toBeInTheDocument();
    });

    it('should call onRespond with "yes" when Yes button is clicked', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
          onRespond={onRespond}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /yes/i }));

      await waitFor(() => {
        // Issue #1932: the panel passes back the `decisionId` it was given —
        // undefined here, because these props name none.
        expect(onRespond).toHaveBeenCalledWith('yes', undefined);
      });
    });

    it('should call onRespond with "no" when No button is clicked', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
          onRespond={onRespond}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /no/i }));

      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('no', undefined);
      });
    });

    it('should highlight default option when specified', () => {
      const promptWithDefault: YesNoPromptData = {
        ...yesNoPrompt,
        defaultOption: 'yes',
      };

      render(
        <PromptPanel
          {...defaultProps}
          promptData={promptWithDefault}
          messageId="msg-1"
          visible={true}
        />
      );

      const yesButton = screen.getByRole('button', { name: /yes/i });
      // Default option should have visual indication (e.g., primary styling)
      expect(yesButton.className).toMatch(/primary|default|highlighted/);
    });
  });

  describe('Multiple Choice Prompt', () => {
    const multipleChoicePrompt: MultipleChoicePromptData = {
      type: 'multiple_choice',
      question: 'Select an option:',
      options: [
        { number: 1, label: 'Option A', isDefault: false },
        { number: 2, label: 'Option B', isDefault: true },
        { number: 3, label: 'Option C', isDefault: false },
      ],
      status: 'pending',
    };

    it('should display all options', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={multipleChoicePrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      expect(screen.getByText(/Option A/)).toBeInTheDocument();
      expect(screen.getByText(/Option B/)).toBeInTheDocument();
      expect(screen.getByText(/Option C/)).toBeInTheDocument();
    });

    it('should have radio buttons for options', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={multipleChoicePrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      const radioButtons = screen.getAllByRole('radio');
      expect(radioButtons).toHaveLength(3);
    });

    it('should select default option by default', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={multipleChoicePrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      const radioButtons = screen.getAllByRole('radio');
      // Option B (index 1) should be checked by default
      expect(radioButtons[1]).toBeChecked();
    });

    it('should call onRespond with selected option number when submitted', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <PromptPanel
          {...defaultProps}
          promptData={multipleChoicePrompt}
          messageId="msg-1"
          visible={true}
          onRespond={onRespond}
        />
      );

      // Select option 1
      const radioButtons = screen.getAllByRole('radio');
      fireEvent.click(radioButtons[0]);

      // Submit
      const submitButton = screen.getByRole('button', { name: /submit|send|confirm/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('1', undefined);
      });
    });

    it('should allow changing selection before submitting', async () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={multipleChoicePrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      const radioButtons = screen.getAllByRole('radio');

      // Initially option 2 is selected (default)
      expect(radioButtons[1]).toBeChecked();

      // Change to option 3
      fireEvent.click(radioButtons[2]);

      expect(radioButtons[2]).toBeChecked();
      expect(radioButtons[1]).not.toBeChecked();
    });
  });

  describe('Text Input Option', () => {
    // Issue #2573: the field is offered for an option that IS a text field on
    // screen — Command Code's `Type something...` (#2522), as its reader
    // publishes it — not for every `requiresTextInput` row.
    const multipleChoiceWithInput: MultipleChoicePromptData = {
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

    it('should show text input when option with requiresTextInput is selected', async () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={multipleChoiceWithInput}
          messageId="msg-1"
          visible={true}
        />
      );

      // Select the option that requires text input
      const radioButtons = screen.getAllByRole('radio');
      fireEvent.click(radioButtons[1]);

      await waitFor(() => {
        expect(screen.getByRole('textbox')).toBeInTheDocument();
      });
    });

    it('should not show text input for options without requiresTextInput', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={multipleChoiceWithInput}
          messageId="msg-1"
          visible={true}
        />
      );

      // Option 1 is selected by default (no text input)
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('should include text input value in response', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <PromptPanel
          {...defaultProps}
          promptData={multipleChoiceWithInput}
          messageId="msg-1"
          visible={true}
          onRespond={onRespond}
        />
      );

      // Select option with text input
      const radioButtons = screen.getAllByRole('radio');
      fireEvent.click(radioButtons[1]);

      // Enter text
      const textInput = screen.getByRole('textbox');
      fireEvent.change(textInput, { target: { value: 'custom value' } });

      // Submit
      const submitButton = screen.getByRole('button', { name: /submit|send|confirm/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('custom value', undefined);
      });
    });
  });

  describe('Menu rows that read as taking text (Issue #2573)', () => {
    /**
     * Command Code 1.53.1's permission dialog as the generic parser reads it off
     * `tests/fixtures/command-code-live-2250/dialog-shell-command.txt`. Row 3 is
     * `requiresTextInput` by its words and a plain menu row on screen: a reason
     * typed at it reached nothing and the Enter after it confirmed `1. Yes`.
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

    it('offers no text field for the "No, tell … differently" row', async () => {
      render(
        <PromptPanel {...defaultProps} promptData={commandCodePermission} messageId="msg-1" visible={true} />
      );

      fireEvent.click(screen.getAllByRole('radio')[2]);

      await waitFor(() => {
        expect(screen.getAllByRole('radio')[2]).toBeChecked();
      });
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('sends the option NUMBER for that row, never text', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <PromptPanel
          {...defaultProps}
          promptData={commandCodePermission}
          messageId="msg-1"
          visible={true}
          onRespond={onRespond}
        />
      );

      fireEvent.click(screen.getAllByRole('radio')[2]);
      fireEvent.click(screen.getByRole('button', { name: /submit|send|confirm/i }));

      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('3', undefined);
      });
      expect(onRespond).toHaveBeenCalledTimes(1);
    });

    it('does not carry text typed for a field row over to a menu row', async () => {
      // One option list with both kinds, so the switch happens inside one panel:
      // text typed while the field row was selected must not be what the menu
      // row submits.
      const mixed: MultipleChoicePromptData = {
        ...commandCodePermission,
        options: [
          ...commandCodePermission.options,
          { number: 4, label: 'Type something...', isDefault: false, requiresTextInput: true },
        ],
      };
      const onRespond = vi.fn().mockResolvedValue(undefined);
      render(
        <PromptPanel {...defaultProps} promptData={mixed} messageId="msg-1" visible={true} onRespond={onRespond} />
      );

      fireEvent.click(screen.getAllByRole('radio')[3]);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'use the other directory' } });
      fireEvent.click(screen.getAllByRole('radio')[2]);
      fireEvent.click(screen.getByRole('button', { name: /submit|send|confirm/i }));

      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('3', undefined);
      });
    });

    it('agrees with the detection module about which rows take typed text', () => {
      // The panel restates the rule because it cannot import that module; this is
      // what keeps the copy from drifting. `false` and absent are both covered so a
      // copy that ignored `requiresTextInput` would fail too.
      const labels = [
        'Yes',
        'No, tell Command Code what to do differently',
        'No, and tell Codex what to do differently (esc)',
        'No, and tell Copilot what to do differently (Esc to stop)',
        'No, and tell Claude what to do differently (esc)',
        'Type something...',
        'Type something... Give me a branch name and I will check it out before dispatching.',
        'Type something.',
        '  type something',
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
      expect(labels.filter((label) => optionTakesTypedText({ label, requiresTextInput: true }))).toEqual([
        'Type something...',
        'Type something... Give me a branch name and I will check it out before dispatching.',
        'Type something.',
        '  type something',
      ]);
    });
  });

  describe('Answering State', () => {
    const yesNoPrompt: YesNoPromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    it('should disable buttons when answering is true', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
          answering={true}
        />
      );

      expect(screen.getByRole('button', { name: /yes/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /no/i })).toBeDisabled();
    });

    it('should show loading indicator when answering', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
          answering={true}
        />
      );

      expect(screen.getByTestId('answering-indicator')).toBeInTheDocument();
    });

    it('should not show loading indicator when not answering', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
          answering={false}
        />
      );

      expect(screen.queryByTestId('answering-indicator')).not.toBeInTheDocument();
    });
  });

  describe('Dismiss functionality', () => {
    const yesNoPrompt: YesNoPromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    it('should call onDismiss when dismiss button is clicked', () => {
      const onDismiss = vi.fn();
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
          onDismiss={onDismiss}
        />
      );

      const dismissButton = screen.getByLabelText(/close|dismiss/i);
      fireEvent.click(dismissButton);

      expect(onDismiss).toHaveBeenCalled();
    });

    it('should not render dismiss button when onDismiss is not provided', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
          onDismiss={undefined}
        />
      );

      expect(screen.queryByLabelText(/close|dismiss/i)).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    const yesNoPrompt: YesNoPromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    it('should have appropriate ARIA attributes', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      const panel = screen.getByTestId('prompt-panel');
      expect(panel).toHaveAttribute('role', 'dialog');
      expect(panel).toHaveAttribute('aria-labelledby');
    });

    it('should have accessible labels for buttons', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      expect(screen.getByRole('button', { name: /yes/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /no/i })).toBeInTheDocument();
    });

    it('should support keyboard navigation', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined);

      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
          onRespond={onRespond}
        />
      );

      // Focus Yes button and press Enter via keyboard event
      const yesButton = screen.getByRole('button', { name: /yes/i });
      yesButton.focus();
      fireEvent.keyDown(yesButton, { key: 'Enter', code: 'Enter' });
      fireEvent.click(yesButton); // Simulate click that would result from Enter

      await waitFor(() => {
        expect(onRespond).toHaveBeenCalledWith('yes', undefined);
      });
    });
  });

  describe('Animation', () => {
    const yesNoPrompt: YesNoPromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    it('should have animation class when visible', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      const panel = screen.getByTestId('prompt-panel');
      // Should have transition/animation related classes
      expect(panel.className).toMatch(/transition|animate|fade/);
    });
  });

  describe('Error handling', () => {
    const yesNoPrompt: YesNoPromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    it('should handle onRespond rejection gracefully', async () => {
      const onRespond = vi.fn().mockRejectedValue(new Error('Network error'));

      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
          onRespond={onRespond}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /yes/i }));

      // Should not crash
      await waitFor(() => {
        expect(onRespond).toHaveBeenCalled();
      });
    });
  });

  describe('Styling', () => {
    const yesNoPrompt: YesNoPromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    it('should have proper container styling', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      const panel = screen.getByTestId('prompt-panel');
      // Should have background and padding classes
      expect(panel.className).toMatch(/bg-|p-/);
    });

    it('should have rounded corners', () => {
      render(
        <PromptPanel
          {...defaultProps}
          promptData={yesNoPrompt}
          messageId="msg-1"
          visible={true}
        />
      );

      const panel = screen.getByTestId('prompt-panel');
      expect(panel.className).toMatch(/rounded/);
    });
  });
});
