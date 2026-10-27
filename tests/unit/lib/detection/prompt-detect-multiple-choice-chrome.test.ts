/** @vitest-environment node */

/**
 * Issue #3924: Claude's chrome readers (task panel, session-diff HUD, preview
 * pane) live in prompt-detect-multiple-choice-chrome.ts. These tests import the
 * new module directly, and check that prompt-detect-multiple-choice.ts still
 * re-exports the very same functions.
 */

import { describe, expect, it } from 'vitest';

import * as original from '@/lib/detection/prompt-detect-multiple-choice';
import {
  SUMMARY_LINE_PATTERN,
  findClaudeChrome,
  findClaudeTaskPanelLines,
  maskClaudeChrome,
  type ClaudeChrome,
} from '@/lib/detection/prompt-detect-multiple-choice-chrome';

const PANEL_FRAME = [
  'Ready to submit your answers?',
  '❯ 1. Submit answers',
  '  2. Cancel',
  '',
  '  7 tasks (2 done, 1 in progress, 4 open)',
  '  ◼ Phase 3',
  '  ◻ Phase 4',
  '  … +2 completed',
  'after the panel',
];

describe('prompt-detect-multiple-choice-chrome (Issue #3924)', () => {
  it('is re-exported unchanged from prompt-detect-multiple-choice', () => {
    expect(original.findClaudeTaskPanelLines).toBe(findClaudeTaskPanelLines);
    expect(original.findClaudeChrome).toBe(findClaudeChrome);
    expect(original.maskClaudeChrome).toBe(maskClaudeChrome);
  });

  describe('findClaudeTaskPanelLines', () => {
    it('claims the task panel header and its rows, and stops at the first other row', () => {
      expect([...findClaudeTaskPanelLines(PANEL_FRAME, 0, PANEL_FRAME.length)]).toEqual([4, 5, 6, 7]);
    });

    it('claims the session-diff HUD row on its trimmed text', () => {
      const lines = ['❯ 1. Yes', '  2. No', `${' '.repeat(110)}+28 files edited before this session (show)`];
      expect([...findClaudeTaskPanelLines(lines, 0, lines.length)]).toEqual([2]);
      expect([...findClaudeTaskPanelLines(['No changes this session'], 0, 1)]).toEqual([0]);
    });

    it('leaves option rows and multi-select glyph rows alone', () => {
      const lines = ['  3 tasks (0 done, 0 in progress, 3 open)', '☐ 1. Blue', '☑ 2. Green'];
      expect([...findClaudeTaskPanelLines(lines, 0, lines.length)]).toEqual([0]);
      expect([...findClaudeTaskPanelLines(['❯ 1. Yes', '  2. No'], 0, 2)]).toEqual([]);
    });

    it('only looks inside [start, end)', () => {
      expect([...findClaudeTaskPanelLines(PANEL_FRAME, 0, 4)]).toEqual([]);
      expect([...findClaudeTaskPanelLines(PANEL_FRAME, 0, 6)]).toEqual([4, 5]);
    });
  });

  describe('SUMMARY_LINE_PATTERN', () => {
    it('matches collapsed summary rows but not labels mentioning the words mid-sentence', () => {
      expect(SUMMARY_LINE_PATTERN.test('  … +1 pending')).toBe(true);
      expect(SUMMARY_LINE_PATTERN.test('  ↑3 more')).toBe(true);
      expect(SUMMARY_LINE_PATTERN.test('  … +2 completed')).toBe(true);
      expect(SUMMARY_LINE_PATTERN.test('2. Postpone (will remain pending)')).toBe(false);
      expect(SUMMARY_LINE_PATTERN.test('3. Show me more')).toBe(false);
    });
  });

  describe('findClaudeChrome / maskClaudeChrome', () => {
    it('reads the panel rows as chrome with no pane cuts when no preview pane is drawn', () => {
      const chrome = findClaudeChrome(PANEL_FRAME, 0, PANEL_FRAME.length);
      expect([...chrome.rows]).toEqual([4, 5, 6, 7]);
      expect(chrome.cuts.size).toBe(0);
    });

    it('blanks chrome rows and cuts pane rows, keeping row indices', () => {
      const chrome: ClaudeChrome = { rows: new Set([1]), cuts: new Map([[2, 8]]) };
      expect(maskClaudeChrome(['keep', 'chrome', '1. Yes  │ preview'], chrome)).toEqual(['keep', '', '1. Yes']);
    });
  });
});
