/**
 * Unit tests for Copilot TUI Accumulator functions
 * Issue #565: Copilot-specific content extraction and normalization
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractCopilotContentLines,
  normalizeCopilotLine,
} from '@/lib/tui-accumulator';
import {
  initTuiAccumulator,
  accumulateTuiContent,
  getAccumulatedContent,
  clearTuiAccumulator,
} from '@/lib/polling/response-poller';

describe('Copilot TUI Accumulator', () => {
  describe('normalizeCopilotLine()', () => {
    it('should remove box-drawing characters', () => {
      const line = '\u2500\u2500\u2500 Content \u2502\u2502';
      const result = normalizeCopilotLine(line);
      expect(result).toBe('Content');
    });

    it('should normalize consecutive whitespace', () => {
      const line = 'Hello    World     Test';
      const result = normalizeCopilotLine(line);
      expect(result).toBe('Hello World Test');
    });

    it('should trim whitespace', () => {
      const line = '   Content   ';
      const result = normalizeCopilotLine(line);
      expect(result).toBe('Content');
    });

    it('should return empty string for box-drawing only lines', () => {
      const line = '\u2500\u2502\u2503\u250C\u2510';
      const result = normalizeCopilotLine(line);
      expect(result).toBe('');
    });

    it('should preserve normal text', () => {
      const line = 'This is a normal response line';
      const result = normalizeCopilotLine(line);
      expect(result).toBe('This is a normal response line');
    });
  });

  describe('extractCopilotContentLines()', () => {
    it('should extract plain content lines', () => {
      const raw = 'Line one\nLine two\nLine three';
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual(['Line one', 'Line two', 'Line three']);
    });

    it('should strip ANSI escape codes', () => {
      const raw = '\x1b[32mGreen text\x1b[0m\nNormal text';
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual(['Green text', 'Normal text']);
    });

    it('should remove empty lines', () => {
      const raw = 'Content\n\n  \n\nMore content';
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual(['Content', 'More content']);
    });

    it('should skip separator lines (COPILOT_SEPARATOR_PATTERN)', () => {
      const raw = '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nActual content';
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual(['Actual content']);
    });

    it('should skip thinking/spinner patterns (COPILOT_THINKING_PATTERN)', () => {
      // Braille spinner character
      const raw = '\u2801\u2802\u2804 Loading...\nActual content';
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual(['Actual content']);
    });

    it('should skip selection list patterns', () => {
      const raw = 'Search models...\nActual content\nSelect Model';
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual(['Actual content']);
    });

    it('should skip pasted text markers', () => {
      const raw = '[Pasted text #1 +10 lines]\nActual content';
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual(['Actual content']);
    });

    it('should return empty array for empty input', () => {
      expect(extractCopilotContentLines('')).toEqual([]);
    });

    it('should return empty array for all-skip content', () => {
      const raw = '───────────\n[Pasted text #1 +5 lines]';
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual([]);
    });

    it('should handle mixed content and artifacts', () => {
      const raw = [
        '───────────────',           // separator - skip
        'Here is the answer:',       // content - keep
        '',                           // empty - skip
        'The solution is X = 42.',   // content - keep
        'Search models...',          // selection list - skip
        'Thank you!',               // content - keep
      ].join('\n');
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual([
        'Here is the answer:',
        'The solution is X = 42.',
        'Thank you!',
      ]);
    });
  });

  describe('accumulateTuiContent with cliToolId=copilot', () => {
    const TEST_KEY = 'test-worktree:copilot';

    beforeEach(() => {
      clearTuiAccumulator(TEST_KEY);
    });

    it('should accumulate Copilot content correctly', () => {
      initTuiAccumulator(TEST_KEY);
      accumulateTuiContent(TEST_KEY, 'Line A\nLine B\nLine C', 'copilot');
      expect(getAccumulatedContent(TEST_KEY)).toBe('Line A\nLine B\nLine C');
    });

    it('should filter Copilot-specific artifacts during accumulation', () => {
      initTuiAccumulator(TEST_KEY);
      accumulateTuiContent(
        TEST_KEY,
        '───────────────\nHello world\nSearch models...',
        'copilot'
      );
      expect(getAccumulatedContent(TEST_KEY)).toBe('Hello world');
    });

    it('should detect overlap across multiple polls', () => {
      initTuiAccumulator(TEST_KEY);

      // First capture
      accumulateTuiContent(TEST_KEY, 'Line 1\nLine 2\nLine 3', 'copilot');
      expect(getAccumulatedContent(TEST_KEY)).toBe('Line 1\nLine 2\nLine 3');

      // Second capture with overlap at Line 2, Line 3
      accumulateTuiContent(TEST_KEY, 'Line 2\nLine 3\nLine 4\nLine 5', 'copilot');
      expect(getAccumulatedContent(TEST_KEY)).toBe('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
    });

    it('should not duplicate on same content', () => {
      initTuiAccumulator(TEST_KEY);

      accumulateTuiContent(TEST_KEY, 'A\nB\nC', 'copilot');
      accumulateTuiContent(TEST_KEY, 'A\nB\nC', 'copilot');

      expect(getAccumulatedContent(TEST_KEY)).toBe('A\nB\nC');
    });
  });
});
