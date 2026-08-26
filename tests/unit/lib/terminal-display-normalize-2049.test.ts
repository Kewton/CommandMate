/**
 * Issue #2049: panel-aware display compaction for opencode terminal panes.
 *
 * The subject is `src/lib/terminal-display-normalize.ts`. Two things have to
 * hold at once and they pull in opposite directions:
 *
 *  1. **the compaction rule must not fork.** Issue #1172's
 *     `normalizeTerminalOutputForDisplay` is the tested rule for claude/codex,
 *     and #2049 must not become a second, subtly different one. The first
 *     describe below runs the new engine with no structural predicate over a
 *     corpus of real live captures and asserts it is byte-identical to #1172's.
 *  2. **opencode's painted panel rows must survive.** They are visually blank —
 *     `stripAnsi(row).trim() === ''` — so #1172's rule folds them into the
 *     surrounding padding run and the `ctrl+p` palette loses its top band and
 *     its section separators.
 *
 * Both bucket boundaries below were measured, not assumed; see
 * `docs/design/opencode-server-live-verification.md` §19.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { stripAnsi } from '@/lib/detection/ansi';
import { normalizeTerminalOutputForDisplay } from '@/lib/terminal/terminal-display-normalizer';
import {
  compactBlankRuns,
  isPaintedPanelRow,
  normalizeOpencodeTerminalOutputForDisplay,
} from '@/lib/terminal-display-normalize';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Every real opencode capture in the repo, plus the 1.18.22 ones from #2049. */
function liveCaptures(): Array<{ name: string; text: string }> {
  const dirs = [
    ...fs
      .readdirSync(path.join(REPO_ROOT, 'tests/unit/lib/detection/fixtures'))
      .filter((d) => d.startsWith('opencode-live-'))
      .map((d) => path.join(REPO_ROOT, 'tests/unit/lib/detection/fixtures', d)),
    path.join(REPO_ROOT, 'tests/fixtures/opencode-live-2049'),
  ];
  const out: Array<{ name: string; text: string }> = [];
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.txt'))) {
      out.push({
        name: `${path.basename(dir)}/${file}`,
        text: fs.readFileSync(path.join(dir, file), 'utf-8'),
      });
    }
  }
  return out;
}

/** Synthetic edge cases the live corpus does not happen to contain. */
const SYNTHETIC: Array<[string, string]> = [
  ['empty', ''],
  ['single line', 'hello'],
  ['all blank', '\n\n\n\n\n'],
  ['whitespace only', '   \n\t\n  '],
  ['leading run', '\n\n\nA\nB'],
  ['trailing run', 'A\nB\n\n\n'],
  ['run of 1', 'A\n\nB'],
  ['run of 2', 'A\n\n\nB'],
  ['run of 3', 'A\n\n\n\nB'],
  ['ansi-only rows', 'A\n\x1b[31m\n\x1b[0m\n\x1b[32m\nB'],
  ['no trailing newline', 'A\n\n\n\n\nB'],
];

const CAPTURES = liveCaptures();

describe('Issue #2049: the engine does not fork the Issue #1172 rule', () => {
  it('has a non-empty live corpus to compare against', () => {
    expect(CAPTURES.length).toBeGreaterThanOrEqual(20);
  });

  it.each(SYNTHETIC)(
    'compactBlankRuns with no predicate === normalizeTerminalOutputForDisplay (%s)',
    (_name, input) => {
      expect(compactBlankRuns(input)).toBe(normalizeTerminalOutputForDisplay(input));
    },
  );

  it('compactBlankRuns with no predicate === normalizeTerminalOutputForDisplay on every live capture', () => {
    for (const { name, text } of CAPTURES) {
      expect(compactBlankRuns(text), name).toBe(normalizeTerminalOutputForDisplay(text));
    }
  });
});

describe('Issue #2049: isPaintedPanelRow', () => {
  /** A real opencode palette band row: 70 painted columns, no glyphs. */
  const PANEL_ROW = `\x1b[48;2;20;20;20m${' '.repeat(70)}\x1b[48;2;4;4;4m`;

  it('accepts a background-painted row of spaces', () => {
    expect(isPaintedPanelRow(PANEL_ROW)).toBe(true);
  });

  it('rejects the frame colour-init row, which paints no columns', () => {
    // Exactly one of these opens every opencode frame. It sets the frame's fg/bg
    // but occupies zero columns, so it is layout, not a panel.
    expect(isPaintedPanelRow('\x1b[38;2;255;255;255m\x1b[48;2;4;4;4m')).toBe(false);
  });

  it('rejects a truly empty row and an unstyled run of spaces', () => {
    expect(isPaintedPanelRow('')).toBe(false);
    expect(isPaintedPanelRow(' '.repeat(70))).toBe(false);
  });

  it('does not mistake a 256-colour FOREGROUND parameter for a background', () => {
    // `38;5;44` selects foreground palette colour 44. A naive "is any parameter
    // in 40..47" scan reads that 44 as "background green" and would protect
    // every padding row a foreground colour happens to span.
    expect(isPaintedPanelRow(`\x1b[38;5;44m${' '.repeat(70)}`)).toBe(false);
    expect(isPaintedPanelRow(`\x1b[38;2;40;41;42m${' '.repeat(70)}`)).toBe(false);
  });

  it('rejects a bare background RESET (49), which un-paints rather than paints', () => {
    expect(isPaintedPanelRow(`\x1b[49m${' '.repeat(70)}`)).toBe(false);
  });

  it('accepts the legacy 4-bit and bright background forms', () => {
    expect(isPaintedPanelRow(`\x1b[42m${' '.repeat(10)}`)).toBe(true);
    expect(isPaintedPanelRow(`\x1b[104m${' '.repeat(10)}`)).toBe(true);
  });
});

