import { describe, expect, it } from 'vitest';
import { TmuxControlParser } from '@/lib/tmux-control-parser';

describe('TmuxControlParser', () => {
  it('should parse output lines', () => {
    const parser = new TmuxControlParser();
    expect(parser.push('%output hello\n')).toEqual([
      { type: 'output', data: 'hello\n' },
    ]);
  });

  it('should parse exit lines', () => {
    const parser = new TmuxControlParser();
    expect(parser.push('%exit\n')).toEqual([
      { type: 'exit', exitCode: null },
    ]);
  });

  it('should buffer partial chunks until newline', () => {
    const parser = new TmuxControlParser();
    expect(parser.push('%output hel')).toEqual([]);
    expect(parser.push('lo\n')).toEqual([
      { type: 'output', data: 'hello\n' },
    ]);
  });

  it('should ignore unknown control messages', () => {
    const parser = new TmuxControlParser();
    expect(parser.push('%begin 1\n%end 1\n')).toEqual([]);
  });
});
