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
import { detectOpenCodeModalOverlay } from '@/lib/detection/opencode-modal-overlay';

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

const CLAUDE_MODEL = 'claude-model-2-1-259.txt';
const CLAUDE_TRUST = 'claude-trust-2-1-259.txt';
const CODEX_MODEL = 'codex-model-0-151-0.txt';
const CODEX_TRUST = 'codex-trust-0-151-0.txt';
const OPENCODE_OVERLAY = 'opencode-agent-overlay-1-18-27.txt';
const COMMAND_CODE_MODEL = 'command-code-model-1-40-1.txt';

/**
 * opencode's `ctrl+p` command palette painted OVER a live two-turn transcript,
 * at 200 columns — captured for Issue #2112 (`detectOpenCodeModalOverlay`'s own
 * suite reads the same bytes for the rectangle's geometry). Reused rather than
 * re-captured: it is already the exact shape Issue #2309 needs — the overlay
 * shares its rows with real conversation on BOTH sides, which the 2254
 * fixtures never exercise (their one opencode capture is a sidebar, not
 * interleaved prose) — and it is genuine live output, not a synthetic stand-in.
 */
function opencodeMidPaneOverlayFixture(): string {
  return fs.readFileSync(
    path.resolve(__dirname, '../../../fixtures/opencode-live-2047/w200/command-palette.txt'),
    'utf8',
  );
}

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

// ---------------------------------------------------------------------------
// Issue #2309: a selection list gets no tail at all
// ---------------------------------------------------------------------------

describe('[#2309] `selectionList: true` skips the tail slice', () => {
  it('keeps the whole search-type picker, not the tail 16', () => {
    // command-code's `/model` (Issue #2297's fixture): provider-grouped model
    // NAMES with no numbers to jump by, so #2297 correctly leaves it on the
    // arrow pad — and the old tail slice left everything but the last 16 of
    // its content rows unreachable before the card ever rendered.
    //
    // **Corrected by Issue #2326.** This case originally asserted all 89
    // compacted rows, banner included, because "no tail" was then implemented
    // as "the whole pane". #2326 crops the pane to the picker's own rows, so
    // the number is 71 and the banner is gone — see `dialog-frame-2326
    // .test.ts` for why, and for the 353-row frame that made it necessary.
    // What #2309 pinned is unchanged and is what is asserted here: every row
    // of the LIST survives, so the arrows cannot walk past a row the card
    // discarded.
    const full = extractDialogFrameTail(fixture(COMMAND_CODE_MODEL), { selectionList: true });
    const plain = stripAnsi(full);
    expect(full.split('\n')).toHaveLength(71);
    expect(full.split('\n').length).toBeGreaterThan(DIALOG_FRAME_MAX_LINES);
    // A model dozens of rows above the footer that a 16-row tail could never
    // have reached.
    expect(plain).toContain('GPT-5.4');
    expect(plain).toContain('type to search · ↑/↓ navigate · shift+↑/↓ jump provider');
  });

  it('is the mutation this pins: omit the option and the same fixture is cut to 16', () => {
    // Stated directly so a change that deletes the `selectionList` branch is
    // red HERE, on the exact fixture the row-count assertion above depends on,
    // rather than only visible as "fewer rows than expected".
    const withoutTheOption = extractDialogFrameTail(fixture(COMMAND_CODE_MODEL));
    expect(withoutTheOption.split('\n')).toHaveLength(DIALOG_FRAME_DEFAULT_LINES);
    expect(stripAnsi(withoutTheOption)).not.toContain('# Command Code v1.40.1');
  });

  it('leaves a non-selection-list frame tail-sliced exactly as before', () => {
    for (const name of ALL_FIXTURES) {
      const sliced = extractDialogFrameTail(fixture(name), { selectionList: false });
      expect(sliced.split('\n').length, name).toBeLessThanOrEqual(DIALOG_FRAME_DEFAULT_LINES);
    }
  });

  it('is still "" for a frame with nothing to draw', () => {
    expect(extractDialogFrameTail('', { selectionList: true })).toBe('');
    expect(extractDialogFrameTail('   \n\n\t\n', { selectionList: true })).toBe('');
  });
});

