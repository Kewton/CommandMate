/**
 * Unit tests for response-poller OpenCode integration
 * Issue #379: OpenCode response detection, completion, and cleaning
 */

import { describe, it, expect } from 'vitest';
import {
  isOpenCodeComplete,
  cleanOpenCodeResponse,
} from '@/lib/response-poller';
import {
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_THINKING_PATTERN,
  OPENCODE_LOADING_PATTERN,
  OPENCODE_RESPONSE_COMPLETE,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_SEPARATOR_PATTERN,
  OPENCODE_SKIP_PATTERNS,
} from '@/lib/cli-patterns';

describe('response-poller OpenCode integration', () => {
  describe('isOpenCodeComplete()', () => {
    it('should return true for Build summary line with model and timing', () => {
      const output = 'Some response content\n\u25A3  Build \u00b7 qwen3:8b \u00b7 2.5s\nAsk anything...';
      expect(isOpenCodeComplete(output)).toBe(true);
    });

    it('should return true for Build summary with different model', () => {
      const output = '\u25A3  Build \u00b7 llama3.1:70b \u00b7 15.3s';
      expect(isOpenCodeComplete(output)).toBe(true);
    });

    it('should return true for Build summary with decimal time', () => {
      const output = '\u25A3  Build \u00b7 mistral-nemo \u00b7 0.8s';
      expect(isOpenCodeComplete(output)).toBe(true);
    });

    it('should return false when loading (no Build line)', () => {
      const output = 'Thinking:\n\u2B1D\u2B1D\u2B1D\u2B1D\u2B1D\nSome partial response';
      expect(isOpenCodeComplete(output)).toBe(false);
    });

    it('should return false for empty output', () => {
      expect(isOpenCodeComplete('')).toBe(false);
    });

    it('should return false for output without Build summary', () => {
      const output = 'Ask anything...\ntab agents  ctrl+p commands';
      expect(isOpenCodeComplete(output)).toBe(false);
    });
  });

  describe('cleanOpenCodeResponse()', () => {
    it('should remove TUI separator characters', () => {
      const response = '\u2503\u2503\u2503\nActual content\n\u2500\u2500\u2500';
      const cleaned = cleanOpenCodeResponse(response);
      expect(cleaned).toBe('Actual content');
    });

    it('should remove Build summary line', () => {
      const response = 'Hello world\n\u25A3  Build \u00b7 qwen3:8b \u00b7 2.5s';
      const cleaned = cleanOpenCodeResponse(response);
      expect(cleaned).toBe('Hello world');
    });

    it('should remove loading indicators', () => {
      const response = '\u2B1D\u2B1D\u2B1D\u2B1D\u2B1D\nActual content';
      const cleaned = cleanOpenCodeResponse(response);
      expect(cleaned).toBe('Actual content');
    });

    it('should remove prompt patterns', () => {
      const response = 'Response text\nAsk anything...\ntab agents  ctrl+p commands';
      const cleaned = cleanOpenCodeResponse(response);
      expect(cleaned).toBe('Response text');
    });

    it('should remove processing indicators', () => {
      const response = 'esc interrupt\nActual content';
      const cleaned = cleanOpenCodeResponse(response);
      expect(cleaned).toBe('Actual content');
    });

    it('should preserve actual response content', () => {
      const response = 'Here is my answer to your question.\nIt has multiple lines.\nWith details.';
      const cleaned = cleanOpenCodeResponse(response);
      expect(cleaned).toBe(response);
    });

    it('should handle empty response', () => {
      expect(cleanOpenCodeResponse('')).toBe('');
    });

    it('should remove Build lines at start', () => {
      const response = 'Build something here\nActual content';
      const cleaned = cleanOpenCodeResponse(response);
      expect(cleaned).toBe('Actual content');
    });
  });

  describe('OpenCode pattern constants', () => {
    describe('OPENCODE_PROMPT_PATTERN', () => {
      it('should match "Ask anything..."', () => {
        expect(OPENCODE_PROMPT_PATTERN.test('Ask anything...')).toBe(true);
      });

      it('should not match other text', () => {
        expect(OPENCODE_PROMPT_PATTERN.test('Normal text')).toBe(false);
      });
    });

    describe('OPENCODE_PROMPT_AFTER_RESPONSE', () => {
      it('should match status bar pattern', () => {
        expect(OPENCODE_PROMPT_AFTER_RESPONSE.test('tab agents  ctrl+p commands')).toBe(true);
      });

      it('should match with variable whitespace', () => {
        expect(OPENCODE_PROMPT_AFTER_RESPONSE.test('tab agents   ctrl+p commands')).toBe(true);
      });
    });

    describe('OPENCODE_THINKING_PATTERN', () => {
      it('should match "Thinking:"', () => {
        expect(OPENCODE_THINKING_PATTERN.test('Thinking:')).toBe(true);
        expect(OPENCODE_THINKING_PATTERN.test('Thinking: analyzing code')).toBe(true);
      });

      it('should not match when not thinking', () => {
        expect(OPENCODE_THINKING_PATTERN.test('Normal response')).toBe(false);
      });
    });

    describe('OPENCODE_LOADING_PATTERN', () => {
      it('should match 4+ loading characters', () => {
        expect(OPENCODE_LOADING_PATTERN.test('\u2B1D\u2B1D\u2B1D\u2B1D')).toBe(true);
        expect(OPENCODE_LOADING_PATTERN.test('\u2B1D\u2B1D\u2B1D\u2B1D\u2B1D\u2B1D')).toBe(true);
      });

      it('should not match fewer than 4', () => {
        expect(OPENCODE_LOADING_PATTERN.test('\u2B1D\u2B1D\u2B1D')).toBe(false);
      });
    });

    describe('OPENCODE_RESPONSE_COMPLETE', () => {
      it('should match Build summary with model and timing', () => {
        expect(OPENCODE_RESPONSE_COMPLETE.test('\u25A3  Build \u00b7 qwen3:8b \u00b7 2.5s')).toBe(true);
      });

      it('should match Build with longer model name', () => {
        expect(OPENCODE_RESPONSE_COMPLETE.test('\u25A3  Build \u00b7 deepseek-coder-v2:16b \u00b7 45.2s')).toBe(true);
      });

      it('should not match without Build prefix', () => {
        expect(OPENCODE_RESPONSE_COMPLETE.test('Some other text')).toBe(false);
      });
    });

    describe('OPENCODE_PROCESSING_INDICATOR', () => {
      it('should match "esc interrupt"', () => {
        expect(OPENCODE_PROCESSING_INDICATOR.test('esc interrupt')).toBe(true);
      });
    });

    describe('OPENCODE_SKIP_PATTERNS', () => {
      it('should be a non-empty array', () => {
        expect(OPENCODE_SKIP_PATTERNS.length).toBeGreaterThan(0);
      });

      it('should contain separator, loading, Build, prompt, and processing patterns', () => {
        // Test that each expected pattern type is covered
        const testCases = [
          { input: '\u2503\u2503\u2503', description: 'separator' },
          { input: '\u2B1D\u2B1D\u2B1D\u2B1D', description: 'loading' },
          { input: 'Build something', description: 'Build line' },
          { input: 'tab agents  ctrl+p commands', description: 'prompt after response' },
          { input: 'esc interrupt', description: 'processing indicator' },
          { input: 'Ask anything...', description: 'prompt pattern' },
        ];

        for (const testCase of testCases) {
          const matched = OPENCODE_SKIP_PATTERNS.some(p => p.test(testCase.input));
          expect(matched).toBe(true);
        }
      });
    });
  });
});