describe('Issue #2049: painted panel rows survive compaction', () => {
  const PANEL = (cols = 70) => `\x1b[48;2;20;20;20m${' '.repeat(cols)}\x1b[48;2;4;4;4m`;

  it('keeps a panel band that sits at the edge of a long padding run', () => {
    // The exact shape of the measured `ctrl+p` frame: transcript, ~49 rows of
    // padding, then the panel's top band immediately before its first text row.
    const raw = [
      'transcript row',
      ...Array<string>(49).fill(''),
      PANEL(),
      '              Commands                                         esc    ',
      PANEL(),
      '              Search                                                  ',
      ...Array<string>(90).fill(''),
      '  ┃  composer                                                        ',
    ].join('\n');

    const compacted = normalizeOpencodeTerminalOutputForDisplay(raw);
    const rows = compacted.split('\n');

    expect(rows.filter(isPaintedPanelRow)).toHaveLength(2);
    expect(rows).toContain(PANEL());
    // …and the padding around it is still gone.
    expect(rows.length).toBeLessThan(12);
  });

  it('is what separates the new rule from the Issue #1172 one', () => {
    const raw = ['A', ...Array<string>(10).fill(''), PANEL(), 'B'].join('\n');
    expect(
      normalizeTerminalOutputForDisplay(raw).split('\n').filter(isPaintedPanelRow),
    ).toHaveLength(0);
    expect(
      normalizeOpencodeTerminalOutputForDisplay(raw).split('\n').filter(isPaintedPanelRow),
    ).toHaveLength(1);
  });

  it('splits the surrounding run rather than absorbing it', () => {
    // padding(4) PANEL padding(4): each side collapses independently, so the
    // panel row keeps a blank row on either side instead of being swallowed.
    const raw = [
      'A',
      ...Array<string>(4).fill(''),
      PANEL(),
      ...Array<string>(4).fill(''),
      'B',
    ].join('\n');
    expect(normalizeOpencodeTerminalOutputForDisplay(raw).split('\n')).toEqual([
      'A',
      '',
      PANEL(),
      '',
      'B',
    ]);
  });

  it('lets a panel row stop a leading / trailing trim', () => {
    const leading = [...Array<string>(5).fill(''), PANEL(), 'A'].join('\n');
    expect(normalizeOpencodeTerminalOutputForDisplay(leading).split('\n')).toEqual([
      PANEL(),
      'A',
    ]);
    const trailing = ['A', PANEL(), ...Array<string>(5).fill('')].join('\n');
    expect(normalizeOpencodeTerminalOutputForDisplay(trailing).split('\n')).toEqual([
      'A',
      PANEL(),
    ]);
  });

  it('is idempotent on every live capture', () => {
    for (const { name, text } of CAPTURES) {
      const once = normalizeOpencodeTerminalOutputForDisplay(text);
      expect(normalizeOpencodeTerminalOutputForDisplay(once), name).toBe(once);
    }
  });

  it('never alters a line that carries a glyph, on any live capture', () => {
    // Visibility is judged the way the rule judges it: after stripping ANSI. A
    // raw `.trim()` would call the frame's colour-init row (escapes only)
    // "non-blank" and assert that layout row is preserved, which is the opposite
    // of what #1172 specifies.
    const visible = (text: string): string[] =>
      text.split('\n').filter((l) => stripAnsi(l).trim() !== '');
    for (const { name, text } of CAPTURES) {
      expect(visible(normalizeOpencodeTerminalOutputForDisplay(text)), name).toEqual(
        visible(text),
      );
    }
  });

  it('equals the Issue #1172 rule on frames that hold no painted panel row', () => {
    // Most opencode frames have no overlay open. On those the two rules must be
    // literally the same bytes, or "opencode looks different with no picker up"
    // becomes a regression nobody attributes to this change.
    let checked = 0;
    for (const { name, text } of CAPTURES) {
      if (text.split('\n').some(isPaintedPanelRow)) continue;
      checked += 1;
      expect(normalizeOpencodeTerminalOutputForDisplay(text), name).toBe(
        normalizeTerminalOutputForDisplay(text),
      );
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });
});
