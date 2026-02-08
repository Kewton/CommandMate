/**
 * Unit tests for CLI tool patterns
 * Issue #4: Codex CLI support - Pattern modifications
 */

import { describe, it, expect } from 'vitest';
import {
  CODEX_THINKING_PATTERN,
  CODEX_PROMPT_PATTERN,
  getCliToolPatterns,
  detectThinking,
  stripAnsi,
  getChoiceDetectionPatterns,
  detectPromptForCli,
  CLAUDE_CHOICE_INDICATOR_PATTERN,
  CLAUDE_CHOICE_NORMAL_PATTERN,
  CODEX_CHOICE_INDICATOR_PATTERN,
  CODEX_CHOICE_NORMAL_PATTERN,
} from '@/lib/cli-patterns';
import type { CLIToolType } from '@/lib/cli-tools/types';

describe('cli-patterns', () => {
  describe('CODEX_THINKING_PATTERN', () => {
    it('should match existing thinking indicators', () => {
      expect(CODEX_THINKING_PATTERN.test('• Planning')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Searching')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Exploring')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Running')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Thinking')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Working')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Reading')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Writing')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Analyzing')).toBe(true);
    });

    // T1.1: Extended patterns for Ran and Deciding
    it('should match "Ran" thinking indicator (T1.1)', () => {
      expect(CODEX_THINKING_PATTERN.test('• Ran')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Ran ls -la')).toBe(true);
    });

    it('should match "Deciding" thinking indicator (T1.1)', () => {
      expect(CODEX_THINKING_PATTERN.test('• Deciding')).toBe(true);
      expect(CODEX_THINKING_PATTERN.test('• Deciding which approach to take')).toBe(true);
    });

    it('should not match non-thinking indicators', () => {
      expect(CODEX_THINKING_PATTERN.test('Planning')).toBe(false);
      expect(CODEX_THINKING_PATTERN.test('Random text')).toBe(false);
      expect(CODEX_THINKING_PATTERN.test('› prompt')).toBe(false);
    });
  });

  describe('CODEX_PROMPT_PATTERN', () => {
    it('should match prompt with text', () => {
      expect(CODEX_PROMPT_PATTERN.test('› hello world')).toBe(true);
      expect(CODEX_PROMPT_PATTERN.test('› /command')).toBe(true);
    });

    // T1.2: Empty prompt detection
    it('should match empty prompt (T1.2)', () => {
      expect(CODEX_PROMPT_PATTERN.test('›')).toBe(true);
      expect(CODEX_PROMPT_PATTERN.test('› ')).toBe(true);
      expect(CODEX_PROMPT_PATTERN.test('›  ')).toBe(true);
    });

    it('should match prompt at line start in multiline content', () => {
      const content = `Some output
›
More text`;
      expect(CODEX_PROMPT_PATTERN.test(content)).toBe(true);
    });

    it('should not match non-prompt lines', () => {
      expect(CODEX_PROMPT_PATTERN.test('Some random text')).toBe(false);
      expect(CODEX_PROMPT_PATTERN.test('> not codex prompt')).toBe(false);
    });
  });

  describe('getCliToolPatterns', () => {
    // T1.4: Map-based lookup
    it('should return patterns for claude', () => {
      const patterns = getCliToolPatterns('claude');
      expect(patterns).toHaveProperty('promptPattern');
      expect(patterns).toHaveProperty('separatorPattern');
      expect(patterns).toHaveProperty('thinkingPattern');
      expect(patterns).toHaveProperty('skipPatterns');
      expect(Array.isArray(patterns.skipPatterns)).toBe(true);
    });

    it('should return patterns for codex', () => {
      const patterns = getCliToolPatterns('codex');
      expect(patterns).toHaveProperty('promptPattern');
      expect(patterns).toHaveProperty('separatorPattern');
      expect(patterns).toHaveProperty('thinkingPattern');
      expect(patterns).toHaveProperty('skipPatterns');
      expect(Array.isArray(patterns.skipPatterns)).toBe(true);
    });

    it('should return patterns for gemini', () => {
      const patterns = getCliToolPatterns('gemini');
      expect(patterns).toHaveProperty('promptPattern');
      expect(patterns).toHaveProperty('separatorPattern');
      expect(patterns).toHaveProperty('thinkingPattern');
      expect(patterns).toHaveProperty('skipPatterns');
      expect(Array.isArray(patterns.skipPatterns)).toBe(true);
    });

    it('should return claude patterns as default for unknown tool', () => {
      // @ts-expect-error - Testing invalid input
      const patterns = getCliToolPatterns('unknown');
      const claudePatterns = getCliToolPatterns('claude');
      expect(patterns).toEqual(claudePatterns);
    });

    // T1.3: skipPatterns additions
    describe('codex skipPatterns (T1.3)', () => {
      it('should include pattern for command execution lines (Ran)', () => {
        const patterns = getCliToolPatterns('codex');
        const ranPattern = patterns.skipPatterns.find(p => p.source.includes('Ran'));
        expect(ranPattern).toBeDefined();
        expect(ranPattern!.test('• Ran ls -la')).toBe(true);
      });

      it('should include pattern for tree output (└)', () => {
        const patterns = getCliToolPatterns('codex');
        const treePattern = patterns.skipPatterns.find(p => p.source.includes('└'));
        expect(treePattern).toBeDefined();
        expect(treePattern!.test('  └ completed')).toBe(true);
      });

      it('should include pattern for continuation lines (│)', () => {
        const patterns = getCliToolPatterns('codex');
        const contPattern = patterns.skipPatterns.find(p => p.source.includes('│'));
        expect(contPattern).toBeDefined();
        expect(contPattern!.test('  │ output line')).toBe(true);
      });

      it('should include pattern for interrupt hint', () => {
        const patterns = getCliToolPatterns('codex');
        const escPattern = patterns.skipPatterns.find(p => p.source.includes('esc to interrupt'));
        expect(escPattern).toBeDefined();
        expect(escPattern!.test('(press esc to interrupt)')).toBe(true);
      });
    });
  });

  describe('detectThinking', () => {
    it('should detect thinking for codex', () => {
      expect(detectThinking('codex', '• Planning something')).toBe(true);
      expect(detectThinking('codex', '• Ran command')).toBe(true);
      expect(detectThinking('codex', '• Deciding action')).toBe(true);
    });

    it('should not detect thinking when not thinking', () => {
      expect(detectThinking('codex', '› prompt text')).toBe(false);
      expect(detectThinking('codex', 'Normal output')).toBe(false);
    });

    it('should detect thinking for claude', () => {
      // Note: Claude thinking pattern requires the ellipsis character (…) not three dots (...)
      expect(detectThinking('claude', '✻ Analyzing something…')).toBe(true);
      expect(detectThinking('claude', 'to interrupt)')).toBe(true);
    });

    it('should return false for gemini', () => {
      expect(detectThinking('gemini', 'any content')).toBe(false);
    });
  });

  describe('stripAnsi', () => {
    it('should remove ANSI escape codes', () => {
      const input = '\x1b[31mRed text\x1b[0m';
      expect(stripAnsi(input)).toBe('Red text');
    });

    it('should handle text without ANSI codes', () => {
      const input = 'Plain text';
      expect(stripAnsi(input)).toBe('Plain text');
    });
  });

  // ==========================================================================
  // Issue #193: Choice detection patterns and wrapper
  // ==========================================================================
  describe('Issue #193: Choice detection patterns', () => {
    describe('CLAUDE_CHOICE_INDICATOR_PATTERN', () => {
      it('should match Claude indicator line with cursor marker', () => {
        expect(CLAUDE_CHOICE_INDICATOR_PATTERN.test('❯ 1. Yes')).toBe(true);
        expect(CLAUDE_CHOICE_INDICATOR_PATTERN.test('  ❯ 2. No')).toBe(true);
      });

      it('should NOT match line without cursor marker', () => {
        expect(CLAUDE_CHOICE_INDICATOR_PATTERN.test('  1. Yes')).toBe(false);
        expect(CLAUDE_CHOICE_INDICATOR_PATTERN.test('1. Yes')).toBe(false);
      });
    });

    describe('CLAUDE_CHOICE_NORMAL_PATTERN', () => {
      it('should match numbered option lines', () => {
        expect(CLAUDE_CHOICE_NORMAL_PATTERN.test('  1. Yes')).toBe(true);
        expect(CLAUDE_CHOICE_NORMAL_PATTERN.test('2. No')).toBe(true);
      });
    });

    describe('CODEX_CHOICE_INDICATOR_PATTERN', () => {
      it('should match Codex numbered options (no special marker)', () => {
        expect(CODEX_CHOICE_INDICATOR_PATTERN.test('1. Apply changes')).toBe(true);
        expect(CODEX_CHOICE_INDICATOR_PATTERN.test('  2. Skip')).toBe(true);
      });
    });

    describe('CODEX_CHOICE_NORMAL_PATTERN', () => {
      it('should match Codex numbered options', () => {
        expect(CODEX_CHOICE_NORMAL_PATTERN.test('1. Apply')).toBe(true);
        expect(CODEX_CHOICE_NORMAL_PATTERN.test('  3. Cancel')).toBe(true);
      });
    });

    describe('getChoiceDetectionPatterns', () => {
      it('should return correct patterns for claude with requireDefaultIndicator=true', () => {
        const patterns = getChoiceDetectionPatterns('claude');
        expect(patterns.requireDefaultIndicator).toBe(true);
        expect(patterns.choiceIndicatorPattern).toBe(CLAUDE_CHOICE_INDICATOR_PATTERN);
        expect(patterns.normalOptionPattern).toBe(CLAUDE_CHOICE_NORMAL_PATTERN);
      });

      it('should return correct patterns for codex with requireDefaultIndicator=false', () => {
        const patterns = getChoiceDetectionPatterns('codex');
        expect(patterns.requireDefaultIndicator).toBe(false);
        expect(patterns.choiceIndicatorPattern).toBe(CODEX_CHOICE_INDICATOR_PATTERN);
        expect(patterns.normalOptionPattern).toBe(CODEX_CHOICE_NORMAL_PATTERN);
      });

      it('should return Claude patterns as default for unknown tool', () => {
        // @ts-expect-error - Testing invalid input
        const patterns = getChoiceDetectionPatterns('unknown');
        const claudePatterns = getChoiceDetectionPatterns('claude');
        expect(patterns).toEqual(claudePatterns);
      });

      it('should return Claude patterns for gemini', () => {
        const patterns = getChoiceDetectionPatterns('gemini');
        const claudePatterns = getChoiceDetectionPatterns('claude');
        expect(patterns).toEqual(claudePatterns);
      });
    });

    describe('detectPromptForCli', () => {
      it('should detect Claude multiple choice prompt', () => {
        const output = 'Do you want to proceed?\n❯ 1. Yes\n  2. No';
        const result = detectPromptForCli(output, 'claude');

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('should detect Codex multiple choice prompt (no marker)', () => {
        const output = 'Which option?\n1. Apply changes\n2. Skip\n3. Cancel';
        const result = detectPromptForCli(output, 'codex');

        expect(result.isPrompt).toBe(true);
        expect(result.promptData?.type).toBe('multiple_choice');
      });

      it('should NOT detect plain numbered list for Claude', () => {
        const output = '1. Create file\n2. Run tests';
        const result = detectPromptForCli(output, 'claude');

        expect(result.isPrompt).toBe(false);
      });

      it('should detect yes/no prompt for both CLI tools', () => {
        const output = 'Do you want to continue? (y/n)';

        const claudeResult = detectPromptForCli(output, 'claude');
        expect(claudeResult.isPrompt).toBe(true);
        expect(claudeResult.promptData?.type).toBe('yes_no');

        const codexResult = detectPromptForCli(output, 'codex');
        expect(codexResult.isPrompt).toBe(true);
        expect(codexResult.promptData?.type).toBe('yes_no');
      });
    });

    describe('Codex pattern ReDoS safety', () => {
      it('should be anchored (start and end) to prevent backtracking', () => {
        // Verify patterns are anchored
        expect(CODEX_CHOICE_INDICATOR_PATTERN.source.startsWith('^')).toBe(true);
        expect(CODEX_CHOICE_INDICATOR_PATTERN.source.endsWith('$')).toBe(true);
        expect(CODEX_CHOICE_NORMAL_PATTERN.source.startsWith('^')).toBe(true);
        expect(CODEX_CHOICE_NORMAL_PATTERN.source.endsWith('$')).toBe(true);
      });

      it('should handle pathological input within 100ms (1000+ chars)', () => {
        const pathologicalInput = '1.' + ' '.repeat(1000) + 'a'.repeat(1000);
        const start = Date.now();
        CODEX_CHOICE_INDICATOR_PATTERN.test(pathologicalInput);
        CODEX_CHOICE_NORMAL_PATTERN.test(pathologicalInput);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(100);
      });
    });
  });
});
