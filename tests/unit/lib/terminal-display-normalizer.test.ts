/**
 * Unit tests for normalizeTerminalOutputForDisplay (Issue #1172).
 */

import { describe, it, expect } from 'vitest';
import { normalizeTerminalOutputForDisplay } from '@/lib/terminal/terminal-display-normalizer';
import { stripAnsi } from '@/lib/detection/ansi';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';
import { buildCodex1000RowApprovalFrame } from '../../fixtures/codex-1000-row-approval';

const lineCount = (s: string) => (s === '' ? 0 : s.split('\n').length);

describe('normalizeTerminalOutputForDisplay', () => {
  describe('trivial inputs', () => {
    it('returns "" for empty string', () => {
      expect(normalizeTerminalOutputForDisplay('')).toBe('');
    });

    it('returns a single non-blank line unchanged', () => {
      expect(normalizeTerminalOutputForDisplay('hello')).toBe('hello');
    });

    it('collapses an all-blank input to ""', () => {
      expect(normalizeTerminalOutputForDisplay('\n\n\n\n\n')).toBe('');
    });

    it('treats whitespace-only lines as blank', () => {
      expect(normalizeTerminalOutputForDisplay('   \n\t\n  ')).toBe('');
    });
  });

  describe('leading / trailing trim', () => {
    it('removes leading blank lines', () => {
      expect(normalizeTerminalOutputForDisplay('\n\n\ncontent')).toBe('content');
    });

    it('removes trailing blank lines', () => {
      expect(normalizeTerminalOutputForDisplay('content\n\n\n')).toBe('content');
    });

    it('removes both leading and trailing blank lines', () => {
      expect(normalizeTerminalOutputForDisplay('\n\n\nA\nB\n\n\n')).toBe('A\nB');
    });
  });

  describe('internal blank runs', () => {
    it('keeps an internal single blank line', () => {
      expect(normalizeTerminalOutputForDisplay('A\n\nB')).toBe('A\n\nB');
    });

    it('keeps an internal 2-blank run verbatim', () => {
      expect(normalizeTerminalOutputForDisplay('A\n\n\nB')).toBe('A\n\n\nB');
    });

    it('collapses an internal 3-blank run to exactly one blank line', () => {
      expect(normalizeTerminalOutputForDisplay('A\n\n\n\nB')).toBe('A\n\nB');
    });

    it('collapses a large internal blank run (942) to one blank line', () => {
      const input = ['A', ...Array<string>(942).fill(''), 'B'].join('\n');
      const out = normalizeTerminalOutputForDisplay(input);
      expect(out).toBe('A\n\nB');
      expect(lineCount(out)).toBe(3);
    });

    it('handles multiple independent internal runs', () => {
      expect(normalizeTerminalOutputForDisplay('A\n\n\n\nB\n\nC\n\n\n\n\nD')).toBe(
        'A\n\nB\n\nC\n\nD',
      );
    });
  });

  describe('non-blank content preservation', () => {
    it('never removes or reorders non-blank lines', () => {
      const input = 'z\ny\nx\nz\ny\nx';
      expect(normalizeTerminalOutputForDisplay(input)).toBe(input);
    });

    it('preserves duplicate non-blank lines', () => {
      const input = 'same\nsame\nsame';
      expect(normalizeTerminalOutputForDisplay(input)).toBe(input);
    });

    it('keeps 1000 dense non-blank lines intact', () => {
      const input = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n');
      const out = normalizeTerminalOutputForDisplay(input);
      expect(out).toBe(input);
      expect(lineCount(out)).toBe(1000);
    });
  });

  describe('ANSI handling', () => {
    it('classifies ANSI-only lines as blank', () => {
      expect(normalizeTerminalOutputForDisplay('A\n\x1b[31m\n\x1b[0m\n\x1b[32m\nB')).not.toContain(
        'placeholder',
      );
    });

    it('preserves color/reset sequences that span a collapsed run', () => {
      // Red is opened on a blank row, content follows after 3+ blank rows.
      const input = ['A', '\x1b[31m', '', '', '', 'B'].join('\n');
      const out = normalizeTerminalOutputForDisplay(input);
      // Collapsed to A, one blank row carrying \x1b[31m, then B.
      expect(out).toBe('A\n\x1b[31m\nB');
      // The color sequence survives so B still renders red.
      expect(out).toContain('\x1b[31m');
    });

    it('preserves both start and reset sequences inside a collapsed run', () => {
      const input = ['A', '\x1b[31m', '', '', '\x1b[0m', 'B'].join('\n');
      const out = normalizeTerminalOutputForDisplay(input);
      expect(out).toBe('A\n\x1b[31m\x1b[0m\nB');
    });

    it('the collapsed ANSI row is still visually blank', () => {
      const input = ['A', '\x1b[31m', '', '', '\x1b[0m', 'B'].join('\n');
      const out = normalizeTerminalOutputForDisplay(input);
      const collapsedRow = out.split('\n')[1];
      expect(stripAnsi(collapsedRow).trim()).toBe('');
    });
  });

  describe('idempotency', () => {
    const cases = [
      '',
      'A',
      '\n\n\n',
      '\n\n\nA\nB\n\n\n',
      'A\n\n\n\nB',
      ['A', ...Array<string>(942).fill(''), 'B'].join('\n'),
      ['A', '\x1b[31m', '', '', '\x1b[0m', 'B'].join('\n'),
      buildClaude1000RowPermissionFrame(),
      buildCodex1000RowApprovalFrame(),
    ];

    it.each(cases.map((c, i) => [i, c] as const))('is idempotent for case %i', (_i, input) => {
      const once = normalizeTerminalOutputForDisplay(input);
      expect(normalizeTerminalOutputForDisplay(once)).toBe(once);
    });
  });

  describe('Claude 1000-row fixture', () => {
    it('keeps raw at 1000 lines but renders 14 display lines', () => {
      const raw = buildClaude1000RowPermissionFrame();
      expect(lineCount(raw)).toBe(1000);

      const display = normalizeTerminalOutputForDisplay(raw);
      expect(lineCount(display)).toBe(14);

      // The prompt and the task panel both survive the collapse.
      expect(display).toContain('Do you want to make this edit to useVirtualKeyboard.ts?');
      expect(display).toContain('Esc to cancel · Tab to amend');
      expect(display).toContain('6 tasks (0 done, 1 in progress, 5 open)');
      expect(display).toContain('… +1 pending');
    });
  });

  describe('Codex 1000-row fixture', () => {
    it('collapses the layout gap while preserving the approval prompt and footer', () => {
      const raw = buildCodex1000RowApprovalFrame();
      expect(lineCount(raw)).toBe(1000);

      const display = normalizeTerminalOutputForDisplay(raw);
      expect(lineCount(display)).toBeLessThan(50);
      expect(display).toContain('Allow command to run?');
      expect(display).toContain('token usage:');
    });
  });
});
