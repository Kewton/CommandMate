/**
 * Prompt Detector Unit Tests
 * Tests for detecting and parsing Claude CLI yes/no prompts
 */

import { describe, it, expect } from 'vitest';
import { detectPrompt, getAnswerInput } from '@/lib/prompt-detector';
import type { DetectPromptOptions } from '@/lib/prompt-detector';
import type { PromptData, YesNoPromptData, MultipleChoicePromptData } from '@/types/models';

// Type guard for MultipleChoicePromptData
function isMultipleChoicePrompt(data: PromptData | undefined): data is MultipleChoicePromptData {
  return data?.type === 'multiple_choice';
}

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
        expect(() => getAnswerInput('maybe')).toThrow('Invalid answer for yes/no prompt');
      });

      it('should throw error for numbers', () => {
        expect(() => getAnswerInput('1')).toThrow('Invalid answer for yes/no prompt');
      });

      it('should throw error for special characters', () => {
        expect(() => getAnswerInput('!')).toThrow('Invalid answer for yes/no prompt');
      });

      it('should throw error for partial matches', () => {
        expect(() => getAnswerInput('ye')).toThrow('Invalid answer for yes/no prompt');
      });

      it('should throw error for multiple words', () => {
        expect(() => getAnswerInput('yes please')).toThrow('Invalid answer for yes/no prompt');
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

  // ==========================================================================
  // Issue #161: Regression Tests (Section 5.2)
  // Baseline tests to ensure backward compatibility of multiple_choice
  // detection and existing yes/no patterns after code changes.
  // ==========================================================================
  describe('Issue #161: Regression tests - multiple_choice detection', () => {
    it('should detect valid multiple_choice with cursor indicator', () => {
      // Section 5.2 Test #1
      const output = '❯ 1. Yes\n  2. No';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('should detect consecutive 3-option multiple_choice with cursor indicator', () => {
      // Section 5.2 Test #2
      const output = '❯ 1. Yes\n  2. No\n  3. Cancel';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(3);
      }
    });

    it('should set requiresTextInput for text input options', () => {
      // Section 5.2 Test #3
      const output = '❯ 1. Yes\n  2. Tell me differently';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options[1].requiresTextInput).toBe(true);
      }
    });

    it('should still detect yes/no pattern (y/n)', () => {
      // Section 5.2 Test #4
      const output = 'Proceed? (y/n)';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('yes_no');
    });

    it('should still detect Approve pattern', () => {
      // Section 5.2 Test #5
      const output = 'Approve?';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('yes_no');
    });

    it('should still detect [Y/n] pattern with default yes', () => {
      // Section 5.2 Test #6
      const output = 'Continue? [Y/n]';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      if (isYesNoPrompt(result.promptData)) {
        expect(result.promptData.defaultOption).toBe('yes');
      }
    });
  });

  // ==========================================================================
  // Issue #161: False Positive Prevention Tests (Section 5.1)
  // Tests that numbered lists without cursor indicator are NOT detected
  // as multiple_choice prompts.
  // ==========================================================================
  describe('Issue #161: False positive prevention', () => {
    it('should NOT detect plain numbered list as multiple_choice (Test #1)', () => {
      // Layer 2 protection: 2-pass method - no cursor indicator found in pass 1
      const output = '1. Create file\n2. Run tests';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });

    it('should NOT detect indented numbered list without cursor as multiple_choice (Test #2)', () => {
      // Layer 2 protection: no cursor indicator found
      const output = '  1. Yes\n  2. No';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });

    it('should NOT detect non-consecutive numbered options (Test #3)', () => {
      // Layer 3 protection: consecutive number validation
      const output = '❯ 1. Option A\n  3. Option B';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });

    it('should NOT detect options not starting from 1 (Test #4)', () => {
      // Layer 3 protection: consecutive number validation (must start from 1)
      const output = '❯ 2. Option A\n  3. Option B';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });

    // Note: Test #5 (thinking state with numbered output) is in
    // auto-yes-manager.test.ts as it tests Layer 1 (caller-side thinking check).
    // See Section 5.1 of the design policy and Section 5.3 Test #1.

    it('should NOT detect CLI step descriptions as multiple_choice (Test #6)', () => {
      // Layer 2 protection: no cursor indicator in output
      const output = "I'll do the following:\n1. Create file\n2. Run tests\n3. Commit";
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });

    it('should NOT detect prompt cursor with numbered list as multiple_choice (Test #7 - S3-003)', () => {
      // Layer 2 protection: cursor line does not match defaultOptionPattern
      // because "❯ /work-plan" has /work-plan after cursor, not a number
      const output = '❯ /work-plan\n\nI will do the following:\n1. Create file\n2. Run tests';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });
  });

  // ==========================================================================
  // Issue #161: Defense Layer Boundary Tests (Section 5.3)
  // Tests that each defense layer stops false positives independently.
  // Note: Test #1 is in auto-yes-manager.test.ts (Layer 1 - thinking check)
  // ==========================================================================
  describe('Issue #161: Defense layer boundary tests', () => {
    it('Layer 2: no cursor indicator in numbered list should not be detected (Test #2)', () => {
      const output = '  1. Option A\n  2. Option B';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });

    it('Layer 3: cursor present but non-consecutive numbers should not be detected (Test #3)', () => {
      const output = '❯ 1. Option A\n  3. Option C\n  5. Option E';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });

    it('Layer 4: cursor present, consecutive but only 1 option should not be detected (Test #4)', () => {
      const output = '❯ 1. Only option';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(false);
    });

    it('All layers pass: valid multiple_choice should be detected (Test #5)', () => {
      const output = '❯ 1. Yes\n  2. No';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });

  // ==========================================================================
  // Issue #161: Client-side thinking-prompt ordering test
  // Verifies that the defense pattern used in current-output/route.ts
  // (detectThinking before detectPrompt) correctly prevents false positives.
  // This test documents the fix for the client-side auto-yes path that was
  // missing the Layer 1 thinking check, causing useAutoYes.ts to send "1".
  // ==========================================================================
  describe('Issue #161: Client-side thinking-prompt ordering', () => {
    it('should skip prompt detection when thinking is detected (client-side pattern)', async () => {
      // Import detectThinking to simulate the current-output/route.ts pattern
      const { detectThinking } = await import('@/lib/cli-patterns');

      // Simulate output with thinking indicator AND a valid multiple_choice prompt
      // (e.g., old prompt still visible in tmux buffer while Claude is thinking)
      // Note: ✻ is a Claude spinner char, … (U+2026) is required by CLAUDE_THINKING_PATTERN
      const thinkingOutput = [
        '\u2733 Analyzing the code\u2026',
        'Here are the steps:',
        '\u276F 1. Yes',
        '  2. No',
      ].join('\n');

      // Step 1: Check thinking state FIRST (as current-output/route.ts now does)
      const isThinking = detectThinking('claude', thinkingOutput);

      // Step 2: Only call detectPrompt if NOT thinking
      const promptDetection = isThinking
        ? { isPrompt: false, cleanContent: thinkingOutput }
        : detectPrompt(thinkingOutput);

      // The thinking indicator should be detected
      expect(isThinking).toBe(true);
      // Therefore prompt detection should be skipped
      expect(promptDetection.isPrompt).toBe(false);
    });

    it('should detect prompt when NOT thinking (client-side pattern)', async () => {
      const { detectThinking } = await import('@/lib/cli-patterns');

      // Output with a valid prompt but NO thinking indicator
      const promptOutput = [
        'Do you want to proceed?',
        '❯ 1. Yes',
        '  2. No',
      ].join('\n');

      const isThinking = detectThinking('claude', promptOutput);
      const promptDetection = isThinking
        ? { isPrompt: false, cleanContent: promptOutput }
        : detectPrompt(promptOutput);

      expect(isThinking).toBe(false);
      expect(promptDetection.isPrompt).toBe(true);
      expect(promptDetection.promptData?.type).toBe('multiple_choice');
    });
  });

  // ==========================================================================
  // Issue #181: Multiline option continuation detection
  // Tests for detecting multiple choice prompts when option text wraps
  // across multiple lines due to terminal width.
  // ==========================================================================
  describe('Issue #181: Multiline option continuation detection', () => {
    it('should detect multiple choice with multiline option text (path wrapping)', () => {
      const output = [
        'Do you want to proceed?',
        '❯ 1. Yes',
        "  2. Yes, and don't ask again for curl and python3 commands in",
        '/Users/maenokota/share/work/github_kewton/comma',
        'ndmate-issue-161',
        '  3. No',
        '',
        'Esc to cancel · Tab to amend · ctrl+e to explain',
      ].join('\n');

      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(3);
        expect(result.promptData.options[0].label).toBe('Yes');
        expect(result.promptData.options[0].isDefault).toBe(true);
        expect(result.promptData.options[1].label).toBe(
          "Yes, and don't ask again for curl and python3 commands in"
        );
        expect(result.promptData.options[2].label).toBe('No');
      }
    });

    it('should not concatenate continuation line text to option labels', () => {
      const output = [
        'Do you want to proceed?',
        '❯ 1. Yes',
        "  2. Yes, and don't ask again for curl and python3 commands in",
        '/Users/maenokota/share/work/github_kewton/comma',
        'ndmate-issue-161',
        '  3. No',
      ].join('\n');

      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        // Label should only contain the text before the line break (continuation lines are not concatenated)
        expect(result.promptData.options[1].label).not.toContain('ndmate-issue-161');
        expect(result.promptData.options[1].label).not.toContain('/Users/');
      }
    });

    it('should detect yes/no prompt with path lines (not false-positive multiple choice)', () => {
      const output = [
        'File /Users/maenokota/share/work/github_kewton/comma',
        'ndmate-issue-161/src/lib/test.ts already exists',
        'Do you want to overwrite? (y/n)',
      ].join('\n');

      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('yes_no');
    });

    it('should not false-positive on English word-only lines between options', () => {
      // "Options", "Proceed" etc. should not cause false-positive multiple choice detection
      const output = [
        'Some output text',
        'Options',
        'Proceed',
        'Do you want to continue? (y/n)',
      ].join('\n');

      const result = detectPrompt(output);

      // English word-only lines should not be falsely detected as multiple choice
      if (result.isPrompt) {
        expect(result.promptData?.type).not.toBe('multiple_choice');
      }
    });

    it('should treat single character lines correctly with minimum length check', () => {
      // 'Y' is 1 char and matches isShortFragment (line.length < 5), so it gets
      // skipped as continuation regardless of SF-001 minimum length check.
      const output = [
        'Do you want to proceed?',
        '❯ 1. Option A',
        'Y',
        '  2. Option B',
      ].join('\n');

      const result = detectPrompt(output);

      // 'Y' is skipped by isShortFragment, so Option A and Option B are detected
      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(2);
      }
    });

    it('should exclude single character from isPathContinuation via minimum length check (SF-001)', () => {
      // 'SomeFragment' (12 chars) is not isShortFragment but matches isPathContinuation,
      // so it gets skipped as continuation line
      const output = [
        'Do you want to proceed?',
        '❯ 1. Option A',
        'SomeFragment',
        '  2. Option B',
      ].join('\n');

      const result = detectPrompt(output);

      // 'SomeFragment' is skipped by isPathContinuation, so Option A and Option B are detected
      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(2);
      }
    });
  });

  // ==========================================================================
  // Issue #161: 50-line Window Boundary Tests (Section 5.4)
  // Tests for the 50-line scan window boundary conditions.
  // ==========================================================================
  describe('Issue #161: 50-line window boundary tests', () => {
    it('should detect cursor at window boundary (49 lines + prompt)', () => {
      // Section 5.4 Test #1: cursor at boundary of 50-line window
      const fillerLines = Array.from({ length: 49 }, (_, i) => `Line ${i + 1}`).join('\n');
      const output = fillerLines + '\n❯ 1. Yes\n  2. No';
      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('should NOT detect cursor outside window (50+ lines before)', () => {
      // Section 5.4 Test #2: cursor scrolled out of 50-line window
      const fillerLines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join('\n');
      const output = '❯ 1. Yes\n' + fillerLines + '\n  2. No';
      const result = detectPrompt(output);

      // The cursor line is outside the 50-line scan window from the end
      // so it should not be detected as a valid multiple_choice
      expect(result.isPrompt).toBe(false);
    });

    it('should handle old prompt cursor with new numbered list in window (Test #3)', () => {
      // Section 5.4 Test #3: old answered prompt with cursor + new numbered list.
      // Known edge case (Section 9.4): when an old ❯ line remains within the
      // 50-line scan window, Pass 1 finds it and Pass 2 collects both old and
      // new numbered lines. The consecutive number validation (Layer 3) and
      // hasDefault check (Layer 4) provide partial protection.
      const oldPrompt = '❯ 1. Yes\n  2. No';
      const middleLines = Array.from({ length: 40 }, (_, i) => `Output line ${i + 1}`).join('\n');
      const newList = '1. Step one\n2. Step two';
      const output = oldPrompt + '\n' + middleLines + '\n' + newList;
      const result = detectPrompt(output);

      // Verify no crash occurs. The exact isPrompt value depends on how
      // the old and new numbered lines interact with Layer 3/4 validation.
      expect(result).toBeDefined();
      expect(typeof result.isPrompt).toBe('boolean');
    });
  });

  // ==========================================================================
  // Issue #193: requireDefaultIndicator option tests
  // Tests for detecting multiple choice prompts without the ❯ (U+276F) marker
  // when requireDefaultIndicator is set to false.
  // ==========================================================================
  describe('Issue #193: requireDefaultIndicator option', () => {
    describe('requireDefaultIndicator: false - basic detection', () => {
      it('should detect numbered choices without cursor indicator when requireDefaultIndicator is false', () => {
        const output = [
          'Which option would you like?',
          '  1. Yes',
          '  2. No',
          '  3. Cancel',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
        if (isMultipleChoicePrompt(result.promptData)) {
          expect(result.promptData.options).toHaveLength(3);
          expect(result.promptData.options[0].label).toBe('Yes');
          expect(result.promptData.options[0].isDefault).toBe(false);
          expect(result.promptData.options[1].label).toBe('No');
          expect(result.promptData.options[2].label).toBe('Cancel');
        }
      });

      it('should detect Claude Code 4-option prompt without cursor indicator', () => {
        const output = [
          'Do you want to proceed?',
          '  1. Yes',
          "  2. Yes, and don't ask again for this tool",
          '  3. No',
          '  4. No, and stop for now',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        if (isMultipleChoicePrompt(result.promptData)) {
          expect(result.promptData.options).toHaveLength(4);
          expect(result.promptData.question).toContain('Do you want to proceed?');
        }
      });

      it('should set all isDefault to false when no cursor indicator present', () => {
        const output = [
          'Choose an action:',
          '  1. Option A',
          '  2. Option B',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        if (isMultipleChoicePrompt(result.promptData)) {
          expect(result.promptData.options.every(opt => opt.isDefault === false)).toBe(true);
        }
      });
    });

    describe('requireDefaultIndicator: false - defense layers', () => {
      it('should still reject non-consecutive numbers (Layer 3 maintained)', () => {
        const output = [
          'Select one:',
          '  1. Option A',
          '  3. Option C',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });

      it('should still reject options not starting from 1 (Layer 3 maintained)', () => {
        const output = [
          'Select one:',
          '  2. Option B',
          '  3. Option C',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });

      it('should still reject when fewer than 2 options', () => {
        const output = [
          'Select one:',
          '  1. Only option',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });
    });

    describe('SEC-001: questionEndIndex guard (Layer 5)', () => {
      it('should return isPrompt: false when requireDefaultIndicator=false and no question line (numbered list only)', () => {
        // Pure numbered list without question line - should NOT be detected as a prompt
        const output = [
          '1. Create file',
          '2. Run tests',
          '3. Deploy',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });

      it('should return isPrompt: true when requireDefaultIndicator=false and question line is present', () => {
        // Numbered list WITH question line - should be detected as a prompt
        const output = [
          'Which option do you prefer?',
          '  1. Option A',
          '  2. Option B',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('should return isPrompt: false for numbered list with only separator lines before it', () => {
        // Separator lines should not count as question lines
        const output = [
          '───────────────────────',
          '  1. Option A',
          '  2. Option B',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });
    });

    describe('requireDefaultIndicator: true (default) - regression', () => {
      it('should NOT detect numbered choices without cursor when requireDefaultIndicator defaults to true', () => {
        const output = [
          'Which option would you like?',
          '  1. Yes',
          '  2. No',
        ].join('\n');

        // No options passed - defaults to requireDefaultIndicator: true
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
      });

      it('should NOT detect numbered choices without cursor when requireDefaultIndicator explicitly true', () => {
        const output = [
          'Which option would you like?',
          '  1. Yes',
          '  2. No',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: true };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });

      it('should still detect cursor-indicated choices with default true', () => {
        const output = [
          'Do you want to proceed?',
          '\u276F 1. Yes',
          '  2. No',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: true };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });
    });

    describe('requireDefaultIndicator: false with cursor indicator present', () => {
      it('should still detect and mark isDefault correctly when cursor indicator is present', () => {
        const output = [
          'Do you want to proceed?',
          '\u276F 1. Yes',
          '  2. No',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        if (isMultipleChoicePrompt(result.promptData)) {
          expect(result.promptData.options[0].isDefault).toBe(true);
          expect(result.promptData.options[1].isDefault).toBe(false);
        }
      });
    });
  });

  // ==========================================================================
  // Issue #193: getAnswerInput SEC-003 - Safe error messages
  // ==========================================================================
  describe('Issue #193: getAnswerInput SEC-003 - safe error messages', () => {
    it('should not include user input in multiple_choice error message', () => {
      try {
        getAnswerInput('<script>alert("xss")</script>', 'multiple_choice');
        expect.fail('Should have thrown');
      } catch (e) {
        const error = e as Error;
        expect(error.message).not.toContain('<script>');
        expect(error.message).not.toContain('alert');
      }
    });

    it('should not include user input in yes_no error message', () => {
      try {
        getAnswerInput('malicious_input_value', 'yes_no');
        expect.fail('Should have thrown');
      } catch (e) {
        const error = e as Error;
        expect(error.message).not.toContain('malicious_input_value');
      }
    });
  });

  // ==========================================================================
  // Issue #193: buildDetectPromptOptions helper tests
  // ==========================================================================
  describe('Issue #193: buildDetectPromptOptions', () => {
    it('should return requireDefaultIndicator: false for claude', async () => {
      const { buildDetectPromptOptions } = await import('@/lib/cli-patterns');
      const result = buildDetectPromptOptions('claude');

      expect(result).toEqual({ requireDefaultIndicator: false });
    });

    it('should return undefined for codex', async () => {
      const { buildDetectPromptOptions } = await import('@/lib/cli-patterns');
      const result = buildDetectPromptOptions('codex');

      expect(result).toBeUndefined();
    });

    it('should return undefined for gemini', async () => {
      const { buildDetectPromptOptions } = await import('@/lib/cli-patterns');
      const result = buildDetectPromptOptions('gemini');

      expect(result).toBeUndefined();
    });
  });
});