describe('[#2309] an opencode overlay is cropped to its rectangle, not the tail', () => {
  it('keeps the overlay’s own rows and drops the transcript further away', () => {
    const withOverlay = extractDialogFrameTail(opencodeMidPaneOverlayFixture(), {
      selectionList: true,
    });
    const plain = stripAnsi(withOverlay);
    expect(plain.split('\n')).toHaveLength(72);
    expect(plain).toContain('Commands');
    expect(plain).toContain('Switch model');
    expect(plain).toContain('esc');
    // Measured (see `opencodeMidPaneOverlayFixture`'s docblock): the shell
    // command opencode's session opened with sits ten-plus rows above the
    // overlay's own top edge and a "whole compacted frame" would drag it in —
    // the crop to the rectangle's row span is what leaves it out.
    expect(plain).not.toContain('uname -a');
  });

  it('agrees with `detectOpenCodeModalOverlay`’s own header text', () => {
    const raw = opencodeMidPaneOverlayFixture();
    const overlay = detectOpenCodeModalOverlay(raw);
    expect(overlay).not.toBeNull();
    const plain = stripAnsi(extractDialogFrameTail(raw, { selectionList: true }));
    expect(plain).toContain(overlay!.headerText);
  });

  it('does not read an opencode rectangle off a frame that has none', () => {
    // command-code's picker is a selection list with nothing for
    // `extractOpenCodeModalOverlayFrame` to find, which is what this case was
    // written to pin and still is. **Corrected by Issue #2326**: the row count
    // that used to follow — "so it falls back to the whole compacted frame" —
    // is no longer what happens, because command-code now has a cropper of its
    // own. The opencode reader answering `null` is the half that matters here.
    expect(detectOpenCodeModalOverlay(fixture(COMMAND_CODE_MODEL))).toBeNull();
    const full = extractDialogFrameTail(fixture(COMMAND_CODE_MODEL), { selectionList: true });
    expect(stripAnsi(full)).not.toContain('Commands');
  });

  it('falls back to the whole compacted frame when NO cropper recognises it', () => {
    // Issue #2326: the fallback is still there and this is where it is
    // measured — claude and codex clear their screens, so neither cropper has
    // anything to read and neither needs one. Every compacted row is kept,
    // exactly as #2309 left it.
    for (const [name, rows] of [
      [CLAUDE_MODEL, 19],
      [CODEX_MODEL, 32],
    ] as const) {
      const full = extractDialogFrameTail(fixture(name), { selectionList: true });
      expect(full.split('\n').length, name).toBe(rows);
    }
    // Not just a row count: the claude capture's first three content rows are
    // its boot banner, three rows further up than the 16-row tail reaches.
    // Their presence here — and their absence from the tail beside it — is
    // what "the WHOLE compacted frame, uncropped" means.
    const banner = 'Claude Code v2.1.259';
    expect(
      stripAnsi(extractDialogFrameTail(fixture(CLAUDE_MODEL), { selectionList: true })),
    ).toContain(banner);
    expect(stripAnsi(extractDialogFrameTail(fixture(CLAUDE_MODEL)))).not.toContain(banner);
  });

  it('is not reached for the old sidebar-only opencode fixture (no hatch on it)', () => {
    // `OPENCODE_OVERLAY` predates Issue #2112's detector and is trimmed to its
    // last 200 rows (see the fixture README), which cuts the hatch row off —
    // `detectOpenCodeModalOverlay` correctly reports null on it, and this
    // module must still fall back to the whole-compacted-frame behaviour
    // rather than returning nothing.
    expect(detectOpenCodeModalOverlay(fixture(OPENCODE_OVERLAY))).toBeNull();
    const full = extractDialogFrameTail(fixture(OPENCODE_OVERLAY), { selectionList: true });
    expect(full).not.toBe('');
    expect(stripAnsi(full)).toContain('OpenCode 1.18.27');
  });
});
