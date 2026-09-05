/**
 * Issue #2323: the shared background scan, and the foreground bug it repaired.
 *
 * `scanRowBackgrounds` and `backgroundAt` moved here from
 * `opencode-modal-overlay.ts`, where Issue #2112 wrote them privately. The
 * overlay suite (`tests/unit/detection-opencode-modal-overlay-2112.test.ts`,
 * 58 assertions, unchanged by this Issue) is the regression test for the move
 * itself; this file tests the primitive on its own terms and pins the one
 * behaviour that CHANGED — {@link applySgr} now consumes a foreground's
 * parameters instead of walking them as codes.
 *
 * ## What was measured
 *
 * `tests/fixtures/chat-dialog-card-2254/command-code-model-1-40-1.txt`, the
 * live Command Code 1.40.1 `/model` picker committed for Issue #2254. Nothing
 * new was captured. It is the frame where the bug is visible rather than
 * theoretical: Command Code prints every model row's trailing glyph in
 * `\x1b[38;2;46;189;142m`, whose green channel is `46`, and the old walk read
 * that as "background 6" on every row of the picker except the one actually
 * highlighted.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/ansi';
import {
  backgroundAt,
  backgroundValues,
  dominantBackground,
  scanRowBackgrounds,
} from '@/lib/detection/sgr-background';

const ESC = '\x1b[';

const FIXTURE = path.join(
  process.cwd(),
  'tests/fixtures/chat-dialog-card-2254/command-code-model-1-40-1.txt',
);

/** The live picker, raw. Read once — every case below reads the same bytes. */
const COMMAND_CODE_MODEL = fs.readFileSync(FIXTURE, 'utf8');

/** Rows of that capture, as captured. */
const COMMAND_CODE_ROWS = COMMAND_CODE_MODEL.replace(/\r\n/g, '\n').split('\n');

/** How many rows of a frame paint any background at all. */
function paintedRowCount(rows: readonly string[]): number {
  return rows.filter(row => dominantBackground(scanRowBackgrounds(row)).bg !== null).length;
}

describe('[#2323] scanRowBackgrounds reads the row the way stripAnsi does', () => {
  it('produces text byte-identical to stripAnsi on every row of a live capture', () => {
    // The same invariant #2112 asserted before the move: the restated
    // ANSI_SEQUENCE pattern cannot drift from `ansi.ts` without this failing.
    for (const row of COMMAND_CODE_ROWS) {
      expect(scanRowBackgrounds(row).text).toBe(stripAnsi(row));
    }
  });

  it('reports a bare row as unpainted, with no segments and no edges', () => {
    const row = scanRowBackgrounds('  Kimi K2.6   long-horizon coding with vision');
    expect(dominantBackground(row)).toEqual({ bg: null, columns: 0 });
    expect(backgroundValues(row).size).toBe(0);
    expect(backgroundAt(row, 0)).toBeNull();
  });
});

