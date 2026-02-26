/**
 * Unit tests for CLI tool patterns
 * Issue #4: Codex CLI support - Pattern modifications
 */

import { describe, it, expect } from 'vitest';
import {
  CODEX_THINKING_PATTERN,
  CODEX_PROMPT_PATTERN,
  PASTED_TEXT_PATTERN,
  PASTED_TEXT_DETECT_DELAY,
  MAX_PASTED_TEXT_RETRIES,
  getCliToolPatterns,
  detectThinking,
  stripAnsi,
  stripBoxDrawing,
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
      // Note: Claude thinking pattern requires the ellipsis character (U+2026) not three dots (...)
      expect(detectThinking('claude', '\u2733 Analyzing something\u2026')).toBe(true);
      // Pattern was updated to 'esc to interrupt' (not 'to interrupt)') in Claude Code v2.x
      expect(detectThinking('claude', 'esc to interrupt')).toBe(true);
    });

    it('should return false for gemini', () => {
      expect(detectThinking('gemini', 'any content')).toBe(false);
    });

    it('should use claude patterns as default for unknown tool', () => {
      // @ts-expect-error - Testing invalid input for default branch
      expect(detectThinking('unknown', '\u2733 Analyzing something\u2026')).toBe(true);
      // @ts-expect-error - Testing invalid input for default branch
      expect(detectThinking('unknown', 'Normal output')).toBe(false);
    });
  });

  // Issue #188 Task 2.2: Additional thinking pattern tests
  describe('CLAUDE_THINKING_PATTERN - Issue #188', () => {
    it('should match completed thinking summary (e.g., "Churned for 41s")', () => {
      // The pattern itself matches completed summaries; false detection is prevented
      // by windowing in status-detector.ts (STATUS_THINKING_LINE_COUNT=5)
      const { thinkingPattern } = getCliToolPatterns('claude');
      expect(thinkingPattern.test('\u2733 Churned for 41s\u2026')).toBe(true);
    });

    it('should match "(esc to interrupt)" thinking indicator', () => {
      const { thinkingPattern } = getCliToolPatterns('claude');
      expect(thinkingPattern.test('Planning \u00b7 (esc to interrupt)')).toBe(true);
    });

    it('should match active thinking indicator', () => {
      const { thinkingPattern } = getCliToolPatterns('claude');
      expect(thinkingPattern.test('\u2733 Planning\u2026')).toBe(true);
    });

    it('should match thinking summary with duration', () => {
      const { thinkingPattern } = getCliToolPatterns('claude');
      expect(thinkingPattern.test('\u00b7 Simmering\u2026 (4m 16s)')).toBe(true);
    });

    it('should match thinking with parenthetical description', () => {
      const { thinkingPattern } = getCliToolPatterns('claude');
      expect(thinkingPattern.test('\u2733 Verifying implementation (dead code detection)\u2026')).toBe(true);
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

  // Issue #212: Pasted text detection constants and patterns
  describe('PASTED_TEXT_PATTERN (Issue #212)', () => {
    it('should match standard Pasted text format', () => {
      expect(PASTED_TEXT_PATTERN.test('[Pasted text #1 +46 lines]')).toBe(true);
      expect(PASTED_TEXT_PATTERN.test('[Pasted text #2 +3 lines]')).toBe(true);
      expect(PASTED_TEXT_PATTERN.test('[Pasted text #10 +100 lines]')).toBe(true);
    });

    it('should not match normal text', () => {
      expect(PASTED_TEXT_PATTERN.test('Hello world')).toBe(false);
      expect(PASTED_TEXT_PATTERN.test('[Some other text]')).toBe(false);
      expect(PASTED_TEXT_PATTERN.test('Pasted text')).toBe(false);
    });

    it('should match partial line containing Pasted text', () => {
      expect(PASTED_TEXT_PATTERN.test('some prefix [Pasted text #1 +5 lines]')).toBe(true);
    });
  });

  describe('Pasted text constants (Issue #212)', () => {
    it('should export PASTED_TEXT_DETECT_DELAY as 500', () => {
      expect(PASTED_TEXT_DETECT_DELAY).toBe(500);
    });

    it('should export MAX_PASTED_TEXT_RETRIES as 3', () => {
      expect(MAX_PASTED_TEXT_RETRIES).toBe(3);
    });
  });

  describe('getCliToolPatterns skipPatterns - Pasted text (Issue #212)', () => {
    it('should include PASTED_TEXT_PATTERN in claude skipPatterns', () => {
      const patterns = getCliToolPatterns('claude');
      const hasPastedTextPattern = patterns.skipPatterns.some(
        p => p.test('[Pasted text #1 +46 lines]')
      );
      expect(hasPastedTextPattern).toBe(true);
    });

    it('should include PASTED_TEXT_PATTERN in codex skipPatterns', () => {
      const patterns = getCliToolPatterns('codex');
      const hasPastedTextPattern = patterns.skipPatterns.some(
        p => p.test('[Pasted text #1 +46 lines]')
      );
      expect(hasPastedTextPattern).toBe(true);
    });
  });

  // Issue #368: stripBoxDrawing - Gemini CLI box-drawing border removal
  describe('stripBoxDrawing', () => {
    it('should remove border-only lines (╭──╮, ╰──╯)', () => {
      const input = [
        '\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E',
        '\u2502 content \u2502',
        '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F',
      ].join('\n');
      const result = stripBoxDrawing(input);
      const lines = result.split('\n');
      expect(lines[0]).toBe('');
      expect(lines[1]).toBe('content');
      expect(lines[2]).toBe('');
    });

    it('should strip leading │ and trailing │ from content lines', () => {
      const input = '\u2502 \u25CF 1. Allow once                \u2502';
      const result = stripBoxDrawing(input);
      expect(result).toBe('\u25CF 1. Allow once');
    });

    it('should pass through lines without box-drawing characters', () => {
      const input = 'Normal text without borders';
      expect(stripBoxDrawing(input)).toBe('Normal text without borders');
    });

    it('should handle full Gemini box-wrapped prompt', () => {
      const input = [
        '\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E',
        "\u2502 Allow execution of: 'git, cat'?    \u2502",
        '\u2502                                     \u2502',
        '\u2502 \u25CF 1. Allow once                     \u2502',
        '\u2502   2. Allow for this session         \u2502',
        '\u2502   3. No, suggest changes (esc)      \u2502',
        '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F',
      ].join('\n');
      const result = stripBoxDrawing(input);
      const lines = result.split('\n').filter(l => l.trim() !== '');
      expect(lines).toContain("Allow execution of: 'git, cat'?");
      expect(lines).toContain('\u25CF 1. Allow once');
      expect(lines).toContain('  2. Allow for this session');
      expect(lines).toContain('  3. No, suggest changes (esc)');
    });

    it('should handle │-only lines (vertical border)', () => {
      const input = '\u2502';
      expect(stripBoxDrawing(input)).toBe('');
    });

    it('should handle empty string', () => {
      expect(stripBoxDrawing('')).toBe('');
    });
  });
});
