/**
 * Issue #208 Acceptance Test
 * Auto-Yes numbered list false positive prevention (SEC-001b)
 *
 * Verifies all 5 acceptance criteria:
 * AC1: Normal numbered lists are NOT falsely detected as multiple_choice prompts
 * AC2: Claude Code real prompts are correctly detected
 * AC3: Codex/Gemini existing behavior is unaffected
 * AC4: Issue #193 functionality does not regress
 * AC5: Issue #161 functionality does not regress
 */

import { describe, it, expect } from 'vitest';
import { detectPrompt } from '@/lib/prompt-detector';
import type { DetectPromptOptions } from '@/lib/prompt-detector';
import type { PromptData, MultipleChoicePromptData } from '@/types/models';

// Type guard for MultipleChoicePromptData
function isMultipleChoicePrompt(data: PromptData | undefined): data is MultipleChoicePromptData {
  return data?.type === 'multiple_choice';
}

describe('Issue #208 Acceptance Test', () => {
  // ========================================================================
  // AC1: Normal numbered lists are NOT falsely detected as multiple_choice
  // ========================================================================
  describe('AC1: Normal numbered list false positive prevention', () => {
    const falseOptions: DetectPromptOptions = { requireDefaultIndicator: false };

    it('AC1-1: Subagent completion output with numbered steps should NOT trigger Auto-Yes', () => {
      // Real-world scenario: Claude CLI outputs a numbered list after completing a task
      const output = [
        'I have completed the following changes:',
        '1. Created the new component file',
        '2. Added unit tests',
        '3. Updated the documentation',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC1-2: Markdown heading + numbered list should NOT be detected', () => {
      const output = [
        '## Recommendations:',
        '1. Add test coverage for edge cases',
        '2. Update the API documentation',
        '3. Run performance benchmarks',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC1-3: Plain numbered list with no heading should NOT be detected (SEC-001a)', () => {
      const output = [
        '1. First step',
        '2. Second step',
        '3. Third step',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC1-4: Step description with past tense heading should NOT be detected (SEC-001b)', () => {
      const output = [
        'I performed these steps:',
        '1. Analyzed the codebase',
        '2. Identified the root cause',
        '3. Applied the fix',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC1-5: Numbered list after long output should NOT be detected', () => {
      const longOutput = Array.from({ length: 200 }, (_, i) => `Processing line ${i + 1}`).join('\n');
      const output = longOutput + '\nResults:\n1. All tests passed\n2. Build succeeded';

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(false);
    });
  });

  // ========================================================================
  // AC2: Claude Code real prompts are correctly detected
  // ========================================================================
  describe('AC2: Claude Code real prompt detection', () => {
    const falseOptions: DetectPromptOptions = { requireDefaultIndicator: false };

    it('AC2-1: Question mark + numbered choices should be detected', () => {
      const output = [
        'Do you want to proceed?',
        '  1. Yes',
        '  2. No',
        '  3. Cancel',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(3);
        expect(result.promptData.question).toContain('Do you want to proceed?');
      }
    });

    it('AC2-2: Select keyword + colon + numbered choices should be detected', () => {
      const output = [
        'Select an option:',
        '1. Development mode',
        '2. Production mode',
        '3. Staging mode',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('AC2-3: Choose keyword + colon should be detected', () => {
      const output = [
        'Choose a deployment target:',
        '1. AWS',
        '2. GCP',
        '3. Azure',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('AC2-4: Claude Code 4-option tool permission prompt should be detected', () => {
      const output = [
        'Do you want to proceed?',
        '  1. Yes',
        "  2. Yes, and don't ask again for this tool",
        '  3. No',
        '  4. No, and stop for now',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(4);
      }
    });

    it('AC2-5: Indented Bash tool question format should be detected', () => {
      const output = [
        '  Allow this command?',
        '  1. Yes',
        '  2. No',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('AC2-6: Full-width question mark (Japanese) should be detected', () => {
      const output = [
        '\u3069\u3061\u3089\u3092\u9078\u3073\u307e\u3059\u304b\uff1f',
        '1. \u30aa\u30d7\u30b7\u30e7\u30f3A',
        '2. \u30aa\u30d7\u30b7\u30e7\u30f3B',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(true);
    });
  });

  // ========================================================================
  // AC3: Codex/Gemini existing behavior is unaffected
  // ========================================================================
  describe('AC3: Codex/Gemini existing behavior maintenance', () => {
    it('AC3-1: Default (requireDefaultIndicator=true) with cursor should be detected', () => {
      const output = [
        'Do you want to proceed?',
        '\u276F 1. Yes',
        '  2. No',
      ].join('\n');

      // No options = defaults to requireDefaultIndicator: true
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('AC3-2: Default (requireDefaultIndicator=true) without cursor should NOT be detected', () => {
      const output = [
        'Which option?',
        '  1. Yes',
        '  2. No',
      ].join('\n');

      // No options = defaults to requireDefaultIndicator: true
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(false);
    });

    it('AC3-3: Explicit requireDefaultIndicator=true should behave identically to default', () => {
      const output = [
        'Steps to follow:',
        '1. Install dependencies',
        '2. Run tests',
        '3. Deploy',
      ].join('\n');

      const explicitTrue: DetectPromptOptions = { requireDefaultIndicator: true };
      const resultExplicit = detectPrompt(output, explicitTrue);
      const resultDefault = detectPrompt(output);

      expect(resultExplicit.isPrompt).toBe(resultDefault.isPrompt);
      expect(resultExplicit.isPrompt).toBe(false);
    });

    it('AC3-4: SEC-001b guard should NOT apply when requireDefaultIndicator=true', () => {
      // With cursor present, even a non-question heading should be detected
      // because SEC-001b only applies when requireDefault is false
      const output = [
        'Results:',
        '\u276F 1. Option A',
        '  2. Option B',
      ].join('\n');

      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('AC3-5: buildDetectPromptOptions returns correct values per tool', async () => {
      const { buildDetectPromptOptions } = await import('@/lib/cli-patterns');

      // Claude: requireDefaultIndicator: false
      const claudeOpts = buildDetectPromptOptions('claude');
      expect(claudeOpts).toEqual({ requireDefaultIndicator: false });

      // Codex: undefined (uses default = true)
      const codexOpts = buildDetectPromptOptions('codex');
      expect(codexOpts).toBeUndefined();

      // Gemini: undefined (uses default = true)
      const geminiOpts = buildDetectPromptOptions('gemini');
      expect(geminiOpts).toBeUndefined();
    });
  });

  // ========================================================================
  // AC4: Issue #193 regression check
  // ========================================================================
  describe('AC4: Issue #193 regression check (Claude Code choice prompt detection)', () => {
    const falseOptions: DetectPromptOptions = { requireDefaultIndicator: false };

    it('AC4-1: requireDefaultIndicator=false should detect numbered choices without cursor', () => {
      const output = [
        'Which option would you like?',
        '  1. Yes',
        '  2. No',
        '  3. Cancel',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options).toHaveLength(3);
        expect(result.promptData.options.every(opt => opt.isDefault === false)).toBe(true);
      }
    });

    it('AC4-2: Layer 3 (consecutive validation) still works with requireDefaultIndicator=false', () => {
      const output = [
        'Select one:',
        '  1. Option A',
        '  3. Option C',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC4-3: Layer 4 (minimum 2 options) still works with requireDefaultIndicator=false', () => {
      const output = [
        'Select one:',
        '  1. Only option',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC4-4: SEC-001a (no question line) guard still works', () => {
      const output = [
        '1. Create file',
        '2. Run tests',
        '3. Deploy',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(false);
    });

    it('AC4-5: requireDefaultIndicator=false with cursor present should still mark isDefault correctly', () => {
      const output = [
        'Do you want to proceed?',
        '\u276F 1. Yes',
        '  2. No',
      ].join('\n');

      const result = detectPrompt(output, falseOptions);
      expect(result.isPrompt).toBe(true);
      if (isMultipleChoicePrompt(result.promptData)) {
        expect(result.promptData.options[0].isDefault).toBe(true);
        expect(result.promptData.options[1].isDefault).toBe(false);
      }
    });
  });

  // ========================================================================
  // AC5: Issue #161 regression check
  // ========================================================================
  describe('AC5: Issue #161 regression check (2-pass detection)', () => {
    it('AC5-1: Plain numbered list without cursor should NOT be detected (Layer 2)', () => {
      const output = '1. Create file\n2. Run tests';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(false);
    });

    it('AC5-2: Indented numbered list without cursor should NOT be detected (Layer 2)', () => {
      const output = '  1. Yes\n  2. No';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(false);
    });

    it('AC5-3: Non-consecutive numbers should NOT be detected (Layer 3)', () => {
      const output = '\u276F 1. Option A\n  3. Option B';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(false);
    });

    it('AC5-4: Options not starting from 1 should NOT be detected (Layer 3)', () => {
      const output = '\u276F 2. Option A\n  3. Option B';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(false);
    });

    it('AC5-5: Single option should NOT be detected (Layer 4)', () => {
      const output = '\u276F 1. Only option';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(false);
    });

    it('AC5-6: Valid cursor-indicated prompt should be detected (all layers pass)', () => {
      const output = '\u276F 1. Yes\n  2. No';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');
    });

    it('AC5-7: CLI step descriptions should NOT be detected (Layer 2)', () => {
      const output = "I'll do the following:\n1. Create file\n2. Run tests\n3. Commit";
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(false);
    });

    it('AC5-8: 50-line window boundary - cursor at boundary should be detected', () => {
      const fillerLines = Array.from({ length: 49 }, (_, i) => `Line ${i + 1}`).join('\n');
      const output = fillerLines + '\n\u276F 1. Yes\n  2. No';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
    });

    it('AC5-9: yes/no pattern (y/n) should still work', () => {
      const output = 'Proceed? (y/n)';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('yes_no');
    });

    it('AC5-10: Approve? pattern should still work', () => {
      const output = 'Approve?';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('yes_no');
    });

    it('AC5-11: [Y/n] pattern should still work', () => {
      const output = 'Continue? [Y/n]';
      const result = detectPrompt(output);
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('yes_no');
    });

    it('AC5-12: Thinking-prompt ordering should prevent false positives', async () => {
      const { detectThinking } = await import('@/lib/cli-patterns');

      const thinkingOutput = [
        '\u2733 Analyzing the code\u2026',
        'Here are the steps:',
        '\u276F 1. Yes',
        '  2. No',
      ].join('\n');

      const isThinking = detectThinking('claude', thinkingOutput);
      expect(isThinking).toBe(true);

      // When thinking, prompt detection should be skipped (caller responsibility)
      const promptDetection = isThinking
        ? { isPrompt: false, cleanContent: thinkingOutput }
        : detectPrompt(thinkingOutput);
      expect(promptDetection.isPrompt).toBe(false);
    });
  });
});
