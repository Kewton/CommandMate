/**
 * Background colours read off a `capture-pane -e` row (Issue #2323).
 *
 * ## Why this is its own module
 *
 * Two different questions in this repository are answered by the same walk over
 * a captured row's SGR sequences:
 *
 *  - `opencode-modal-overlay.ts` (Issue #2112) asks **where the edges are** — an
 *    opencode overlay is a rectangle whose rows switch the background on and off
 *    at the same two columns, and the rule is about those columns;
 *  - `ChatDialogCard.tsx` (Issue #2323) asks **which row is painted** — Command
 *    Code's `/model` picker marks the arrow-selected row with a background and
 *    prints no caret at all, so the card's scroll-follow has nothing else to
 *    anchor on.
 *
 * #2112 wrote the walk first and kept it private. #2323 needs the identical
 * answer to "what background is painted at column N of this row", and a second
 * copy of an SGR state machine is exactly how the two readings would come to
 * disagree about the same bytes while both claiming to read backgrounds — the
 * argument `terminal-columns.ts` already makes for column counting.
 *
 * A leaf module by design: it imports the column rule and nothing else, so a
 * detector, a payload builder and a client component can all share it.
 *
 * ## What a `null` background means
 *
 * The terminal default — i.e. "this row said nothing about its background",
 * which is also what an already-stripped frame produces for every column. Every
 * caller therefore fails OPEN on a frame captured without `-e`: it reads no
 * rectangle and no painted row rather than inventing one. `lib/tmux/tmux.ts`
 * always passes `-e`, and Auto-Yes's `captureAndCleanOutput` is the one path in
 * this repository that strips first.
 *
 * @module lib/detection/sgr-background
 */

import { visibleWidth } from './terminal-columns';

/**
 * Every ANSI sequence, in the repository's own spelling.
 *
 * Restated from `ANSI_PATTERN` (`ansi.ts`) rather than imported because this
 * module needs to walk the sequences IN ORDER while counting columns, and that
 * one is a shared `g`-flagged instance whose `lastIndex` a caller must not
 * disturb. `tests/unit/detection/sgr-background-2323.test.ts` asserts the text
 * this scan produces is byte-identical to `stripAnsi`'s, so the restatement
 * cannot drift silently.
 */
const ANSI_SEQUENCE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;]*m/g;

