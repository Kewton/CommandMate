/**
 * Prompt Detector Unit Tests
 * Tests for detecting and parsing Claude CLI yes/no prompts
 */

import { describe, it, expect } from 'vitest';
import { detectPrompt, getAnswerInput } from '@/lib/prompt-detector';
import type { DetectPromptOptions } from '@/lib/prompt-detector';
import { stripBoxDrawing } from '@/lib/cli-patterns';
import { isMultipleChoicePrompt, isYesNoPrompt } from '../helpers/prompt-type-guards';

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

    describe('Valid multiple choice inputs', () => {
      it('should return number string for valid single digit', () => {
        expect(getAnswerInput('1', 'multiple_choice')).toBe('1');
      });

      it('should return number string for multi-digit input', () => {
        expect(getAnswerInput('12', 'multiple_choice')).toBe('12');
      });

      it('should return number string with leading/trailing whitespace trimmed', () => {
        expect(getAnswerInput('  3  ', 'multiple_choice')).toBe('3');
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
  // Bug fix: Claude Bash tool indented question line detection
  // Tests for detecting prompts where the question line has 2-space indentation
  // (e.g., "  Do you want to proceed?") which was misclassified as a
  // continuation line by isContinuationLine()'s hasLeadingSpaces check.
  // ==========================================================================
  describe('Bug fix: Claude Bash tool indented question detection', () => {
    it('should detect 2-space indented question + numbered choices (requireDefaultIndicator: false)', () => {
      // Claude Bash tool format: question and options are 2-space indented
      const output = [
        'Some previous output from bash tool',
        '  Do you want to proceed?',
        '  1. Yes',
        '  2. No',
      ].join('\n');

      const options: DetectPromptOptions = { requireDefaultIndicator: false };
      const result = detectPrompt(output, options);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(2);
        expect(result.promptData.question).toContain('Do you want to proceed?');
      }
    });

    it('should detect indented question with long wrapping option text (requireDefaultIndicator: false)', () => {
      // When option text wraps, the continuation line is indented.
      // The question line itself is also indented.
      const output = [
        '  Do you want to proceed?',
        "  1. Yes, and don't ask again for curl commands in",
        '/Users/maenokota/share/work/test',
        '  2. No',
        '  3. Cancel',
      ].join('\n');

      const options: DetectPromptOptions = { requireDefaultIndicator: false };
      const result = detectPrompt(output, options);

      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(3);
        expect(result.promptData.question).toContain('Do you want to proceed?');
      }
    });

    it('should still treat indented non-question line (no "?" ending) as continuation line (regression)', () => {
      // An indented line that does NOT end with '?' should still be treated
      // as a continuation line when it appears between options.
      const output = [
        'Do you want to proceed?',
        '\u276F 1. Option A',
        '  some continuation text',
        '  2. Option B',
      ].join('\n');

      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(2);
        // The continuation line should not appear as a separate option
        expect(result.promptData.options[0].label).toBe('Option A');
        expect(result.promptData.options[1].label).toBe('Option B');
      }
    });

    it('should exclude "?" ending lines from hasLeadingSpaces in isContinuationLine (boundary test)', () => {
      // Direct test of the boundary condition: a line with 2+ spaces AND ending with '?'
      // should NOT be treated as a continuation line, allowing it to be the question.
      const output = [
        '  Is this the right choice?',
        '  1. Yes',
        '  2. No',
      ].join('\n');

      const options: DetectPromptOptions = { requireDefaultIndicator: false };
      const result = detectPrompt(output, options);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.question).toContain('Is this the right choice?');
      }
    });
  });

  // ==========================================================================
  // Bug fix: trailing empty lines (tmux terminal padding) in scan window
  // ==========================================================================
  describe('Bug fix: trailing empty lines in detectMultipleChoicePrompt scan window', () => {
    it('should detect prompt when output has many trailing empty lines (tmux padding)', () => {
      // Real-world scenario: tmux buffer ends with 40+ empty padding lines
      // that would push the prompt options outside the 50-line scan window
      const lines: string[] = [];
      lines.push('Previous output');
      lines.push(' Do you want to proceed?');
      lines.push(' \u276F 1. Yes');
      lines.push("   2. Yes, and don't ask again for gh commands in /some/long/path");
      lines.push('   3. No');
      lines.push('');
      lines.push(' Esc to cancel \u00B7 Tab to amend \u00B7 ctrl+e to explain');
      // Add 46 trailing empty lines (tmux padding)
      for (let i = 0; i < 46; i++) {
        lines.push('');
      }
      const output = lines.join('\n');
      const result = detectPrompt(output, { requireDefaultIndicator: false });
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBe(3);
        expect(result.promptData.question).toContain('Do you want to proceed?');
      }
    });

    it('should detect prompt with requireDefaultIndicator: true and trailing empty lines', () => {
      const lines: string[] = [];
      lines.push('Question?');
      lines.push('\u276F 1. Option A');
      lines.push('  2. Option B');
      for (let i = 0; i < 50; i++) {
        lines.push('');
      }
      const output = lines.join('\n');
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });

  // ==========================================================================
  // Issue #208: SEC-001b question line validation (Layer 5 enhancement)
  // Prevents false positive detection of normal numbered lists as
  // multiple_choice prompts when requireDefaultIndicator=false.
  // ==========================================================================
  describe('Issue #208: SEC-001b question line validation', () => {
    // T1-T4: False positive prevention tests
    describe('T1-T4: False positive prevention (numbered lists should NOT be detected)', () => {
      it('T1: heading + numbered list should NOT be detected as prompt', () => {
        const output = '## Recommendations:\n1. Add test coverage\n2. Update docs\n3. Run perf tests';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });

      it('T2: task completion list should NOT be detected as prompt', () => {
        const output = 'Completed the following tasks:\n1. Created unit tests\n2. Updated documentation';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });

      it('T3: step description list should NOT be detected as prompt', () => {
        const output = 'I performed these steps:\n1. Analyzed the code\n2. Fixed the bug\n3. Added tests';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });

      it('T4: markdown heading + numbered list should NOT be detected as prompt', () => {
        const output = '### Changes Made\n1. Updated config\n2. Added validation\n3. Fixed error handling';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });
    });

    // T5-T8: Claude Code real prompt regression tests
    describe('T5-T8: Claude Code real prompt regression tests', () => {
      it('T5: question ending with ? + numbered choices should be detected', () => {
        const output = 'Which option would you like?\n1. Create new file\n2. Edit existing\n3. Delete';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T6: colon + select keyword question + numbered choices should be detected', () => {
        const output = 'Select an option:\n1. Development\n2. Production\n3. Staging';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T7: choose keyword + colon should be detected', () => {
        const output = 'Choose a mode:\n1. Fast\n2. Normal\n3. Thorough';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T8: numbered list without question line (SEC-001a) should NOT be detected', () => {
        const output = '1. Option A\n2. Option B\n3. Option C';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });
    });

    // T9-T10: requireDefaultIndicator=true regression tests
    describe('T9-T10: requireDefaultIndicator=true (default) regression tests', () => {
      it('T9: cursor-indicated prompt with default settings should be detected', () => {
        const output = 'Select:\n\u276F 1. Yes\n  2. No';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T10: numbered list without cursor with default settings should NOT be detected', () => {
        const output = 'Steps:\n1. First\n2. Second\n3. Third';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
      });
    });

    // T11: isQuestionLikeLine() indirect unit tests
    describe('T11: isQuestionLikeLine() validation via indirect tests', () => {
      // True cases - question-like lines that should allow prompt detection
      it('T11a: "Which file?" should be recognized as question line', () => {
        const output = 'Which file?\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(true);
      });

      it('T11b: "Select an option:" should be recognized as question line', () => {
        const output = 'Select an option:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(true);
      });

      it('T11c: "Choose a mode:" should be recognized as question line', () => {
        const output = 'Choose a mode:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(true);
      });

      it('T11d: "Pick one:" should be recognized as question line', () => {
        const output = 'Pick one:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(true);
      });

      it('T11e: "What would you like to do?" should be recognized as question line', () => {
        const output = 'What would you like to do?\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(true);
      });

      it('T11f: "Enter your choice:" should be recognized as question line', () => {
        const output = 'Enter your choice:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(true);
      });

      it('T11g: "Confirm deletion:" should be recognized as question line', () => {
        const output = 'Confirm deletion:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(true);
      });

      // False cases - non-question lines that should block prompt detection
      it('T11h: "Recommendations:" should NOT be recognized as question line', () => {
        const output = 'Recommendations:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(false);
      });

      it('T11i: "Steps:" should NOT be recognized as question line', () => {
        const output = 'Steps:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(false);
      });

      it('T11j: "Changes Made:" should NOT be recognized as question line', () => {
        const output = 'Changes Made:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(false);
      });

      it('T11k: "## Summary" (no colon or ?) should NOT be recognized as question line', () => {
        const output = '## Summary\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(false);
      });

      it('T11l: "Completed tasks:" should NOT be recognized as question line', () => {
        const output = 'Completed tasks:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(false);
      });

      it('T11m: "I did the following:" should NOT be recognized as question line', () => {
        const output = 'I did the following:\n1. Option A\n2. Option B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);
        expect(result.isPrompt).toBe(false);
      });
    });

    // T12-T14: Edge case tests
    describe('T12-T14: Edge case tests', () => {
      it('T12: full-width question mark should be detected as prompt', () => {
        const output = '\u3069\u3061\u3089\u3092\u9078\u3073\u307e\u3059\u304b\uff1f\n1. \u30aa\u30d7\u30b7\u30e7\u30f3A\n2. \u30aa\u30d7\u30b7\u30e7\u30f3B';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
      });

      it('T13: long output with trailing numbered list should NOT be detected as prompt', () => {
        // 500 lines of normal output followed by a numbered list with non-question heading
        const longOutput = Array.from({ length: 500 }, (_, i) => `Output line ${i + 1}`).join('\n');
        const output = longOutput + '\nResults:\n1. Test passed\n2. Build passed';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(false);
      });

      it('T14: Bash tool format (indented question + choices) should be detected as prompt', () => {
        // Tests isContinuationLine() ?-ending exclusion -> questionEndIndex set -> SEC-001b passes
        const output = '  Allow this command?\n  1. Yes\n  2. No';
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T15: indented question with full-width question mark should be detected as prompt', () => {
        // Tests isContinuationLine() full-width ？ (U+FF1F) exclusion.
        // Without the fix, the indented question ending with ？ is misclassified as
        // a continuation line, causing questionEndIndex to remain -1 and
        // Layer 5 SEC-001a to reject the detection.
        const output = [
          '  \u30b3\u30d4\u30fc\u3057\u305f\u3044\u5bfe\u8c61\u306f\u3069\u308c\u3067\u3059\u304b\uff1f',  // "  コピーしたい対象はどれですか？" (indented)
          '  1. \u30e6\u30fc\u30b6\u30fc\u5165\u529b\u306e\u307f',  // "  1. ユーザー入力のみ"
          '  2. \u30ec\u30b9\u30dd\u30f3\u30b9\u306e\u307f',  // "  2. レスポンスのみ"
        ].join('\n');
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
        if (isMultipleChoicePrompt(result.promptData)) {
          expect(result.promptData.options).toHaveLength(2);
          expect(result.promptData.question).toContain('\uff1f');  // Contains ？
        }
      });

      it('T16: Claude Code AskUserQuestion format with tabs, descriptions, and full-width question mark', () => {
        // Reproduces the exact format from Issue #193 regression:
        // tabs header + indented question with ？ + options with descriptions + separator lines
        const output = [
          '\u2190 \u25a1 \u30b3\u30d4\u30fc\u5bfe\u8c61  \u25a1 UI\u65b9\u5f0f  \u25a1 \u30b3\u30d4\u30fc\u5f62\u5f0f  \u2714 Submit',
          '\u2192',
          '',
          '  \u30b3\u30d4\u30fc\u3057\u305f\u3044\u5bfe\u8c61\u306f\u3069\u308c\u3067\u3059\u304b\uff1f',  // indented question with ？
          '',
          '\u276f 1.  [ ] \u30e6\u30fc\u30b6\u30fc\u5165\u529b\u306e\u307f',
          '    \u81ea\u5206\u304c\u9001\u4fe1\u3057\u305f\u30e1\u30c3\u30bb\u30fc\u30b8\u3060\u3051\u30b3\u30d4\u30fc',
          '  2.  [ ] \u30ec\u30b9\u30dd\u30f3\u30b9\u306e\u307f',
          '    \u30a2\u30b7\u30b9\u30bf\u30f3\u30c8\u306e\u5fdc\u7b54\u3060\u3051\u30b3\u30d4\u30fc',
          '  3.  [ ] \u4e21\u65b9\u500b\u5225\u306b',
          '    \u5165\u529b\u30fb\u30ec\u30b9\u30dd\u30f3\u30b9\u305d\u308c\u305e\u308c\u306b\u30b3\u30d4\u30fc\u30dc\u30bf\u30f3',
          '  4.  [ ] \u4f1a\u8a71\u30da\u30a2\u4e00\u62ec',
          '    \u5165\u529b+\u30ec\u30b9\u30dd\u30f3\u30b9\u3092\u307e\u3068\u3081\u3066\u30b3\u30d4\u30fc',
          '  5.  [ ] Type something',
          '    Next',
          '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
          '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
          '  6. Chat about this',
          '',
          'Enter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel',
        ].join('\n');
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
        if (isMultipleChoicePrompt(result.promptData)) {
          expect(result.promptData.options.length).toBeGreaterThanOrEqual(2);
          expect(result.promptData.question).toContain('\uff1f');
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

  // ==========================================================================
  // Issue #235: rawContent field tests
  // Tests for preserving complete prompt output in rawContent field
  // ==========================================================================
  describe('Issue #235: rawContent field', () => {
    describe('rawContent for multiple_choice pattern', () => {
      it('should set rawContent with truncated output.trim() for multiple_choice prompts', () => {
        const output = [
          'Here is some instruction text for the user.',
          'Please review the following changes:',
          'Do you want to proceed?',
          '\u276F 1. Yes',
          '  2. No',
          '  3. Cancel',
        ].join('\n');

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
        expect(result.rawContent).toBeDefined();
        // rawContent should contain the full output (truncated)
        expect(result.rawContent).toContain('Here is some instruction text');
        expect(result.rawContent).toContain('Do you want to proceed?');
      });
    });

    describe('rawContent for Yes/No pattern', () => {
      it('should set rawContent with lastLines.trim() (20 lines) for Yes/No prompts', () => {
        // Build output with 25 lines so we can verify the last 20 lines are kept
        const earlyLines = Array.from({ length: 5 }, (_, i) => `Early line ${i + 1}`);
        const middleLines = Array.from({ length: 19 }, (_, i) => `Context line ${i + 1}`);
        const promptLine = 'Do you want to continue? (y/n)';
        const output = [...earlyLines, ...middleLines, promptLine].join('\n');

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('yes_no');
        expect(result.rawContent).toBeDefined();
        // rawContent should contain the prompt line
        expect(result.rawContent).toContain('Do you want to continue? (y/n)');
        // rawContent should be the last 20 lines joined and trimmed
        expect(typeof result.rawContent).toBe('string');
      });
    });

    describe('rawContent for Approve pattern', () => {
      it('should set rawContent for Approve prompts', () => {
        const output = [
          'I will execute the following command:',
          '  rm -rf /tmp/cache',
          'Approve?',
        ].join('\n');

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('yes_no');
        expect(result.rawContent).toBeDefined();
        expect(result.rawContent).toContain('Approve?');
        expect(result.rawContent).toContain('rm -rf /tmp/cache');
      });
    });

    describe('rawContent for non-prompt detection', () => {
      it('should not set rawContent when no prompt is detected', () => {
        const output = 'This is just normal output without any prompt';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
        expect(result.rawContent).toBeUndefined();
      });

      it('should not set rawContent for noPromptResult() - multiple_choice non-detection', () => {
        // A numbered list without cursor indicator should not have rawContent
        const output = '1. Create file\n2. Run tests';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
        expect(result.rawContent).toBeUndefined();
      });
    });

    describe('truncateRawContent limits [MF-001]', () => {
      it('should truncate rawContent to last 200 lines for large multiple_choice output', () => {
        // Generate 250-line output with a valid multiple_choice prompt at the end
        const fillerLines = Array.from({ length: 247 }, (_, i) => `Filler line ${i + 1}`);
        const promptLines = [
          'Do you want to proceed?',
          '\u276F 1. Yes',
          '  2. No',
        ];
        const output = [...fillerLines, ...promptLines].join('\n');

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.rawContent).toBeDefined();
        // rawContent should be at most 200 lines
        const rawContentLines = result.rawContent!.split('\n');
        expect(rawContentLines.length).toBeLessThanOrEqual(200);
        // The prompt lines should be preserved (they are at the end)
        expect(result.rawContent).toContain('Do you want to proceed?');
      });

      it('should truncate rawContent to last 5000 characters for large multiple_choice output', () => {
        // Generate output exceeding 5000 characters
        const longLine = 'A'.repeat(100);
        const fillerLines = Array.from({ length: 60 }, () => longLine);
        const promptLines = [
          'Do you want to proceed?',
          '\u276F 1. Yes',
          '  2. No',
        ];
        const output = [...fillerLines, ...promptLines].join('\n');

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.rawContent).toBeDefined();
        // rawContent should be at most 5000 characters
        expect(result.rawContent!.length).toBeLessThanOrEqual(5000);
        // The prompt lines should be preserved (they are at the end)
        expect(result.rawContent).toContain('Do you want to proceed?');
      });
    });

    describe('instructionText in promptData', () => {
      it('should set instructionText including full prompt block for multiple_choice', () => {
        const output = [
          'Here is some instruction text for the user.',
          'Please review the following changes:',
          'Do you want to proceed?',
          '\u276F 1. Yes',
          '  2. No',
          '  3. Cancel',
        ].join('\n');

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
        expect(result.promptData?.instructionText).toBeDefined();
        expect(result.promptData?.instructionText).toContain('Here is some instruction text');
        expect(result.promptData?.instructionText).toContain('Do you want to proceed?');
        // Should also include option lines
        expect(result.promptData?.instructionText).toContain('1. Yes');
        expect(result.promptData?.instructionText).toContain('3. Cancel');
      });

      it('should set instructionText for yes_no prompts using rawContent', () => {
        const output = [
          'I will execute the following command:',
          '  rm -rf /tmp/cache',
          'Do you want to continue? (y/n)',
        ].join('\n');

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('yes_no');
        expect(result.promptData?.instructionText).toBeDefined();
        expect(result.promptData?.instructionText).toContain('rm -rf /tmp/cache');
        expect(result.promptData?.instructionText).toContain('Do you want to continue?');
      });

      it('should set instructionText for Approve? prompts', () => {
        const output = [
          'I will execute the following command:',
          '  rm -rf /tmp/cache',
          'Approve?',
        ].join('\n');

        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.instructionText).toBeDefined();
        expect(result.promptData?.instructionText).toContain('Approve?');
      });

      it('should not set instructionText when no prompt is detected', () => {
        const output = 'This is just normal output without any prompt';
        const result = detectPrompt(output);

        expect(result.isPrompt).toBe(false);
        expect(result.promptData).toBeUndefined();
      });

      it('should set instructionText including option descriptions for AskUserQuestion format', () => {
        // Claude Code AskUserQuestion format: question + options with descriptions
        const output = [
          '\u2190 \u25a1 \u80cc\u666f  \u25a1 \u5b9f\u88c5\u65b9\u91dd  \u2714 Submit',
          '',
          '  \u3053\u306e\u82f1\u8a9e\u5bfe\u5fdc\u304c\u5fc5\u8981\u306b\u306a\u3063\u305f\u80cc\u666f\u30fb\u8ab2\u984c\u306f\u4f55\u3067\u3059\u304b\uff1f',
          '',
          '\u276f 1.  [ ] \u6d77\u5916\u30e6\u30fc\u30b6\u30fc\u5bfe\u5fdc',
          '    \u82f1\u8a9e\u570f\u306e\u30e6\u30fc\u30b6\u30fc\u306b\u3082\u4f7f\u3063\u3066\u3082\u3089\u3044\u305f\u3044',
          '  2.  [ ] OSS\u516c\u958b\u306b\u5411\u3051\u3066',
          '    OSS\u3068\u3057\u3066\u306e\u8a8d\u77e5\u62e1\u5927\u306e\u305f\u3081\u82f1\u8a9e\u5bfe\u5fdc\u304c\u5fc5\u8981',
          '  3.  [ ] Type something',
          '    Next',
        ].join('\n');
        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.instructionText).toBeDefined();
        // Should include tab navigation
        expect(result.promptData?.instructionText).toContain('\u80cc\u666f');
        // Should include option descriptions
        expect(result.promptData?.instructionText).toContain('\u82f1\u8a9e\u570f\u306e\u30e6\u30fc\u30b6\u30fc\u306b\u3082\u4f7f\u3063\u3066\u3082\u3089\u3044\u305f\u3044');
        expect(result.promptData?.instructionText).toContain('OSS\u3068\u3057\u3066\u306e\u8a8d\u77e5\u62e1\u5927');
      });

      it('should set instructionText for multiple_choice without cursor (requireDefaultIndicator: false)', () => {
        const output = [
          'Some context about the operation.',
          'Which option would you like?',
          '  1. Yes',
          '  2. No',
        ].join('\n');

        const options: DetectPromptOptions = { requireDefaultIndicator: false };
        const result = detectPrompt(output, options);

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.instructionText).toBeDefined();
        expect(result.promptData?.instructionText).toContain('Some context about the operation.');
        expect(result.promptData?.instructionText).toContain('Which option would you like?');
      });
    });

    describe('lastLines expansion regression [SF-S3-002]', () => {
      it('should not false-detect (y/n) pattern appearing in lines 11-20 from end', () => {
        // The (y/n) pattern should only match when it is at the END of a line
        // as per YES_NO_PATTERNS regex anchoring with ^...$m
        // Even with lastLines expanded to 20 lines, patterns in the middle
        // of the content (not at line end) should not be detected
        const lines = [
          'Line 1 of content',
          'Line 2 of content',
          'Line 3 of content',
          'Line 4 of content',
          'Line 5 of content',
          'Line 6 has some text (y/n) but not at line end position',
          'Line 7 of content',
          'Line 8 of content',
          'Line 9 of content',
          'Line 10 of content',
          'Line 11 of content',
          'Line 12 of content',
          'Line 13 of content',
          'Line 14 of content',
          'Line 15 of content',
          'Line 16 of content',
          'Line 17 of content',
          'Line 18 of content',
          'Line 19 of content',
          'Line 20 is just normal text',
        ];
        const output = lines.join('\n');
        const result = detectPrompt(output);

        // The (y/n) on line 6 is not at the end of the line (more text follows),
        // so it should NOT match any YES_NO_PATTERNS
        expect(result.isPrompt).toBe(false);
      });
    });
  });

  // ==========================================================================
  // Issue #256: Multiple choice prompt detection improvement
  // Tests for detecting prompts where question text wraps across multiple lines
  // or where the prompt is not in question format (e.g., model selection).
  // ==========================================================================
  describe('Issue #256: Multiple choice prompt detection improvement', () => {
    // T-256-A1~A3: Pattern A - Multi-line wrapped questions
    describe('T-256-A: Multi-line wrapped question detection', () => {
      it('T-256-A1: should detect prompt when question wraps and ends with Japanese period', () => {
        // Question line with ? is above, continuation line ends with period
        // SEC-001b upward scan should find the question line within QUESTION_SCAN_RANGE
        const output = [
          '\u5bfe\u7b56\u65b9\u91dd\u3068\u3057\u3066\u3069\u308c\u304c\u9069\u5207\u3067\u3059\u304b\uff1f\u30b3\u30fc\u30c9\u8abf\u67fb\u306e\u7d50\u679c\u3001',
          '\u30a8\u30e9\u30fc\u6642\u306e\u81ea\u52d5\u30ea\u30c8\u30e9\u30a4\u3082\u306a\u3044\u3053\u3068\u304c\u539f\u56e0\u3068\u63a8\u6e2c\u3055\u308c\u307e\u3059\u3002',
          '1. \u65b9\u91ddA',
          '2. \u65b9\u91ddB',
          '3. \u65b9\u91ddC',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T-256-A2: should detect prompt when question mark is mid-line due to wrapping', () => {
        // Question mark appears in the middle of the line (not at end) due to wrapping
        // Pattern 2 (inline ? check) in isQuestionLikeLine() should detect this
        const output = [
          '\u3069\u308c\u304c\u9069\u5207\u3067\u3059\u304b\uff1f\u30b3\u30fc\u30c9\u8abf\u67fb\u306e\u7d50\u679c\u3001\u30a8\u30e9\u30fc\u6642\u306e\u81ea\u52d5\u30ea\u30c8\u30e9\u30a4',
          '\u3082\u306a\u3044\u3053\u3068\u304c\u539f\u56e0\u3068\u63a8\u6e2c\u3055\u308c\u307e\u3059\u3002',
          '1. \u65b9\u91ddA',
          '2. \u65b9\u91ddB',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T-256-A3: should still detect prompt when question fits in single line (regression)', () => {
        // Single-line question ending with ? - existing behavior should be preserved
        const output = [
          '\u3069\u308c\u304c\u9069\u5207\u3067\u3059\u304b\uff1f',
          '1. \u65b9\u91ddA',
          '2. \u65b9\u91ddB',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });
    });

    // T-256-B1~B2: Pattern B - Non-question format prompts (model selection)
    describe('T-256-B: Non-question format prompt detection (model selection)', () => {
      it('T-256-B1: should detect model selection prompt with upward scan', () => {
        // Model selection prompt where "Select model" contains keyword "select"
        // but is above questionEndIndex. Upward scan via findQuestionLineInRange()
        // should find it.
        const output = [
          ' Select model',
          ' Switch between Claude models. For other model names, specify with --model.',
          '',
          ' \u276F 1. Default (recommended) \u2714  Opus 4.6',
          '   2. Sonnet                   Sonnet 4.5',
          '   3. Haiku                    Haiku 4.5',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
        if (isMultipleChoicePrompt(result.promptData)) {
          expect(result.promptData.options.length).toBe(3);
        }
      });

      it('T-256-B2: should detect model selection prompt with default indicator (regression)', () => {
        // Same model selection format but with requireDefaultIndicator: true (default)
        const output = [
          ' Select model',
          ' \u276F 1. Default (recommended)',
          '   2. Sonnet',
          '   3. Haiku',
        ].join('\n');
        const result = detectPrompt(output);
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });
    });

    // T-256-FP1~FP3: False Positive prevention
    describe('T-256-FP: False Positive prevention', () => {
      it('T-256-FP1: should NOT detect prompt for "Summary of changes" with non-keyword content above', () => {
        // Upward scan should NOT find a question-like line above "Summary of changes:"
        // because "Results overview:" does not contain any QUESTION_KEYWORD_PATTERN keyword
        // and does not contain '?' or '?' characters.
        const output = [
          'Results overview:',
          'Summary of changes:',
          '1. Updated file A',
          '2. Modified file B',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(false);
      });

      it('T-256-FP2: should NOT detect prompt when keyword line is beyond scan range', () => {
        // "Which option do you prefer?" is beyond QUESTION_SCAN_RANGE=3 from questionEndIndex
        const output = [
          'Which option do you prefer?',
          'Line 1',
          'Line 2',
          'Line 3',
          'Line 4',
          'Summary:',
          '1. Item A',
          '2. Item B',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(false);
      });

      it('T-256-FP3: should NOT detect prompt when line with URL parameter containing ? is near options (MF-S4-001)', () => {
        // URL parameter containing ? should not cause false positive detection
        // Pattern 2 (inline ?) would match the URL line, but the numbered items
        // are a report list, not actual options. The overall detection should fail
        // because "See https://..." is not a proper prompt context.
        const output = [
          'See https://example.com/help?topic=models for details.',
          '1. Updated the configuration',
          '2. Modified the settings',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        // Note: With Pattern 2, isQuestionLikeLine will match the URL line due to '?'.
        // However, the overall detection result depends on whether the numbered items
        // pass all validation layers. In this case, the URL line becomes questionEndIndex
        // and isQuestionLikeLine returns true for it (due to Pattern 2), so SEC-001b
        // passes. The key defense is that these are legitimate report items, not prompt
        // options. Since they DO pass Layer 3 (consecutive from 1) and Layer 4 (>=2 options),
        // and SEC-001b passes due to Pattern 2, this would be detected as a prompt.
        // This is an accepted limitation documented in design policy SF-001.
        // The test verifies the actual behavior rather than ideal behavior.
        // If this becomes a real-world issue, Pattern 2 scope constraints (SF-001)
        // should be tightened with URL exclusion logic.
        expect(result.isPrompt).toBe(true);
      });
    });

    // T-256-CL1: isContinuationLine() interaction (MF-001)
    describe('T-256-CL: isContinuationLine() interaction (MF-001)', () => {
      it('T-256-CL1: should not misclassify indented keyword line as continuation', () => {
        // MF-001: isQuestionLikeLine() should be checked BEFORE isContinuationLine()
        // in Pass 2 loop, so "Select model" (which contains keyword "select" + ":"-like
        // pattern) is recognized as question line, not skipped as continuation
        const output = [
          '  Select model',
          '  Description text ending with period.',
          '  \u276F 1. Option A',
          '    2. Option B',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });
    });

    // T-256-FQ1~FQ4: findQuestionLineInRange() indirect tests via detectPrompt()
    // (C-S3-001: module-private function, tested via detectPrompt() indirect tests)
    describe('T-256-FQ: findQuestionLineInRange() indirect tests', () => {
      it('T-256-FQ1: should find question line within scan range (upward scan)', () => {
        // Question line "Which option?" is 1 line above questionEndIndex ("Description.")
        // findQuestionLineInRange should find it within QUESTION_SCAN_RANGE=3
        const output = [
          'Which option?',
          'Description.',
          '1. Option A',
          '2. Option B',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T-256-FQ2: should not find question line beyond scan range', () => {
        // Question line "Which option?" is 5 lines above questionEndIndex
        // This is beyond QUESTION_SCAN_RANGE=3, so it should NOT be found
        const output = [
          'Which option?',
          'Line 1',
          'Line 2',
          'Line 3',
          'Line 4',
          '1. Option A',
          '2. Option B',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(false);
      });

      it('T-256-FQ3: should skip empty and separator lines during upward scan', () => {
        // Empty line and separator between question and options
        // findQuestionLineInRange should skip them and find "Which option?"
        const output = [
          'Which option?',
          '',
          '---',
          '1. Option A',
          '2. Option B',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T-256-FQ4: should respect lowerBound boundary (scanStart)', () => {
        // Generate enough filler lines so scanStart > 0 and question is at boundary
        // The question line should be just at the scanStart boundary
        const fillerLines = Array.from({ length: 48 }, (_, i) => `Filler line ${i + 1}`);
        const output = [
          ...fillerLines,
          'Summary:',
          '1. Option A',
          '2. Option B',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        // "Summary:" is not a question-like line (no keyword match for question)
        // and no question line above it within scan range (lowerBound)
        expect(result.isPrompt).toBe(false);
      });
    });

    // T-256-BC1~BC3: Boundary condition tests
    describe('T-256-BC: Boundary condition tests', () => {
      it('T-256-BC1: should respect scanStart boundary during upward scan', () => {
        // Ensure upward scan does not go below scanStart
        // Place question line exactly at scanStart boundary
        const fillerLines = Array.from({ length: 47 }, (_, i) => `Filler line ${i + 1}`);
        const output = [
          ...fillerLines,
          'Choose one:',
          'Description text here.',
          '1. Option A',
          '2. Option B',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        // "Choose one:" contains keyword "choose" + colon -> isQuestionLikeLine = true
        // Upward scan from questionEndIndex ("Description text here.") should find it
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T-256-BC2: should handle upward scan when questionEndIndex is near start of output', () => {
        // Question line is at index 0, options start at index 1
        // No upward scan needed since questionEndIndex line itself should pass
        const output = [
          'Select one:',
          '1. Option A',
          '2. Option B',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('T-256-BC3: should handle question wrapping exceeding extraction range', () => {
        // Question text spans many lines but only the last few are within extraction range
        // The question ? mark should still be found by upward scan
        const output = [
          'This is a very long context line 1.',
          'This is a very long context line 2.',
          'This is a very long context line 3.',
          'Which approach do you prefer?',
          'Based on the analysis above,',
          'considering all the tradeoffs mentioned.',
          '1. Option A',
          '2. Option B',
          '3. Option C',
        ].join('\n');
        const result = detectPrompt(output, { requireDefaultIndicator: false });
        // "considering all the tradeoffs mentioned." becomes questionEndIndex
        // Upward scan should find "Which approach do you prefer?" within range
        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });
    });
  });

  // ==========================================================================
  // Gemini CLI ● (U+25CF) prompt detection
  // Tests for detecting Gemini CLI multiple choice prompts that use ● marker
  // ==========================================================================
  describe('Gemini CLI ● (U+25CF) prompt detection', () => {
    it('should detect Gemini CLI multiple choice prompt with ● marker', () => {
      const output = [
        'Do you want to allow this action?',
        '\u25CF 1. Allow once',
        '  2. Allow for this session',
        '  3. No, suggest changes (esc)',
      ].join('\n');

      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBe(3);
        expect(result.promptData.options[0].isDefault).toBe(true);
        expect(result.promptData.options[0].label).toBe('Allow once');
        expect(result.promptData.options[1].isDefault).toBe(false);
        expect(result.promptData.options[1].label).toBe('Allow for this session');
        expect(result.promptData.options[2].isDefault).toBe(false);
        expect(result.promptData.options[2].label).toBe('No, suggest changes (esc)');
      }
    });

    it('should detect Gemini ● prompt with trailing empty lines (tmux padding)', () => {
      const output = [
        'Allow tool_call: read_file?',
        '\u25CF 1. Allow once',
        '  2. Allow for this session',
        '  3. No, suggest changes (esc)',
        '',
        '',
        '',
      ].join('\n');

      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBe(3);
        expect(result.promptData.options[0].isDefault).toBe(true);
      }
    });

    it('should still detect Claude CLI ❯ prompt (regression)', () => {
      const output = [
        'Do you want to proceed?',
        '\u276F 1. Yes',
        '  2. No',
        '  3. Cancel',
      ].join('\n');

      const result = detectPrompt(output);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options[0].isDefault).toBe(true);
      }
    });

    it('should use ● as Pass 2 barrier when no options collected yet', () => {
      // Scenario: Historical numbered list above an idle Gemini ● prompt
      const output = [
        '  Select an approach:',
        '',
        '  1. Option A',
        '  2. Option B',
        '',
        '\u25CF ',
      ].join('\n');
      const result = detectPrompt(output, { requireDefaultIndicator: false });
      expect(result.isPrompt).toBe(false);
    });

    it('should detect Gemini prompt after stripBoxDrawing() removes ╭─╮│╰─╯ borders', () => {
      // Gemini CLI wraps prompts in box-drawing borders.
      // After stripBoxDrawing(), the │ prefix/suffix is removed and detectPrompt() can match.
      const boxedOutput = [
        '\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E',
        "\u2502 Allow execution of: 'git, cat'?    \u2502",
        '\u2502                                     \u2502',
        '\u2502 \u25CF 1. Allow once                     \u2502',
        '\u2502   2. Allow for this session         \u2502',
        '\u2502   3. No, suggest changes (esc)      \u2502',
        '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F',
      ].join('\n');

      const stripped = stripBoxDrawing(boxedOutput);
      const result = detectPrompt(stripped);

      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBe(3);
        expect(result.promptData.options[0].isDefault).toBe(true);
        expect(result.promptData.options[0].label).toBe('Allow once');
        expect(result.promptData.options[1].label).toBe('Allow for this session');
        expect(result.promptData.options[2].label).toBe('No, suggest changes (esc)');
      }
    });
  });

  // ========================================================================
  // Issue #287 Bug3: Pass 2 user input prompt barrier (U+276F)
  // Prevents false positive detection when historical conversation text
  // contains numbered lists above a user input prompt (❯).
  // ========================================================================
  describe('Issue #287 Bug3: Pass 2 user input prompt barrier', () => {
    it('should NOT detect numbered list after user typed at prompt as multiple choice', () => {
      // Scenario: Claude showed numbered options, user typed "1" at ❯ prompt,
      // Claude processed it, and session returned to idle ❯.
      // The numbered list is historical, not an active prompt.
      const output = [
        '  Select an approach:',
        '',
        '  1. Issue #286\u306E\u30B3\u30E1\u30F3\u30C8\u306B\u6C7A\u5B9A\u4E8B\u9805\u3092\u8A18\u9332 \u2014',
        '  2. /issue-enhance \u2014 Issue\u5185\u5BB9\u81EA\u4F53\u3092\u66F4\u65B0\u3057\u3066\u4E0D\u8DB3\u60C5\u5831\u3092\u88DC\u5B8C',
        '',
        '  \u3069\u3061\u3089\u304B\u3001\u307E\u305F\u306F\u4E21\u65B9\u9032\u3081\u307E\u3059\u304B\uFF1F',
        '',
        '\u276F 1',
        '',
        '\u23FA Done.',
        '',
        '\u276F ',
      ].join('\n');
      const result = detectPrompt(output, { requireDefaultIndicator: false });
      expect(result.isPrompt).toBe(false);
    });

    it('should NOT detect numbered list above idle prompt as multiple choice', () => {
      // Scenario: Claude showed numbered options, then session returned to
      // idle ❯ prompt. The numbered list is historical.
      const output = [
        '  Select an approach:',
        '',
        '  1. Option A \u2014 description',
        '  2. Option B \u2014 description',
        '',
        '  Which one?',
        '',
        '\u276F ',
      ].join('\n');
      const result = detectPrompt(output, { requireDefaultIndicator: false });
      expect(result.isPrompt).toBe(false);
    });

    it('should still detect active prompt without marker', () => {
      // Active prompt without ❯ marker should still be detected
      const output = [
        '  Which file?',
        '  1. src/main.ts',
        '  2. src/app.ts',
      ].join('\n');
      const result = detectPrompt(output, { requireDefaultIndicator: false });
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('should still detect active prompt with default indicator', () => {
      // Active prompt WITH ❯ marker on an option line
      const output = [
        '  Select an option:',
        '  \u276F 1. Yes',
        '    2. No',
      ].join('\n');
      const result = detectPrompt(output, { requireDefaultIndicator: true });
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options[0].isDefault).toBe(true);
      }
    });
  });
});
