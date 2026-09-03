/**
 * `extractDialogFrameTail` — which rows of a pane the chat surface's dialog card
 * draws (Issue #2254).
 *
 * The rule is two lines of code and the whole risk is in their ORDER, so this
 * suite is built around the one measurement that settles it: a 200x1000
 * production pane is mostly blank, and the live captures in
 * `tests/fixtures/chat-dialog-card-2254/` disagree about which END the blankness
 * is at.
 *
 *   - claude's `/model` overlay is bottom-anchored (alternate screen): content
 *     in rows 986–1000, ~980 blank rows above.
 *   - codex's pickers are top-anchored (no alternate screen): content in rows
 *     1–32, ~968 blank rows BELOW.
 *
 * A `lines.slice(-16)` renders codex's dialog as sixteen empty rows — a blank
 * black box at the exact moment the user is being told they can answer the
 * dialog here. Compacting first (which drops the leading and trailing blank runs
 * outright) and slicing second is what makes both shapes work, and the codex
 * fixtures are what keep that ordering from being "simplified" away.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIALOG_FRAME_DEFAULT_LINES,
  DIALOG_FRAME_MAX_LINES,
  DIALOG_FRAME_MIN_LINES,
  extractDialogFrameTail,
  hasDialogFrame,
} from '@/lib/chat/dialog-frame';
import { stripAnsi } from '@/lib/detection/ansi';

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

const CLAUDE_MODEL = 'claude-model-2-1-259.txt';
const CLAUDE_TRUST = 'claude-trust-2-1-259.txt';
const CODEX_MODEL = 'codex-model-0-151-0.txt';
const CODEX_TRUST = 'codex-trust-0-151-0.txt';
const OPENCODE_OVERLAY = 'opencode-agent-overlay-1-18-27.txt';

const ALL_FIXTURES = [
  CLAUDE_MODEL,
  CLAUDE_TRUST,
  CODEX_MODEL,
  CODEX_TRUST,
  OPENCODE_OVERLAY,
] as const;

// ---------------------------------------------------------------------------
// The fixtures have to stay raw, or every assertion below becomes vacuous
// ---------------------------------------------------------------------------

describe('[#2254] the captures are still raw panes', () => {
  it.each(ALL_FIXTURES)('%s still carries ESC bytes', (name) => {
    // Strip the escapes and a naive slice starts passing: the ANSI is what
    // carries the selection highlight the card exists to show, and #2049's
    // painted-panel predicate reads the SGR background directly.
    expect(fixture(name)).toContain('\x1b[');
  });

  it('claude /model is bottom-anchored and codex /model is top-anchored', () => {
    // The premise of this whole module. Asserted rather than assumed, because a
    // re-captured fixture that lost one of the two shapes would silently take
    // the ordering guarantee below with it.
    const contentRows = (name: string): number[] =>
      fixture(name)
        .split('\n')
        .map((line, i) => (stripAnsi(line).trim() === '' ? -1 : i))
        .filter((i) => i >= 0);

    const claude = contentRows(CLAUDE_MODEL);
    const codex = contentRows(CODEX_MODEL);

    expect(claude[claude.length - 1]).toBeGreaterThan(900);
    expect(codex[codex.length - 1]).toBeLessThan(100);
    // …in a pane that really is 1000 rows tall in both cases (TUI_PANE_HEIGHT).
    // `.replace(/\n$/, '')` drops the file's final newline, which `split` would
    // otherwise count as a 1001st row.
    for (const name of [CLAUDE_MODEL, CODEX_MODEL]) {
      expect(fixture(name).replace(/\n$/, '').split('\n'), name).toHaveLength(1000);
    }
  });
});

// ---------------------------------------------------------------------------
// The ordering that makes both shapes work
// ---------------------------------------------------------------------------

describe('[#2254] the tail is taken AFTER the blank runs are collapsed', () => {
  it('finds the codex picker even though 968 blank rows follow it', () => {
    const tail = extractDialogFrameTail(fixture(CODEX_MODEL));
    const plain = stripAnsi(tail);

    expect(plain).toContain('Select Model and Effort');
    expect(plain).toContain('Press enter to confirm or esc to go back');
    // The mutation this pins: slice first, compact second (or never), and the
    // card is sixteen empty rows.
    expect(plain.trim()).not.toBe('');
  });

  it('is not the same thing as the raw last N rows — the raw tail is blank', () => {
    // Stated directly so the previous test cannot pass for an accidental
    // reason. This is the naive implementation, run on the same fixture.
    const naive = fixture(CODEX_MODEL).split('\n').slice(-DIALOG_FRAME_DEFAULT_LINES).join('\n');
    expect(stripAnsi(naive).trim()).toBe('');
  });

  it('finds the codex trust dialog, numbered options and all', () => {
    const plain = stripAnsi(extractDialogFrameTail(fixture(CODEX_TRUST)));
    expect(plain).toContain('1. Yes, continue');
    expect(plain).toContain('2. No, quit');
  });

  it('finds the claude /model overlay at the other end of the same pane', () => {
    const plain = stripAnsi(extractDialogFrameTail(fixture(CLAUDE_MODEL)));
    expect(plain).toContain('Select model');
    expect(plain).toContain('Enter to set as default');
    // The dialog is the LAST thing in the pane, so the card's last row is the
    // dialog's footer and not, say, the shell line the session was launched
    // from (rows 2-4 of that capture).
    expect(plain).not.toContain('scratchpad/dlg-probe && claude');
  });

  it('finds the claude folder-trust list, which is top-anchored like codex', () => {
    const plain = stripAnsi(extractDialogFrameTail(fixture(CLAUDE_TRUST)));
    expect(plain).toContain('Yes, I trust this folder');
    expect(plain).toContain('No, exit');
  });
});

// ---------------------------------------------------------------------------
// Row budget
// ---------------------------------------------------------------------------

describe('[#2254] the row budget', () => {
  it.each(ALL_FIXTURES)('%s is clipped to the default row count', (name) => {
    const rows = extractDialogFrameTail(fixture(name)).split('\n');
    expect(rows.length).toBeLessThanOrEqual(DIALOG_FRAME_DEFAULT_LINES);
  });

  it('honours a caller that asks for fewer rows (the phone)', () => {
    const rows = extractDialogFrameTail(fixture(CODEX_MODEL), { maxLines: 12 }).split('\n');
    expect(rows.length).toBe(12);
    // 12 rows is still the whole answerable part of the picker.
    expect(stripAnsi(rows.join('\n'))).toContain('Press enter to confirm');
  });

  it('clamps into the Issue’s 12-20 window rather than trusting the caller', () => {
    const tooFew = extractDialogFrameTail(fixture(OPENCODE_OVERLAY), { maxLines: 1 });
    const tooMany = extractDialogFrameTail(fixture(OPENCODE_OVERLAY), { maxLines: 500 });
    expect(tooFew.split('\n')).toHaveLength(DIALOG_FRAME_MIN_LINES);
    expect(tooMany.split('\n')).toHaveLength(DIALOG_FRAME_MAX_LINES);
  });

  it('falls back to the default for a non-finite request', () => {
    const nan = extractDialogFrameTail(fixture(OPENCODE_OVERLAY), { maxLines: Number.NaN });
    expect(nan.split('\n')).toHaveLength(DIALOG_FRAME_DEFAULT_LINES);
  });

  it('returns a frame shorter than the budget whole, without padding it', () => {
    const short = 'Do you want to proceed?\n1. Yes\n2. No';
    expect(extractDialogFrameTail(short)).toBe(short);
  });
});

// ---------------------------------------------------------------------------
// Blank-run handling
// ---------------------------------------------------------------------------

describe('[#2254] blank rows', () => {
  it('drops a leading and a trailing blank run outright', () => {
    expect(extractDialogFrameTail('\n\n\n  question  \n\n\n')).toBe('  question  ');
  });

  it('keeps an internal run of one or two blank rows verbatim', () => {
    // Rule 3 of compactBlankRuns: a short gap is layout the dialog drew on
    // purpose (codex puts one blank row between its question and its options).
    expect(extractDialogFrameTail('a\n\nb')).toBe('a\n\nb');
    expect(extractDialogFrameTail('a\n\n\nb')).toBe('a\n\n\nb');
  });

  it('collapses an internal run of three or more to one', () => {
    expect(extractDialogFrameTail('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('keeps opencode’s background-painted panel rows, which carry no glyphs', () => {
    // Issue #2049: those rows are ~70 columns of spaces under an SGR background
    // and they are the panel's top band and section separators. #1172's bare
    // rule reads them as padding and deletes the panel's structure.
    const painted = '\x1b[48;2;20;20;20m                    \x1b[0m';
    const frame = ['Select agent', painted, painted, painted, painted, '  build'].join('\n');
    const tail = extractDialogFrameTail(frame);
    expect(tail.split('\n')).toHaveLength(6);
    expect(tail).toContain('48;2;20;20;20');
  });

  it('preserves the escape sequences of a collapsed run so colour state survives', () => {
    // Rule 4: the dropped rows' ANSI is carried onto the row that is kept, so a
    // colour opened above a gap still applies below it.
    const tail = extractDialogFrameTail('\x1b[31ma\n\x1b[32m\n\n\n\x1b[0m\nb');
    expect(tail).toContain('\x1b[32m');
    expect(tail).toContain('\x1b[0m');
  });
});

// ---------------------------------------------------------------------------
// ANSI, and the empty cases
// ---------------------------------------------------------------------------

describe('[#2254] ANSI is preserved, not stripped', () => {
  it('keeps the SGR that marks the selected row in claude’s picker', () => {
    // The card renders through `sanitizeTerminalOutput`, so the escapes become
    // coloured spans. Strip them here and the user cannot see WHICH model is
    // currently selected — the one thing they opened the picker to find out.
    const tail = extractDialogFrameTail(fixture(CLAUDE_MODEL));
    expect(tail).toContain('\x1b[');
    expect(stripAnsi(tail)).not.toContain('\x1b[');
  });

  it('keeps opencode’s per-row background, sidebar column and all', () => {
    // Issue #2095: the overlay shares its rows with the sidebar at 200 columns.
    // #2254 accepts that — the card shows the frame, it does not parse it.
    const tail = extractDialogFrameTail(fixture(OPENCODE_OVERLAY));
    expect(tail).toContain('\x1b[48;2;');
    expect(stripAnsi(tail)).toContain('OpenCode 1.18.27');
  });
});

describe('[#2254] nothing to draw', () => {
  it.each([
    ['empty string', ''],
    ['only newlines', '\n\n\n'],
    ['only whitespace', '   \n\t\n  '],
    ['only ANSI with no columns', '\x1b[0m\n\x1b[38;5;1m'],
  ])('returns "" for %s', (_label, input) => {
    expect(extractDialogFrameTail(input)).toBe('');
    expect(hasDialogFrame(input)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('returns "" for %s', (_label, input) => {
    expect(extractDialogFrameTail(input)).toBe('');
    expect(hasDialogFrame(input)).toBe(false);
  });

  it('reports a real frame as drawable', () => {
    for (const name of ALL_FIXTURES) {
      expect(hasDialogFrame(fixture(name)), name).toBe(true);
    }
  });

  it('normalises CRLF so a Windows-style frame has no stray carriage returns', () => {
    expect(extractDialogFrameTail('a\r\nb\r\n')).toBe('a\nb');
  });
});
