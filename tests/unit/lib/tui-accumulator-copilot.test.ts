/**
 * Unit tests for Copilot TUI Accumulator functions
 * Issue #565: Copilot-specific content extraction and normalization
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
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

/**
 * A live copilot 1.0.80 frame, raw. See
 * the README.md in each `tests/unit/lib/detection/fixtures/` set for provenance.
 */
function liveFrame(dir: string, name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, 'detection/fixtures', dir, `${name}.txt`),
    'utf-8',
  );
}

/**
 * The picker key-hint footer copilot 1.0.80 actually draws, verbatim. The
 * spelling this file used to pin (`Search models...`, `Select Model`) is not
 * chrome on any version measured for Issue #1895 — the live `/model` picker
 * renders `❯  Search models…` with U+2026, and no picker prints `Select Model`.
 * The ASCII spelling occurs exactly once in the whole fixture corpus, in
 * `picker-vocabulary-in-response.txt`, where it is copilot's own PROSE.
 *
 * In the synthetic frames below this row is always kept at least four non-blank
 * rows above the bottom, so that what they exercise is the per-line skip. A
 * footer INSIDE the last three rows makes the whole frame a picker
 * (`isCopilotSelectionFrame`), which is a different code path with its own tests.
 */
const PICKER_FOOTER = '↑/↓ to navigate · enter to select · esc to cancel';

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

    it('should skip a stray picker footer row (Issue #1895)', () => {
      // Line level: a key-hint bar that is NOT at the bottom of the pane is
      // still chrome, and `COPILOT_SELECTION_FOOTER_PATTERN` (in
      // `COPILOT_SKIP_PATTERNS`) drops it. Kept away from the last three rows on
      // purpose so this exercises the per-line path rather than the frame-level
      // one below.
      const raw = [PICKER_FOOTER, 'Actual content', 'Second line', 'Third line'].join('\n');
      const result = extractCopilotContentLines(raw);
      expect(result).toEqual(['Actual content', 'Second line', 'Third line']);
    });

    it('should contribute nothing from a live picker frame (Issue #1895)', () => {
      // Frame level. The poller feeds this function the WHOLE pane every tick,
      // so an operator reading an open `/model` picker used to get ~50 rows of
      // model names appended to the saved response once per poll — `Recommended
      // models` and `GPT-5.6 Luna 328K Medium` are not separable from prose by
      // any line pattern. A picker frame carries no response content at all.
      expect(extractCopilotContentLines(liveFrame('copilot-live-1885', 'model-picker'))).toEqual([]);
      for (const name of ['picker-theme', 'picker-agent', 'picker-skills', 'picker-subagents']) {
        expect(
          extractCopilotContentLines(liveFrame('copilot-picker-1895', name)),
          `${name} leaked chrome into the accumulator`,
        ).toEqual([]);
      }
    });

    it('should keep prose that merely mentions the picker (Issue #1895)', () => {
      // The regression this file used to encode. `Search models...` and
      // `Select Model` are words copilot writes in its ANSWERS; skipping them
      // deleted sentences from the saved response. The live frame is
      // `copilot-picker-1895/picker-vocabulary-in-response.txt`, where copilot
      // was asked to print exactly this vocabulary.
      const raw = 'Use /model. It opens the Select Model dialog.\nThen type into the Search models... field.\nDone.';
      expect(extractCopilotContentLines(raw)).toEqual([
        'Use /model. It opens the Select Model dialog.',
        'Then type into the Search models... field.',
        'Done.',
      ]);

      const live = extractCopilotContentLines(
        liveFrame('copilot-picker-1895', 'picker-vocabulary-in-response'),
      );
      expect(live).toContain('● Use /model. It opens the Select Model dialog.');
      expect(live).toContain('Then type into the Search models... field.');
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
        PICKER_FOOTER,               // picker chrome - skip (Issue #1895)
        'Here is the answer:',       // content - keep
        '',                           // empty - skip
        'The solution is X = 42.',   // content - keep
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
        ['───────────────', PICKER_FOOTER, 'Hello world', 'Still here', 'And here'].join('\n'),
        'copilot'
      );
      expect(getAccumulatedContent(TEST_KEY)).toBe('Hello world\nStill here\nAnd here');
    });

    it('should not append the model list when the operator opens a picker (Issue #1895)', () => {
      // The poller ticks while a picker is up. Every tick used to append the
      // whole list, so a minute spent reading `/model` buried the response.
      initTuiAccumulator(TEST_KEY);
      accumulateTuiContent(TEST_KEY, 'Here is the answer.', 'copilot');

      const picker = liveFrame('copilot-live-1885', 'model-picker');
      accumulateTuiContent(TEST_KEY, picker, 'copilot');
      accumulateTuiContent(TEST_KEY, picker, 'copilot');

      const accumulated = getAccumulatedContent(TEST_KEY);
      expect(accumulated).toBe('Here is the answer.');
      expect(accumulated).not.toContain('Recommended models');
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