/** An SGR sequence, with its parameters. Only these can change the background. */
const SGR_PARAMETERS = /^(?:\x1b\[|\[)([0-9;]*)m$/;

/**
 * The SGR codes that introduce an EXTENDED colour and therefore swallow the
 * parameters after them: foreground (`38`), background (`48`) and the
 * underline colour (`58`, which tmux re-emits from terminals that set it).
 *
 * They are listed together because the swallowing is the point — see
 * {@link applySgr}.
 */
const EXTENDED_COLOUR_CODES = new Set([38, 48, 58]);

/** A run of columns painted with one background. `null` is the terminal default. */
export interface BackgroundSegment {
  readonly bg: string | null;
  /** First column of the run, 0-based inclusive. */
  readonly start: number;
  /** One past the last column of the run. */
  readonly end: number;
}

/** One captured row, measured once. */
export interface ScannedRow {
  /** The row with every ANSI sequence removed — identical to `stripAnsi(row)`. */
  readonly text: string;
  /** Background runs across the row, adjacent runs of equal value merged. */
  readonly segments: readonly BackgroundSegment[];
  /** Columns a background boundary sits at, plus the row's own right edge. */
  readonly edges: ReadonlySet<number>;
  /** How many columns the row paints. */
  readonly width: number;
}

/**
 * Fold one SGR sequence's parameters into the current background.
 *
 * Handles the three forms tmux emits: the 16-colour codes (`40`–`47`,
 * `100`–`107`), the 256-colour and 24-bit extended forms (`48;5;n`,
 * `48;2;r;g;b`), and the two resets (`0`, `49`). Attribute codes leave the
 * background alone, which is what keeps a syntax-highlighted transcript row
 * from producing dozens of spurious edges.
 *
 * ## Foreground parameters are consumed, not scanned (Issue #2323)
 *
 * A 24-bit FOREGROUND is `38;2;r;g;b`, and its channels are ordinary numbers
 * that land in the 16-colour background ranges as often as not. Walking them as
 * if they were codes in their own right is what #2112's private version did,
 * and Command Code's `/model` picker is where it shows: every model row is
 * printed `\x1b[38;2;46;189;142m`, whose green channel `46` was then read as
 * "background 6" — so every row that is NOT selected reported itself painted.
 * Measured on `tests/fixtures/chat-dialog-card-2254/command-code-model-1-40-1
 * .txt`: 70 of the 1001 rows carried a background before this and 8 after, the
 * 62 that went being the picker's unselected rows and one `38;2;76;85;106`
 * separator. `58` (underline colour) takes the same parameter shapes and is
 * consumed the same way.
 *
 * Only `48` assigns; `38` and `58` consume their parameters and move on.
 */
function applySgr(current: string | null, parameters: string): string | null {
  const parts = (parameters === '' ? '0' : parameters).split(';');
  let bg = current;
  for (let i = 0; i < parts.length; i++) {
    const code = Number(parts[i] === '' ? '0' : parts[i]);
    if (!Number.isFinite(code)) continue;
    if (EXTENDED_COLOUR_CODES.has(code)) {
      // `2` is r;g;b and `5` is a palette index; anything else is a bare `38` /
      // `48` / `58` with no extended form, which sets nothing and swallows
      // nothing.
      const span = parts[i + 1] === '2' ? 4 : parts[i + 1] === '5' ? 2 : 0;
      if (span > 0 && code === 48) bg = parts.slice(i, i + 1 + span).join(';');
      i += span;
      continue;
    }
    if (code === 0 || code === 49) {
      bg = null;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      bg = parts[i];
    }
  }
  return bg;
}

/** Measure one captured row: its text, its background runs and their edges. */
export function scanRowBackgrounds(line: string): ScannedRow {
  ANSI_SEQUENCE.lastIndex = 0;

  const segments: BackgroundSegment[] = [];
  let text = '';
  let bg: string | null = null;
  let columns = 0;
  let segmentStart = 0;
  let cursor = 0;

  let match: RegExpExecArray | null;
  while ((match = ANSI_SEQUENCE.exec(line)) !== null) {
    const chunk = line.slice(cursor, match.index);
    text += chunk;
    columns += visibleWidth(chunk);
    cursor = match.index + match[0].length;

    const sgr = SGR_PARAMETERS.exec(match[0]);
    if (sgr === null) continue;
    const next = applySgr(bg, sgr[1]);
    if (next === bg) continue;
    if (columns > segmentStart) segments.push({ bg, start: segmentStart, end: columns });
    bg = next;
    segmentStart = columns;
  }

  const tail = line.slice(cursor);
  text += tail;
  columns += visibleWidth(tail);
  if (columns > segmentStart) segments.push({ bg, start: segmentStart, end: columns });

  const edges = new Set<number>(segments.map(segment => segment.start));
  if (segments.length > 0) edges.add(segments[segments.length - 1].end);

  return { text, segments, edges, width: columns };
}

/** The background painted at one column, or `null` for the terminal default. */
export function backgroundAt(row: ScannedRow, column: number): string | null {
  for (const segment of row.segments) {
    if (segment.start <= column && column < segment.end) return segment.bg;
  }
  return null;
}

/**
 * Every background value the row paints, ignoring how much of it each covers.
 *
 * The companion to {@link dominantBackground}: one says what a row is mostly
 * painted in, the other says what it is painted in AT ALL. A caller separating
 * a highlighted row from the panel it sits in needs both — the panel's colour
 * is on the neighbouring rows somewhere, usually not as their dominant one
 * (Command Code's boot banner is the exception that makes the rule readable:
 * there the panel colour IS the dominant one on all seven of its rows).
 */
export function backgroundValues(row: ScannedRow): ReadonlySet<string> {
  const values = new Set<string>();
  for (const segment of row.segments) {
    if (segment.bg !== null) values.add(segment.bg);
  }
  return values;
}

/** {@link dominantBackground}'s answer. */
export interface DominantBackground {
  /** The background covering the most columns, or `null` if none is painted. */
  readonly bg: string | null;
  /** How many columns that background covers. `0` when `bg` is `null`. */
  readonly columns: number;
}

/**
 * The background a row is mostly painted in, and how much of it that covers.
 *
 * "Mostly" rather than "entirely" because a painted row is not painted in one
 * run: Command Code's selected `/model` row switches the FOREGROUND twice
 * across the label and the description, which splits the background into three
 * segments of the same value, and its trailing `✔` glyph is printed after the
 * background is reset. Summing per value and taking the largest reads that as
 * one painted row; taking the first or the widest single segment would read it
 * as a third of one.
 *
 * Ties go to whichever value is encountered first, which is arbitrary and
 * deliberately so — a row split evenly between two backgrounds is not a row
 * painted in one, and every caller of this has a floor that such a row fails.
 */
export function dominantBackground(row: ScannedRow): DominantBackground {
  const totals = new Map<string, number>();
  for (const segment of row.segments) {
    if (segment.bg === null) continue;
    totals.set(segment.bg, (totals.get(segment.bg) ?? 0) + (segment.end - segment.start));
  }

  let bg: string | null = null;
  let columns = 0;
  for (const [value, painted] of totals) {
    if (painted > columns) {
      bg = value;
      columns = painted;
    }
  }
  return { bg, columns };
}
