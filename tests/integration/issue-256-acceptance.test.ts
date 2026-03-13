/**
 * Issue #256 Acceptance Test
 * Multiple choice prompt detection improvement for wrapped questions and model selection
 *
 * Verifies all acceptance criteria:
 * AC1: Multi-line wrapped question detection (Pattern A)
 * AC2: Inline question mark detection (Pattern 2)
 * AC3: Single-line question regression
 * AC4: Model selection prompt detection (Pattern B)
 * AC5: requireDefaultIndicator: true regression
 * AC6: SEC-001 false positive prevention
 * AC7: T11h-T11m false positive prevention
 * AC8: URL parameter false positive prevention
 * AC9: Auto-Yes safety (no false positive auto-responses)
 * AC10: isContinuationLine() interaction (MF-001)
 * AC11: Upward scan boundary tests
 * AC12: questionEndIndex boundary tests
 * AC13: Existing prompt-detector tests regression
 */

import { describe, it, expect } from 'vitest';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import type { DetectPromptOptions } from '@/lib/detection/prompt-detector';
import { isMultipleChoicePrompt } from '../helpers/prompt-type-guards';

describe('Issue #256 Acceptance Test: Multiple choice prompt detection improvement', () => {
  const claudeCliOptions: DetectPromptOptions = { requireDefaultIndicator: false };

  // ========================================================================
  // Scenario 1: Multi-line wrapped question detection
  // ========================================================================
  describe('Scenario 1: Multi-line wrapped question detection', () => {
    it('AC1: should detect prompt when question wraps to multiple lines ending with period', () => {
      // Simulates AskUserQuestion where the question text wraps due to terminal width
      // The question mark appears on one line, but the sentence continues on the next line
      const output = [
        '\u5bfe\u7b56\u65b9\u91dd\u3068\u3057\u3066\u3069\u308c\u304c\u9069\u5207\u3067\u3059\u304b\uff1f\u30b3\u30fc\u30c9\u8abf\u67fb\u306e\u7d50\u679c\u3001',
        '\u30a8\u30e9\u30fc\u6642\u306e\u81ea\u52d5\u30ea\u30c8\u30e9\u30a4\u3082\u306a\u3044\u3053\u3068\u304c\u539f\u56e0\u3068\u63a8\u6e2c\u3055\u308c\u307e\u3059\u3002',
        '1. \u65b9\u91ddA',
        '2. \u65b9\u91ddB',
        '3. \u65b9\u91ddC',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBe(3);
      }
    });

    it('AC2: should detect prompt when question mark is mid-line due to wrapping', () => {
      // Question mark appears in the middle of a line (not at the end)
      // This is handled by Pattern 2 (inline ? check) in isQuestionLikeLine()
      const output = [
        '\u3069\u308c\u304c\u9069\u5207\u3067\u3059\u304b\uff1f\u30b3\u30fc\u30c9\u8abf\u67fb\u306e\u7d50\u679c\u3001\u30a8\u30e9\u30fc\u6642\u306e\u81ea\u52d5\u30ea\u30c8\u30e9\u30a4',
        '\u3082\u306a\u3044\u3053\u3068\u304c\u539f\u56e0\u3068\u63a8\u6e2c\u3055\u308c\u307e\u3059\u3002',
        '1. \u65b9\u91ddA',
        '2. \u65b9\u91ddB',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('AC3: should still detect single-line question (regression)', () => {
      // Existing behavior: single-line question ending with ?
      const output = [
        '\u3069\u308c\u304c\u9069\u5207\u3067\u3059\u304b\uff1f',
        '1. \u65b9\u91ddA',
        '2. \u65b9\u91ddB',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });

  // ========================================================================
  // Scenario 2: Model selection prompt detection
  // ========================================================================
  describe('Scenario 2: Model selection prompt detection', () => {
    it('AC4: should detect model selection prompt (requireDefaultIndicator: false)', () => {
      // Claude CLI /model command output
      const output = [
        ' Select model',
        ' Switch between Claude models. For other model names, specify with --model.',
        '',
        ' \u276F 1. Default (recommended) \u2714  Opus 4.6',
        '   2. Sonnet                   Sonnet 4.5',
        '   3. Haiku                    Haiku 4.5',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBe(3);
        expect(result.promptData.options[0].label).toContain('Default');
      }
    });

    it('AC5: should detect model selection with requireDefaultIndicator: true (regression)', () => {
      // Standard detection path for Codex/Gemini tools
      const output = [
        ' Select model',
        ' \u276F 1. Default (recommended)',
        '   2. Sonnet',
        '   3. Haiku',
      ].join('\n');
      const result = detectPrompt(output); // default: requireDefaultIndicator: true
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('AC6: should maintain existing Codex/Gemini detection behavior (regression)', () => {
      // Standard multiple choice with cursor indicator
      const output = [
        'Which option do you prefer?',
        '\u276F 1. Option A',
        '  2. Option B',
        '  3. Option C',
      ].join('\n');
      const result = detectPrompt(output); // requireDefaultIndicator: true (default)
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBe(3);
      }
    });

    it('AC6b: should detect Codex approval choices without cursor when confirmation footer is present', () => {
      const output = [
        'Would you like to run the following command?',
        '',
        '  $ npm test',
        '',
        '  1. Yes, proceed (y)',
        '  2. Yes, and don\'t ask again for commands that start with `npm test` (p)',
        '  3. No, and tell Codex what to do differently (esc)',
        '',
        '  Press enter to confirm or esc to cancel',
      ].join('\n');

      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBe(3);
      }
    });

    it('AC6c: should ignore decimal-looking preview lines before Codex approval choices', () => {
      const output = [
        'mode: plan | hint: /memory show | tokens: 2400/200000',
        'anvil>',
        '  workspace/implementation-plan-phases.md && git commit -m "Implement Phase',
        '  3.2 local model stabilization"',
        '',
        '› 1. Yes, proceed (y)',
        '  2. Yes, and don\'t ask again for commands that start with `git add foo` (p)',
        '  3. No, and tell Codex what to do differently (esc)',
        '',
        '  Press enter to confirm or esc to cancel',
      ].join('\n');

      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options.length).toBe(3);
      }
    });
  });

  // ========================================================================
  // Scenario 3: False Positive prevention
  // ========================================================================
  describe('Scenario 3: False Positive prevention', () => {
    it('AC7: should NOT detect normal numbered list as prompt (SEC-001)', () => {
      // "Steps:" does not match QUESTION_KEYWORD_PATTERN - no false positive
      const output = [
        'Steps:',
        '1. Create the component file',
        '2. Write unit tests',
        '3. Update documentation',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC7b: should NOT detect "Recommendations:" numbered list as prompt', () => {
      const output = [
        '## Recommendations:',
        '1. Add test coverage for edge cases',
        '2. Update the API documentation',
        '3. Run performance benchmarks',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC7c: should NOT detect numbered list without heading as prompt (SEC-001a)', () => {
      const output = [
        '1. First step',
        '2. Second step',
        '3. Third step',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC8: T11h-T11m false positive prevention still works', () => {
      // Test that standard completion messages with numbered lists are not detected
      const output = [
        'Here are the changes I made:',
        '1. Updated configuration file',
        '2. Added new component',
        '3. Fixed the failing tests',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC9: URL parameter containing ? does not cause false negative on real prompts', () => {
      // A real question line should still be detected even if URLs are nearby
      const output = [
        'See https://example.com/help?topic=models for details.',
        'Which model do you want to use?',
        '1. Model A',
        '2. Model B',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('AC12: upward scan does not match keyword line beyond QUESTION_SCAN_RANGE', () => {
      // Question line is too far above the options to be found by upward scan
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
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(false);
    });
  });

  // ========================================================================
  // Scenario 4: Auto-Yes safety
  // ========================================================================
  describe('Scenario 4: Auto-Yes safety', () => {
    it('AC10: Auto-Yes should not trigger on false positive numbered list', () => {
      // Simulates a scenario where Auto-Yes is enabled and numbered list appears
      // The prompt detector must return isPrompt: false so Auto-Yes does not respond
      const output = [
        'I have completed the following tasks:',
        '1. Created database migration',
        '2. Updated schema',
        '3. Ran tests successfully',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      // If this is false, Auto-Yes will not trigger (safe)
      expect(result.isPrompt).toBe(false);
    });

    it('AC10b: Auto-Yes should correctly trigger on real prompts', () => {
      // Real question prompt should be detected so Auto-Yes can respond
      const output = [
        'Do you want to proceed with the changes?',
        '1. Yes, apply all changes',
        '2. No, cancel',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });

  // ========================================================================
  // AC11: isContinuationLine() interaction (MF-001)
  // ========================================================================
  describe('AC11: isContinuationLine() interaction', () => {
    it('should not misclassify indented "Select model" as continuation line', () => {
      // MF-001: isQuestionLikeLine() pre-check in Pass 2 prevents this
      const output = [
        '  Select model',
        '  Description text ending with period.',
        '  \u276F 1. Option A',
        '    2. Option B',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });

  // ========================================================================
  // AC13: questionEndIndex boundary and upward scan tests
  // ========================================================================
  describe('AC13: Boundary condition tests', () => {
    it('should handle upward scan correctly with empty/separator lines', () => {
      const output = [
        'Which option?',
        '',
        '---',
        '1. Option A',
        '2. Option B',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('should handle questionEndIndex at start of output', () => {
      const output = [
        'Select one:',
        '1. Option A',
        '2. Option B',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('should handle scanStart boundary correctly', () => {
      // Generate enough filler lines so scanStart > 0
      const fillerLines = Array.from({ length: 47 }, (_, i) => `Filler line ${i + 1}`);
      const output = [
        ...fillerLines,
        'Choose one:',
        'Description text here.',
        '1. Option A',
        '2. Option B',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('should handle question wrapping exceeding extraction range', () => {
      const output = [
        'Context line 1.',
        'Context line 2.',
        'Which approach do you prefer?',
        'Based on the analysis above,',
        'considering all the tradeoffs.',
        '1. Option A',
        '2. Option B',
        '3. Option C',
      ].join('\n');
      const result = detectPrompt(output, claudeCliOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });
  });

  // ========================================================================
  // AC14: Existing prompt-detector test regression (covered by running full suite)
  // ========================================================================
  describe('AC14: Key regression checks', () => {
    it('should still detect yes/no prompts correctly', () => {
      const result = detectPrompt('Do you want to proceed? (y/n)');
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('yes_no');
      expect(result.promptData?.question).toBe('Do you want to proceed?');
    });

    it('should still detect Approve? prompts correctly', () => {
      const result = detectPrompt('Approve?');
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('yes_no');
    });

    it('should not detect normal text as prompt', () => {
      const result = detectPrompt('This is just some normal output text.');
      expect(result.isPrompt).toBe(false);
    });
  });
});
