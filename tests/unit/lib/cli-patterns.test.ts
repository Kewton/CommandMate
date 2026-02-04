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
});
