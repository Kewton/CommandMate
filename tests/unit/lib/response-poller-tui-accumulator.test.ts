/**
 * Unit tests for TUI Response Accumulator (Layer 2: Polling Accumulation)
 * Issue #379: Captures OpenCode TUI responses that exceed visible pane height
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractTuiContentLines,
  findOverlapIndex,
  initTuiAccumulator,
  accumulateTuiContent,
  getAccumulatedContent,
  clearTuiAccumulator,
} from '@/lib/response-poller';

describe('TUI Response Accumulator', () => {
  const TEST_KEY = 'test-worktree:opencode';

  beforeEach(() => {
    clearTuiAccumulator(TEST_KEY);
  });

  describe('extractTuiContentLines()', () => {
    it('should extract plain content lines', () => {
      const raw = 'Line one\nLine two\nLine three';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual(['Line one', 'Line two', 'Line three']);
    });

    it('should strip ANSI escape codes', () => {
      const raw = '\x1b[32mGreen text\x1b[0m\nNormal text';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual(['Green text', 'Normal text']);
    });

    it('should remove empty lines', () => {
      const raw = 'Content\n\n  \n\nMore content';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual(['Content', 'More content']);
    });

    it('should skip OpenCode TUI separator lines', () => {
      const raw = '\u2503\u2503\u2503\nActual content\n\u2500\u2500\u2500';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual(['Actual content']);
    });

    it('should skip loading indicators', () => {
      const raw = '\u2B1D\u2B1D\u2B1D\u2B1D\u2B1D\nContent after loading';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual(['Content after loading']);
    });

    it('should skip Build summary line', () => {
      const raw = 'Response text\n\u25A3  Build \u00b7 qwen3:8b \u00b7 2.5s';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual(['Response text']);
    });

    it('should skip prompt patterns', () => {
      const raw = 'Content\nAsk anything...\ntab agents  ctrl+p commands';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual(['Content']);
    });

    it('should skip processing indicators', () => {
      const raw = 'esc interrupt\nActual content';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual(['Actual content']);
    });

    it('should return empty array for empty input', () => {
      expect(extractTuiContentLines('')).toEqual([]);
    });

    it('should return empty array for TUI-only content', () => {
      const raw = '\u2503\u2503\u2503\nAsk anything...\n\u2B1D\u2B1D\u2B1D\u2B1D';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual([]);
    });

    it('should strip box-drawing characters from content', () => {
      // stripBoxDrawing removes │ prefix/suffix
      const raw = '\u2502 Content inside border \u2502';
      const result = extractTuiContentLines(raw);
      expect(result).toEqual(['Content inside border']);
    });
  });

  describe('findOverlapIndex()', () => {
    it('should find full overlap', () => {
      const previous = ['A', 'B', 'C'];
      const current = ['A', 'B', 'C', 'D', 'E'];
      expect(findOverlapIndex(previous, current)).toBe(3);
    });

    it('should find partial overlap at tail', () => {
      const previous = ['A', 'B', 'C', 'D', 'E'];
      const current = ['D', 'E', 'F', 'G', 'H'];
      expect(findOverlapIndex(previous, current)).toBe(2);
    });

    it('should find single line overlap', () => {
      const previous = ['A', 'B', 'C'];
      const current = ['C', 'D', 'E'];
      expect(findOverlapIndex(previous, current)).toBe(1);
    });

    it('should return 0 for no overlap', () => {
      const previous = ['A', 'B', 'C'];
      const current = ['X', 'Y', 'Z'];
      expect(findOverlapIndex(previous, current)).toBe(0);
    });

    it('should return 0 for empty previous', () => {
      expect(findOverlapIndex([], ['A', 'B'])).toBe(0);
    });

    it('should return 0 for empty current', () => {
      expect(findOverlapIndex(['A', 'B'], [])).toBe(0);
    });

    it('should return 0 for both empty', () => {
      expect(findOverlapIndex([], [])).toBe(0);
    });

    it('should handle complete overlap (same content)', () => {
      const lines = ['A', 'B', 'C'];
      expect(findOverlapIndex(lines, lines)).toBe(3);
    });

    it('should prefer longest overlap', () => {
      // previous ends with ['B', 'C', 'D'], current starts with ['B', 'C', 'D']
      const previous = ['A', 'B', 'C', 'D'];
      const current = ['B', 'C', 'D', 'E', 'F'];
      expect(findOverlapIndex(previous, current)).toBe(3);
    });
  });

  describe('Accumulation lifecycle', () => {
    it('should return empty string before initialization', () => {
      expect(getAccumulatedContent(TEST_KEY)).toBe('');
    });

    it('should return empty string after initialization', () => {
      initTuiAccumulator(TEST_KEY);
      expect(getAccumulatedContent(TEST_KEY)).toBe('');
    });

    it('should seed content on first accumulation', () => {
      initTuiAccumulator(TEST_KEY);
      accumulateTuiContent(TEST_KEY, 'Line A\nLine B\nLine C');
      expect(getAccumulatedContent(TEST_KEY)).toBe('Line A\nLine B\nLine C');
    });

    it('should append new lines on subsequent accumulation with overlap', () => {
      initTuiAccumulator(TEST_KEY);

      // First capture: A, B, C, D, E
      accumulateTuiContent(TEST_KEY, 'A\nB\nC\nD\nE');
      expect(getAccumulatedContent(TEST_KEY)).toBe('A\nB\nC\nD\nE');

      // Second capture: D, E, F, G, H (overlap = D, E)
      accumulateTuiContent(TEST_KEY, 'D\nE\nF\nG\nH');
      expect(getAccumulatedContent(TEST_KEY)).toBe('A\nB\nC\nD\nE\nF\nG\nH');
    });

    it('should append all lines when no overlap found', () => {
      initTuiAccumulator(TEST_KEY);

      accumulateTuiContent(TEST_KEY, 'A\nB\nC');
      accumulateTuiContent(TEST_KEY, 'X\nY\nZ');

      // No overlap → all of second capture appended
      expect(getAccumulatedContent(TEST_KEY)).toBe('A\nB\nC\nX\nY\nZ');
    });

    it('should not duplicate on same content', () => {
      initTuiAccumulator(TEST_KEY);

      accumulateTuiContent(TEST_KEY, 'A\nB\nC');
      accumulateTuiContent(TEST_KEY, 'A\nB\nC');

      // Full overlap → no new lines added
      expect(getAccumulatedContent(TEST_KEY)).toBe('A\nB\nC');
    });

    it('should handle empty captures gracefully', () => {
      initTuiAccumulator(TEST_KEY);

      accumulateTuiContent(TEST_KEY, 'A\nB\nC');
      accumulateTuiContent(TEST_KEY, '');

      expect(getAccumulatedContent(TEST_KEY)).toBe('A\nB\nC');
    });

    it('should clear accumulator', () => {
      initTuiAccumulator(TEST_KEY);
      accumulateTuiContent(TEST_KEY, 'A\nB\nC');

      clearTuiAccumulator(TEST_KEY);
      expect(getAccumulatedContent(TEST_KEY)).toBe('');
    });

    it('should handle TUI-only content (no meaningful lines)', () => {
      initTuiAccumulator(TEST_KEY);

      // Only TUI decorations — extractTuiContentLines returns empty
      accumulateTuiContent(TEST_KEY, '\u2503\u2503\u2503\nAsk anything...');
      expect(getAccumulatedContent(TEST_KEY)).toBe('');
    });

    it('should filter TUI artifacts during accumulation', () => {
      initTuiAccumulator(TEST_KEY);

      // First: content mixed with TUI artifacts
      accumulateTuiContent(TEST_KEY, '\u2503\u2503\nHello world\nesc interrupt');
      expect(getAccumulatedContent(TEST_KEY)).toBe('Hello world');

      // Second: more content with Build summary
      accumulateTuiContent(
        TEST_KEY,
        'Hello world\nSecond paragraph\n\u25A3  Build \u00b7 qwen3:8b \u00b7 2.5s'
      );
      expect(getAccumulatedContent(TEST_KEY)).toBe('Hello world\nSecond paragraph');
    });

    it('should handle multi-poll long response scenario', () => {
      initTuiAccumulator(TEST_KEY);

      // Simulate 3 polls with scrolling content
      // Poll 1: lines 1-5
      accumulateTuiContent(TEST_KEY, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

      // Poll 2: lines 3-8 (overlap at lines 3-5)
      accumulateTuiContent(TEST_KEY, 'Line 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8');

      // Poll 3: lines 7-10 (overlap at lines 7-8)
      accumulateTuiContent(TEST_KEY, 'Line 7\nLine 8\nLine 9\nLine 10');

      expect(getAccumulatedContent(TEST_KEY)).toBe(
        'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10'
      );
    });

    it('should not accumulate without initialization', () => {
      // No initTuiAccumulator call
      accumulateTuiContent(TEST_KEY, 'Content');
      expect(getAccumulatedContent(TEST_KEY)).toBe('');
    });
  });
});
