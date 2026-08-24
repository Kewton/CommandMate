import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripAnsi, extractAnsiSequences, ANSI_PATTERN } from '@/lib/detection/ansi';

/**
 * Issue #1912 item 1: OSC 8 hyperlinks survived `stripAnsi`.
 *
 * `ANSI_PATTERN` only knew the BEL-terminated OSC form (`ESC ] ... BEL`), but
 * every CLI we drive emits the ST-terminated form (`ESC ] ... ESC \`). The whole
 * sequence therefore leaked into saved responses, the terminal view and every
 * detection input.
 */
describe('Issue #1912: stripAnsi removes OSC 8 hyperlinks', () => {
  const ESC = '\x1b';
  const ST = `${ESC}\\`;
  const BEL = '\x07';

  it('removes the copilot /model hyperlink reported in the issue', () => {
    const input =
      'Auto routes based on ' +
      `${ESC}]8;id=md-1ub4yfi;https://docs.github.com/en/copilot${ST}` +
      'Learn More' +
      `${ESC}]8;;${ST}`;

    expect(stripAnsi(input)).toBe('Auto routes based on Learn More');
  });

  it('still removes the BEL-terminated OSC form (window title)', () => {
    expect(stripAnsi(`${ESC}]0;my-window${BEL}after`)).toBe('after');
  });

  it('does not swallow visible text between an ST-terminated OSC and a later BEL', () => {
    // Regression guard for the old `[^\x07]*` payload class: with a BEL anywhere
    // later in the buffer it matched across the ST and ate the link label.
    const input =
      `${ESC}]8;;https://example.com${ST}` +
      'Learn More' +
      `${ESC}]8;;${ST}` +
      ` tail${BEL}`;

    expect(stripAnsi(input)).toBe(`Learn More tail${BEL}`);
  });

  it('leaves a lone ESC ] with no terminator alone rather than eating the rest', () => {
    expect(stripAnsi(`${ESC}]8;id=x;https://example.com no-terminator`)).toBe(
      `${ESC}]8;id=x;https://example.com no-terminator`,
    );
  });

  it('keeps SGR handling intact alongside the hyperlink', () => {
    const input = `${ESC}[31m${ESC}]8;;https://example.com${ST}Red link${ESC}]8;;${ST}${ESC}[0m`;
    expect(stripAnsi(input)).toBe('Red link');
  });

  it('extractAnsiSequences keeps the OSC 8 pair it now recognises', () => {
    const input = `${ESC}]8;;https://example.com${ST}Label${ESC}]8;;${ST}`;
    expect(extractAnsiSequences(input)).toBe(
      `${ESC}]8;;https://example.com${ST}${ESC}]8;;${ST}`,
    );
  });

  it('clears lastIndex between calls so the global pattern stays reusable', () => {
    ANSI_PATTERN.lastIndex = 0;
    const first = stripAnsi(`${ESC}]8;;https://a${ST}A${ESC}]8;;${ST}`);
    const second = stripAnsi(`${ESC}]8;;https://b${ST}B${ESC}]8;;${ST}`);
    expect([first, second]).toEqual(['A', 'B']);
  });

  it('strips the OSC 8 rows out of the live copilot and claude fixtures', () => {
    const cases: Array<[string, string]> = [
      [
        join(
          __dirname,
          'fixtures/copilot-live-1885/boot-idle.txt',
        ),
        'copilot',
      ],
      [
        join(
          __dirname,
          'fixtures/claude-live-1879/composer-empty.txt',
        ),
        'claude',
      ],
      [
        join(
          __dirname,
          'fixtures/codex-live-1890/composer-placeholder-ask.txt',
        ),
        'codex',
      ],
    ];

    for (const [path, label] of cases) {
      const raw = readFileSync(path, 'utf-8');
      expect(raw, `${label} fixture lost its OSC 8 sequence`).toContain(`${ESC}]8;`);
      expect(stripAnsi(raw), `${label} still leaks OSC 8`).not.toContain(`${ESC}]8;`);
      expect(stripAnsi(raw), `${label} still leaks a bare ESC`).not.toContain(ESC);
    }
  });
});
