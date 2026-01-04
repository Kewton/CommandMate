/**
 * Prompt Detector Unit Tests
 * Tests for detecting and parsing Claude CLI yes/no prompts
 */

import { describe, it, expect } from 'vitest';
import { detectPrompt, getAnswerInput } from '@/lib/prompt-detector';
import type { PromptData, YesNoPromptData } from '@/types/models';

// Type guard for YesNoPromptData
function isYesNoPrompt(data: PromptData | undefined): data is YesNoPromptData {
  return data?.type === 'yes_no';
}

describe('Prompt Detector', () => {
  describe('detectPrompt', () => {
    describe('Pattern 1: (y/n) format', () => {
      it('should detect simple yes/no prompt', () => {
        const output = 'Do you want to proceed with this operation? (y/n)';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData).toBeDefined();
        expect(result.promptData?.type).toBe('yes_no');
        expect(result.promptData?.question).toBe('Do you want to proceed with this operation?');
        expect(result.promptData?.options).toEqual(['yes', 'no']);
        expect(result.promptData?.status).toBe('pending');
        expect(result.cleanContent).toBe('Do you want to proceed with this operation?');
      });

      it('should detect yes/no prompt with newlines', () => {
        const output = `
Some previous output
More context
Do you want to delete this file? (y/n)
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('Do you want to delete this file?');
      });

      it('should detect yes/no prompt in multi-line output', () => {
        const output = `
Command output line 1
Command output line 2
Command output line 3
Would you like to continue? (y/n)
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('Would you like to continue?');
      });
    });

    describe('Pattern 2: [y/N] format', () => {
      it('should detect yes/no prompt with default no', () => {
        const output = 'Do you want to overwrite the existing file? [y/N]';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('yes_no');
        expect(result.promptData?.question).toBe('Do you want to overwrite the existing file?');
        expect(isYesNoPrompt(result.promptData) ? result.promptData.defaultOption : undefined).toBe('no');
      });

      it('should detect prompt in longer output', () => {
        const output = `
Processing files...
File already exists: example.txt
Do you want to replace it? [y/N]
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('Do you want to replace it?');
        expect(isYesNoPrompt(result.promptData) ? result.promptData.defaultOption : undefined).toBe('no');
      });
    });

    describe('Pattern 3: [Y/n] format', () => {
      it('should detect yes/no prompt with default yes', () => {
        const output = 'Install these packages? [Y/n]';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('yes_no');
        expect(result.promptData?.question).toBe('Install these packages?');
        expect(isYesNoPrompt(result.promptData) ? result.promptData.defaultOption : undefined).toBe('yes');
      });

      it('should detect prompt with context', () => {
        const output = `
Found 5 packages to install:
- package-a
- package-b
- package-c
- package-d
- package-e
Install these packages? [Y/n]
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('Install these packages?');
        expect(isYesNoPrompt(result.promptData) ? result.promptData.defaultOption : undefined).toBe('yes');
      });
    });

    describe('Pattern 4: (yes/no) format', () => {
      it('should detect full-word prompt', () => {
        const output = 'Would you like to save changes? (yes/no)';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('yes_no');
        expect(result.promptData?.question).toBe('Would you like to save changes?');
      });

      it('should detect full-word prompt in output', () => {
        const output = `
Changes detected:
- Modified: file1.txt
- Modified: file2.txt
Would you like to commit these changes? (yes/no)
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('Would you like to commit these changes?');
      });
    });

    describe('Pattern 5: "Approve?" format', () => {
      it('should detect approval prompt', () => {
        const output = `
I will execute the following command:
  rm -rf /tmp/cache
Approve?
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('yes_no');
        expect(result.promptData?.question).toBe('Approve?');
      });

      it('should detect approval prompt with question mark', () => {
        const output = 'Approve?';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('Approve?');
      });
    });

    describe('Non-prompt detection', () => {
      it('should not detect normal text as prompt', () => {
        const output = 'This is just normal output without any prompt';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
        expect(result.promptData).toBeUndefined();
        expect(result.cleanContent).toBe(output);
      });

      it('should not detect partial patterns as prompt', () => {
        const output = 'The answer is (y/n) for yes or no';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
      });

      it('should not detect patterns in middle of text', () => {
        const output = 'Some text (y/n) more text on the same line';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
      });

      it('should handle empty output', () => {
        const output = '';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
        expect(result.cleanContent).toBe('');
      });

      it('should handle whitespace-only output', () => {
        const output = '   \n\n   ';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
      });
    });

    describe('Edge cases', () => {
      it('should handle prompt with extra whitespace', () => {
        const output = 'Do you want to continue?   (y/n)  ';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('Do you want to continue?');
      });

      it('should handle prompt with tabs', () => {
        const output = 'Do you want to continue?\t(y/n)';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
      });

      it('should prioritize first matching pattern', () => {
        const output = `
Line 1 with (y/n)
Line 2 with [Y/n]
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        // Should match the first pattern found
        expect(result.promptData).toBeDefined();
      });

      it('should handle unicode characters in question', () => {
        const output = 'ファイルを削除しますか？ (y/n)';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('ファイルを削除しますか？');
      });

      it('should handle very long questions', () => {
        const longQuestion =
          'This is a very long question that contains a lot of text to test if the detector can handle questions that exceed normal length expectations';
        const output = `${longQuestion} (y/n)`;
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe(longQuestion);
      });
    });

    describe('Real-world Claude CLI examples', () => {
      it('should detect git push prompt', () => {
        const output = `
Checked that the branch is not main/master
Would you like to push to remote? (y/n)
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('Would you like to push to remote?');
      });

      it('should detect file operation prompt', () => {
        const output = `
File src/index.ts already exists
Overwrite existing file? [y/N]
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(isYesNoPrompt(result.promptData) ? result.promptData.defaultOption : undefined).toBe('no');
      });

      it('should detect destructive operation prompt', () => {
        const output = `
This operation will delete 10 files permanently.
Are you sure you want to continue? (yes/no)
        `.trim();

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.question).toBe('Are you sure you want to continue?');
      });
    });
  });

  describe('getAnswerInput', () => {
    describe('Valid yes inputs', () => {
      it('should convert "yes" to "y"', () => {
        expect(getAnswerInput('yes')).toBe('y');
      });

      it('should convert "y" to "y"', () => {
        expect(getAnswerInput('y')).toBe('y');
      });

      it('should convert "YES" to "y"', () => {
        expect(getAnswerInput('YES')).toBe('y');
      });

      it('should convert "Yes" to "y"', () => {
        expect(getAnswerInput('Yes')).toBe('y');
      });

      it('should handle "yes" with whitespace', () => {
        expect(getAnswerInput('  yes  ')).toBe('y');
      });

      it('should handle "y" with whitespace', () => {
        expect(getAnswerInput('  y  ')).toBe('y');
      });
    });

    describe('Valid no inputs', () => {
      it('should convert "no" to "n"', () => {
        expect(getAnswerInput('no')).toBe('n');
      });

      it('should convert "n" to "n"', () => {
        expect(getAnswerInput('n')).toBe('n');
      });

      it('should convert "NO" to "n"', () => {
        expect(getAnswerInput('NO')).toBe('n');
      });

      it('should convert "No" to "n"', () => {
        expect(getAnswerInput('No')).toBe('n');
      });

      it('should handle "no" with whitespace', () => {
        expect(getAnswerInput('  no  ')).toBe('n');
      });

      it('should handle "n" with whitespace', () => {
        expect(getAnswerInput('  n  ')).toBe('n');
      });
    });

    describe('Invalid inputs', () => {
      it('should throw error for empty string', () => {
        expect(() => getAnswerInput('')).toThrow('Invalid answer');
      });

      it('should throw error for whitespace only', () => {
        expect(() => getAnswerInput('   ')).toThrow('Invalid answer');
      });

      it('should throw error for invalid text', () => {
        expect(() => getAnswerInput('maybe')).toThrow('Invalid answer: maybe');
      });

      it('should throw error for numbers', () => {
        expect(() => getAnswerInput('1')).toThrow('Invalid answer: 1');
      });

      it('should throw error for special characters', () => {
        expect(() => getAnswerInput('!')).toThrow('Invalid answer: !');
      });

      it('should throw error for partial matches', () => {
        expect(() => getAnswerInput('ye')).toThrow('Invalid answer: ye');
      });

      it('should throw error for multiple words', () => {
        expect(() => getAnswerInput('yes please')).toThrow('Invalid answer: yes please');
      });
    });

    describe('Edge cases', () => {
      it('should handle mixed case', () => {
        expect(getAnswerInput('YeS')).toBe('y');
        expect(getAnswerInput('nO')).toBe('n');
      });

      it('should handle single character uppercase', () => {
        expect(getAnswerInput('Y')).toBe('y');
        expect(getAnswerInput('N')).toBe('n');
      });

      it('should handle excessive whitespace', () => {
        expect(getAnswerInput('   yes   ')).toBe('y');
        expect(getAnswerInput('\t\tno\t\t')).toBe('n');
      });
    });
  });

  describe('Integration scenarios', () => {
    it('should detect prompt and validate yes answer', () => {
      const output = 'Would you like to continue? (y/n)';
      const detection = detectPrompt(output);

      expect(detection.isPrompt).toBe(true);

      // Simulate user answering yes
      const answer = 'yes';
      const input = getAnswerInput(answer);

      expect(input).toBe('y');
    });

    it('should detect prompt and validate no answer', () => {
      const output = 'Overwrite existing file? [y/N]';
      const detection = detectPrompt(output);

      expect(detection.isPrompt).toBe(true);
      expect(isYesNoPrompt(detection.promptData) ? detection.promptData.defaultOption : undefined).toBe('no');

      // Simulate user answering no
      const answer = 'no';
      const input = getAnswerInput(answer);

      expect(input).toBe('n');
    });

    it('should handle complete workflow', () => {
      // 1. Detect prompt
      const output = 'Install these packages? [Y/n]';
      const detection = detectPrompt(output);

      expect(detection.isPrompt).toBe(true);
      expect(detection.promptData?.question).toBe('Install these packages?');

      // 2. Get answer input
      const userAnswer = 'yes';
      const tmuxInput = getAnswerInput(userAnswer);

      expect(tmuxInput).toBe('y');

      // 3. Verify prompt data structure
      expect(detection.promptData).toMatchObject({
        type: 'yes_no',
        question: 'Install these packages?',
        options: ['yes', 'no'],
        status: 'pending',
        defaultOption: 'yes',
      });
    });
  });
});
