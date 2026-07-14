/**
 * Unit tests for computeTerminalUpdate (Issue #1120).
 * Covers append, reset (replace), noop, and ANSI escape boundary handling.
 */

import { describe, it, expect } from 'vitest';
import { computeTerminalUpdate } from '@/lib/terminal/terminal-diff';

describe('computeTerminalUpdate', () => {
  it('returns noop when output is unchanged', () => {
    const result = computeTerminalUpdate('hello world', 'hello world');
    expect(result.mode).toBe('noop');
    expect(result.appended).toBe('');
    expect(result.text).toBe('hello world');
  });

  it('appends the new suffix when next extends prev', () => {
    const result = computeTerminalUpdate('line 1\n', 'line 1\nline 2\n');
    expect(result.mode).toBe('append');
    expect(result.appended).toBe('line 2\n');
    expect(result.retainedLength).toBe('line 1\n'.length);
    expect(result.text).toBe('line 1\nline 2\n');
  });

  it('replaces when prev is empty (initial render)', () => {
    const result = computeTerminalUpdate('', 'first output');
    expect(result.mode).toBe('replace');
    expect(result.appended).toBe('');
  });

  it('replaces when next is shorter (scrollback truncation)', () => {
    const result = computeTerminalUpdate('aaaa\nbbbb\ncccc', 'bbbb\ncccc');
    expect(result.mode).toBe('replace');
  });

  it('replaces when the content diverges (screen clear / redraw)', () => {
    const result = computeTerminalUpdate('old screen', 'new screen entirely');
    expect(result.mode).toBe('replace');
  });

  it('replaces when the prefix changes even if longer', () => {
    const result = computeTerminalUpdate('abcdef', 'Xbcdefghi');
    expect(result.mode).toBe('replace');
  });

  describe('ANSI escape boundary', () => {
    it('backs the split up before an incomplete CSI at the boundary', () => {
      const prev = 'text \x1b[';
      const next = 'text \x1b[31mred';
      const result = computeTerminalUpdate(prev, next);
      expect(result.mode).toBe('append');
      // The appended suffix must carry the full, well-formed escape sequence.
      expect(result.appended).toBe('\x1b[31mred');
      expect(result.retainedLength).toBe('text '.length);
    });

    it('backs the split up before a bare ESC at the boundary', () => {
      const prev = 'hello\x1b';
      const next = 'hello\x1b[1mBOLD';
      const result = computeTerminalUpdate(prev, next);
      expect(result.mode).toBe('append');
      expect(result.appended).toBe('\x1b[1mBOLD');
      expect(result.retainedLength).toBe('hello'.length);
    });

    it('treats a complete escape at the boundary as a clean append', () => {
      const prev = 'a\x1b[31m';
      const next = 'a\x1b[31mred';
      const result = computeTerminalUpdate(prev, next);
      expect(result.mode).toBe('append');
      expect(result.appended).toBe('red');
      expect(result.retainedLength).toBe(prev.length);
    });

    it('handles multi-parameter SGR sequences spanning the boundary', () => {
      const prev = 'x\x1b[1;32';
      const next = 'x\x1b[1;32mgreen-bold';
      const result = computeTerminalUpdate(prev, next);
      expect(result.mode).toBe('append');
      expect(result.appended).toBe('\x1b[1;32mgreen-bold');
    });
  });
});