describe('[#2323] a foreground colour is consumed, not walked', () => {
  // `38;2;46;189;142` is Command Code's own green. Its channels are 46, 189
  // and 142; 46 is inside the 16-colour background range 40–47 and 142 is not,
  // which is why the old walk turned exactly this sequence into a background.
  it('does not read `38;2;46;189;142` as background 46', () => {
    const row = scanRowBackgrounds(`${ESC}38;2;46;189;142mKimi K2.6${ESC}39m`);
    expect(dominantBackground(row).bg).toBeNull();
    expect(backgroundValues(row).size).toBe(0);
  });

  it('does not read `38;2;76;85;106` as background 106 either', () => {
    // The 100–107 half of the same range, from the separator rule of the same
    // capture. Two ranges, two channels — one guard would not cover both.
    const row = scanRowBackgrounds(`${ESC}38;2;76;85;106m────────${ESC}39m`);
    expect(dominantBackground(row).bg).toBeNull();
  });

  it('does not read a 256-colour foreground `38;5;46` as background 46', () => {
    const row = scanRowBackgrounds(`${ESC}38;5;46mgreen text${ESC}39m`);
    expect(dominantBackground(row).bg).toBeNull();
  });

  it('does not read an underline colour `58;2;44;44;44` as a background', () => {
    const row = scanRowBackgrounds(`${ESC}4m${ESC}58;2;44;44;44munderlined${ESC}0m`);
    expect(dominantBackground(row).bg).toBeNull();
  });

  it('still reads a real background that FOLLOWS a foreground on the same row', () => {
    // The consumption must advance the cursor by exactly the right number of
    // parameters: one too few and the `48` below is skipped, one too many and
    // it is read as a channel.
    const row = scanRowBackgrounds(`${ESC}38;2;46;189;142m${ESC}48;2;45;43;85mselected${ESC}0m`);
    expect(dominantBackground(row)).toEqual({ bg: '48;2;45;43;85', columns: 8 });
  });

  it('reads a foreground and a background packed into ONE sequence', () => {
    const row = scanRowBackgrounds(`${ESC}1;38;2;46;189;142;48;5;16;4mrow${ESC}0m`);
    expect(dominantBackground(row)).toEqual({ bg: '48;5;16', columns: 3 });
  });

  it('cuts the live picker from 70 painted rows to 8', () => {
    // The measurement in `applySgr`'s docblock, asserted so it cannot rot: 62
    // of the 70 were phantoms — the picker's unselected rows plus one
    // separator — and what remains is the seven-row boot banner and the one
    // genuinely highlighted model row.
    expect(paintedRowCount(COMMAND_CODE_ROWS)).toBe(8);
  });
});

describe('[#2323] the background codes that DO set a background', () => {
  it.each([
    ['24-bit', `${ESC}48;2;45;43;85m`, '48;2;45;43;85'],
    ['256-colour', `${ESC}48;5;16m`, '48;5;16'],
    ['16-colour', `${ESC}43m`, '43'],
    ['bright 16-colour', `${ESC}106m`, '106'],
  ])('%s: %s', (_label, sequence, expected) => {
    expect(dominantBackground(scanRowBackgrounds(`${sequence}painted${ESC}0m`)).bg).toBe(expected);
  });

  it.each([
    ['a full reset', '0'],
    ['a background reset', '49'],
  ])('%s clears it', (_label, code) => {
    const row = scanRowBackgrounds(`${ESC}43mpainted${ESC}${code}mbare`);
    expect(backgroundValues(row)).toEqual(new Set(['43']));
    expect(backgroundAt(row, 0)).toBe('43');
    expect(backgroundAt(row, 7)).toBeNull();
  });
});

describe('[#2323] dominantBackground sums a value across the runs it is split into', () => {
  it('adds up the runs one value is split into by foreground changes', () => {
    // Command Code's selected row in miniature: one background, interrupted
    // twice by foreground changes, then reset before a trailing glyph. The
    // widest single RUN is 6 columns; the row is painted in 12.
    const row = scanRowBackgrounds(
      `${ESC}48;2;45;43;85mlabel!${ESC}38;2;138;148;168mdescr!${ESC}0m ✔`,
    );
    expect(dominantBackground(row)).toEqual({ bg: '48;2;45;43;85', columns: 12 });
  });

  it('answers with the widest value when a row carries two', () => {
    const row = scanRowBackgrounds(`${ESC}43mabc${ESC}46mdefghij${ESC}0m`);
    expect(dominantBackground(row)).toEqual({ bg: '46', columns: 7 });
    expect(backgroundValues(row)).toEqual(new Set(['43', '46']));
  });

  it('reads the live picker’s selected row as one 72-column paint', () => {
    const selected = COMMAND_CODE_ROWS.find(row =>
      stripAnsi(row).startsWith('DeepSeek V4 Flash (latest) (default)'),
    );
    expect(selected).toBeDefined();
    expect(dominantBackground(scanRowBackgrounds(selected as string))).toEqual({
      bg: '48;2;45;43;85',
      columns: 72,
    });
  });
});

describe('[#2323] a frame captured without -e reads as unpainted', () => {
  it('finds no background anywhere once the ANSI is gone', () => {
    // Fail-open by construction: `captureAndCleanOutput` strips before its
    // caller sees the frame, and a stripped frame must report nothing rather
    // than something.
    const stripped = stripAnsi(COMMAND_CODE_MODEL).split('\n');
    expect(paintedRowCount(stripped)).toBe(0);
  });
});
