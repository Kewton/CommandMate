import { describe, it, expect } from 'vitest';
import { resolveAutoAnswer } from '@/lib/polling/auto-yes-resolver';
import type { PromptData, YesNoPromptData, MultipleChoicePromptData } from '@/types/models';

describe('auto-yes-resolver', () => {
  describe('yes_no prompts', () => {
    it('should return "y" for yes/no prompts', () => {
      const promptData: YesNoPromptData = {
        type: 'yes_no',
        question: 'Do you want to proceed?',
        options: ['yes', 'no'],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBe('y');
    });

    it('should return "y" regardless of default option', () => {
      const promptData: YesNoPromptData = {
        type: 'yes_no',
        question: 'Continue?',
        options: ['yes', 'no'],
        status: 'pending',
        defaultOption: 'no',
      };

      expect(resolveAutoAnswer(promptData)).toBe('y');
    });
  });

  describe('multiple_choice prompts', () => {
    it('should return default option number when available', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select an option:',
        options: [
          { number: 1, label: 'Option A', isDefault: false },
          { number: 2, label: 'Option B', isDefault: true },
          { number: 3, label: 'Option C', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBe('2');
    });

    it('should return first option number when no default', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select:',
        options: [
          { number: 1, label: 'Option A', isDefault: false },
          { number: 2, label: 'Option B', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBe('1');
    });

    it('should return null when default option requires text input', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select:',
        options: [
          { number: 1, label: 'Type here to explain', isDefault: true, requiresTextInput: true },
          { number: 2, label: 'Cancel', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBeNull();
    });

    it('should return null when first option requires text input and no default', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select:',
        options: [
          { number: 1, label: 'Enter custom value', isDefault: false, requiresTextInput: true },
          { number: 2, label: 'Cancel', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBeNull();
    });

    it('should return null when options array is empty', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select:',
        options: [],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBeNull();
    });
  });

  describe('unknown prompt types', () => {
    it('should return null for unknown prompt types', () => {
      const promptData = {
        type: 'input',
        question: 'Enter a value:',
        status: 'pending',
      } as unknown as PromptData;

      expect(resolveAutoAnswer(promptData)).toBeNull();
    });
  });

  // =========================================================================
  // Issue #704: Claude v2.1.142 Use skill approval prompt
  //
  // Once prompt-detector returns the correct multiple_choice payload (1=Yes,
  // 2=Yes-and-dont-ask-again, 3=No, default=Yes), resolveAutoAnswer must
  // surface "1" so that Auto-Yes fires the Yes response.
  // =========================================================================
  describe('Issue #704: Use skill approval prompt', () => {
    it('should resolve to "1" (Yes) for the Use skill Yes/Yes2nd/No multiple_choice prompt', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Use skill "multi-stage-issue-review"? Do you want to proceed?',
        options: [
          { number: 1, label: 'Yes', isDefault: true },
          { number: 2, label: 'Yes, and don\'t ask again for multi-stage-issue-review in <path>', isDefault: false },
          { number: 3, label: 'No', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBe('1');
    });
  });
});
