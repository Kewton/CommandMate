/**
 * opencode's modal overlays, detected structurally from a captured frame
 * (Issue #2112).
 *
 * ## What this is about
 *
 * opencode 1.18 opens its session list (`ctrl+x l`), agent list (`ctrl+x a`),
 * timeline (`ctrl+x g`), command palette (`ctrl+p`) and model picker
 * (`ctrl+x m`) as an overlay painted OVER the transcript. The overlay hides
 * nothing the detector reads: the finished-turn marker `▣ Build · <model> ·
 * 2.8s` from the previous turn is still on the pane above it, and the input box
 * is still drawn below it. So branch D of `tools/opencode/detect.ts` matched the
 * old marker and published a pane that is blocked on a human as
 * `ready` / `opencode_response_complete` — measured on the committed #2046
 * fixtures, `dialog-{session-list,agent-list,timeline}.txt`.
 *
 * That is worse than it sounds, and it is why this module exists rather than a
 * widened allowlist. `ready` is POSITIVE evidence, so the frame never reaches
 * the "nothing could read this" path #1017 / #1494 built for unknown overlays:
 * `isUnclassifiedActive` stays false, the 60-second escape hatch never opens,
 * and `commandmate wait` reports the blocked pane as **exit 0, completed**.
 * `claude`'s `/help` overlay is the benign version of the same shape — it lands
 * on `running` / `default`, i.e. on the no-evidence side, where the hatch does
 * open.
 *
 * ## The signature, and why it is not a word list
 *
 * `Sessions`, `Commands`, `Timeline` and `Select agent` are the overlay
 * headings. They are also ordinary English an agent writes in a reply, and
 * Issue #1883 already deleted one "the word is somewhere on the pane" inference
 * for exactly that reason (#1896 measured the harm: an answer that said
 * `Select model to continue:` parked the session on `waiting` for the rest of
 * the session). `OPENCODE_SELECTION_LIST_PATTERN` reacted by narrowing to three
 * allowlisted headings, which is why `Select agent` does not match it today.
 *
 * This module reads the LAYOUT instead. opencode paints the overlay as a
 * background-coloured rectangle, and `capture-pane -e` re-emits that background
 * verbatim:
 *
 * ```
 *   ␛[48;2;20;20;20m    Commands                     ␛[38;2;128;128;128mesc␛[0m    ␛[48;2;4;4;4mlogical
 *   └ column 10 ─────────────────────────────────────────────────────────┘ column 70
 * ```
 *
 * Every row of the overlay switches the background on at the SAME column and
 * off at the SAME column, whatever is written on it — and one of those rows
 * carries the overlay's own dismiss affordance, `esc`, right-aligned INSIDE the
 * rectangle. Both halves are needed:
 *
 *  - the rectangle alone is also what opencode's input box and its echoed user
 *    prompts are (measured: the composer is a painted rectangle at columns
 *    3–78 on every 80-column frame in `opencode-live-2046`);
 *  - the `esc` hatch alone is also what the composer footer says while the agent
 *    is generating (`⬝⬝⬝⬝⬝⬝  esc interrupt`, `esc again to interrupt`) — which
 *    is why the hatch is required to be the LAST thing inside the rectangle, as
 *    `OPENCODE_SELECTION_LIST_PATTERN` requires it to be the last thing on the
 *    line.
 *
 * Reading the rectangle rather than the row's total width is what makes this
 * work over a busy transcript. At 120 and 200 columns the same palette is
 * centred with response text visible on BOTH sides of it
 * (`opencode-live-2047/w200/command-palette.txt`), so the rows are not equal in
 * length and nothing outside the rectangle is constant — only its two edges are.
 *
 * ## What a match means, and what it does not
 *
 * A match means a background-painted rectangle offering an `esc` hatch was on
 * the pane. A **non**-match means no such rectangle could be read, and NEVER
 * "no overlay is open": the rule needs the SGR the capture was taken with, so a
 * caller that hands over an already-stripped frame — Auto-Yes's
 * `captureAndCleanOutput` is the one in this repository — always gets `null`.
 * That is fail-open by construction and matches how `tools/opencode/prompt.ts`
 * already describes its own gutter anchor on that path. Every production caller
 * of `detectSessionStatus` passes the raw `capture-pane -e` output
 * (`lib/tmux/tmux.ts` always passes `-e`).
 *
 * A leaf module by design: it imports the ANSI primitives, the column rule and
 * the excerpt bound and nothing else.
 *
 * @module lib/detection/opencode-modal-overlay
 */

import { truncateToByteBudget } from './excerpt';
import { sliceColumns, visibleWidth } from './terminal-columns';

/**
 * Published `sessionStatusReason` for this signature.
 *
 * Snake case, like every other reason, and distinct from
 * `opencode_selection_list` on purpose: an operator reading `capture --json`
 * can then tell "the allowlisted picker heading matched" from "a painted
 * rectangle with an esc hatch was on the pane", which are two different
 * readings of the same screen and fail in different ways.
 */
export const OPENCODE_MODAL_OVERLAY_ID = 'opencode_modal_overlay';

/**
 * The key that closes it, in opencode's own notation.
 *
 * Taken from the overlay's own chrome — the hatch this module anchors on IS the
 * affordance, printed by opencode at the right edge of the header row. Exported
 * for the same reason {@link OPENCODE_SIDEBAR_RECOVERY_CHORD} is: no surface
 * should hold a bare key literal of its own.
 */
export const OPENCODE_MODAL_OVERLAY_RECOVERY_KEY = 'esc';

/**
 * Leftmost column an overlay rectangle may start at.
 *
 * One, not zero. A rectangle that starts at column 0 is not an overlay drawn
 * OVER the pane — it is the pane's own background, which some themes paint
 * explicitly (measured: `opencode-live-2047/w200/*` paint every row
 * `48;2;4;4;4` from column 0), and treating that as a rectangle makes every row
 * of every frame "match" whatever else is asserted. The measured overlays start
 * at column 10 (80 and 120 columns), 70 (200 columns) and 1 (the 80-column
 * session list and timeline, which are nearly pane-wide), so the constraint has
 * never been the thing that decided a verdict.
 */
export const OPENCODE_OVERLAY_MIN_LEFT = 1;

/**
 * Narrowest rectangle that can be an overlay, in columns.
 *
 * The measured overlays are 60 columns wide (palette and pickers at every
 * width) and 78 (the session list and timeline at 80 columns), so this is a
 * floor with four times the headroom rather than a tuned threshold. Its job is
 * to reject a single highlighted CELL — opencode paints the selected row of a
 * list in its own background, and a one-word highlight elsewhere on the pane
 * should not be able to pose as a dialog.
 */
export const OPENCODE_OVERLAY_MIN_WIDTH = 16;

/**
 * How many rows must carry the rectangle before this reports a match.
 *
 * Three: the measured overlays carry 8 (the timeline, the shortest) to 72 (the
 * command palette), so there is an order of magnitude of headroom, and three is
 * what a real dialog cannot be under — opencode draws a padding row, the header
 * row with the hatch, and a padding row before any content at all.
 */
export const OPENCODE_OVERLAY_MIN_ROWS = 3;

/**
 * How far down the rectangle the `esc` hatch may sit, in rows.
 *
 * A dialog puts its dismiss affordance in its TITLE BAR, and the measurement is
 * unusually clean: on all eleven overlays in this repository — four #2046
 * dialogs, the palette at 80/120/200 columns, the #2049 and #1896 palettes, the
 * #1896 model picker and the canary picker — the hatch is on the SECOND row that
 * carries the rectangle, the first being the overlay's top padding. Three is
 * that measurement plus one row of headroom.
 *
 * What it buys is the case the other guards cannot reach: opencode paints code
 * blocks in an agent's reply with their own background, so a fenced keybinding
 * table (`quit    esc`) is a painted rectangle with a hatch-shaped row in it.
 * Requiring the hatch at the top makes that a table in the middle of a block
 * rather than a dialog's title bar. The 120- and 200-column captures show the
 * other half of the same problem — transcript painting produces up to fourteen
 * incidental rectangles per frame — and not one of them carries a hatch at all.
 */
export const OPENCODE_OVERLAY_HEADER_ROW_LIMIT = 3;

/** Bound on {@link OpenCodeModalOverlay.headerText}, in UTF-8 bytes. */
export const OPENCODE_OVERLAY_EXCERPT_MAX_BYTES = 200;

/** Appended when {@link OPENCODE_OVERLAY_EXCERPT_MAX_BYTES} cut the excerpt. */
export const OPENCODE_OVERLAY_TRUNCATION_MARKER = '…[truncated]';

/**
 * The overlay's dismiss affordance, right-aligned inside the rectangle.
 *
 * Deliberately the same shape as `OPENCODE_SELECTION_LIST_PATTERN`'s tail
 * (Issue #1896): text, then two or more spaces, then `esc`, then nothing but
 * padding. The `$` is what separates a dialog's hatch from the composer footer's
 * `esc interrupt` / `esc again to interrupt`, which carry a word AFTER the key —
 * both of those are live frames in this repository
 * (`opencode-live-1883/turn-running.txt`,
 * `opencode-live-1894/esc-again-after-marker.txt`) and both are painted
 * rectangles, so without the anchor a generating pane would be read as a dialog.
 *
 * Applied to the rectangle's own columns, never to the whole row: at 120 and 200
 * columns the transcript resumes to the right of the overlay on the same line,
 * so a row-anchored `$` would never match there.
 *
 * The leading `\S` keeps a rectangle whose only content is the hatch from
 * counting: a dialog has a heading.
 *
 * Linear pattern, no nested quantifiers — ReDoS safe (S4-001).
 */
const OVERLAY_ESCAPE_HATCH = /\S[^\S\n]{2,}esc[^\S\n]*$/;

/** Cheap pre-filter for the rows worth measuring at all. */
const ESCAPE_HATCH_WORD = 'esc';

/**
 * One of opencode's own box gutters: the composer, the permission dialog, or an
 * echoed user prompt.
 *
 * Same character class as `OPENCODE_GUTTER_ROW_PATTERN` (Issue #1893) plus the
 * bottom border's `╹`. Those boxes are painted rectangles too — the composer is
 * one at columns 3–78 on every 80-column frame here — and a user whose prompt
 * happened to end in `…  esc` would otherwise be drawing an overlay in the
 * transcript. That is not hypothetical: it is `words-in-response.txt`, this
 * Issue's negative control, whose echoed prompt says all four dialog headings
 * and ends in a hatch.
 *
 * Tested at the column immediately LEFT of the rectangle, because that is where
 * opencode puts the glyph: the gutter is drawn first and the background is
 * switched on after it, so the box's painted interior starts one column to its
 * right (measured — `[(null, 0, 3), ('48;2;30;30;30', 3, 78)]` on every gutter
 * row of `sidebar-off.txt`). The rectangle's own first column is tested too, so
 * a theme that paints the gutter itself is covered by the same rule.
 */
const BOX_GUTTER = /^[│┃╹]/;

/**
 * Every ANSI sequence, in the repository's own spelling.
 *
 * Restated from `ANSI_PATTERN` (`ansi.ts`) rather than imported because this
 * module needs to walk the sequences IN ORDER while counting columns, and that
 * one is a shared `g`-flagged instance whose `lastIndex` a caller must not
 * disturb. `tests/unit/detection-opencode-modal-overlay-2112.test.ts` asserts
 * the text this scan produces is byte-identical to `stripAnsi`'s, so the
 * restatement cannot drift silently.
 */
const ANSI_SEQUENCE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;]*m/g;

/** An SGR sequence, with its parameters. Only these can change the background. */
const SGR_PARAMETERS = /^(?:\x1b\[|\[)([0-9;]*)m$/;

/** A run of columns painted with one background. `null` is the terminal default. */
interface BackgroundSegment {
  readonly bg: string | null;
  /** First column of the run, 0-based inclusive. */
  readonly start: number;
  /** One past the last column of the run. */
  readonly end: number;
}

/** One captured row, measured once. */
interface ScannedRow {
  /** The row with every ANSI sequence removed — identical to `stripAnsi(row)`. */
  readonly text: string;
  /** Background runs across the row, adjacent runs of equal value merged. */
  readonly segments: readonly BackgroundSegment[];
  /** Columns a background boundary sits at, plus the row's own right edge. */
  readonly edges: ReadonlySet<number>;
  /** How many columns the row paints. */
  readonly width: number;
}

/** A background-painted rectangle offering an `esc` hatch. */
export interface OpenCodeModalOverlay {
  /** {@link OPENCODE_MODAL_OVERLAY_ID}. */
  id: typeof OPENCODE_MODAL_OVERLAY_ID;
  /**
   * The header row's own text, trimmed and bounded.
   *
   * The rectangle's columns only, so it reads as the dialog's chrome
   * (`Sessions … esc`) rather than as whatever transcript row it was painted
   * over. **`id` carries the meaning; this carries the proof** — it is a screen
   * excerpt for a human reading `capture --json`, and nothing may branch on it.
   * Branching on the heading is the word-list inference this module exists to
   * replace.
   */
  headerText: string;
  /** Column the rectangle starts at, 0-based inclusive. Diagnostic only. */
  left: number;
  /** Column the rectangle ends at, 0-based exclusive. Diagnostic only. */
  right: number;
  /** How many rows carried it. Diagnostic only. */
  rows: number;
  /** Which of those rows carried the hatch, 0-based. Diagnostic only. */
  headerRow: number;
}

/**
 * Fold one SGR sequence's parameters into the current background.
 *
 * Handles the three forms tmux emits: the 16-colour codes (`40`–`47`,
 * `100`–`107`), the 256-colour and 24-bit extended forms (`48;5;n`,
 * `48;2;r;g;b`), and the two resets (`0`, `49`). Foreground and attribute codes
 * leave the background alone, which is what keeps a syntax-highlighted
 * transcript row from producing dozens of spurious edges.
 */
function applySgr(current: string | null, parameters: string): string | null {
  const parts = (parameters === '' ? '0' : parameters).split(';');
  let bg = current;
  for (let i = 0; i < parts.length; i++) {
    const code = Number(parts[i] === '' ? '0' : parts[i]);
    if (!Number.isFinite(code)) continue;
    if (code === 0 || code === 49) {
      bg = null;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      bg = parts[i];
    } else if (code === 48) {
      if (parts[i + 1] === '2') {
        bg = parts.slice(i, i + 5).join(';');
        i += 4;
      } else if (parts[i + 1] === '5') {
        bg = parts.slice(i, i + 3).join(';');
        i += 2;
      }
    }
  }
  return bg;
}

/** Measure one captured row: its text, its background runs and their edges. */
function scanRow(line: string): ScannedRow {
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
function backgroundAt(row: ScannedRow, column: number): string | null {
  for (const segment of row.segments) {
    if (segment.start <= column && column < segment.end) return segment.bg;
  }
  return null;
}

/**
 * Does this row carry the rectangle `[left, right)`?
 *
 * Four conditions, and every one of them is about the LAYOUT:
 *
 *  1. the row has a background boundary at both edges;
 *  2. every column between them is painted — an unpainted gap means the two
 *    boundaries belong to two different things that happen to line up;
 *  3. the boundaries are real transitions, i.e. what is painted just outside
 *    differs from what is painted just inside. This is what stops a theme that
 *    paints the whole pane from turning every column pair into a rectangle;
 *  4. neither the rectangle's first column nor the column just left of it holds
 *    one of opencode's own box gutters.
 */
function carriesRectangle(row: ScannedRow, left: number, right: number): boolean {
  if (!row.edges.has(left) || !row.edges.has(right)) return false;

  for (const segment of row.segments) {
    if (segment.end <= left || segment.start >= right) continue;
    if (segment.bg === null) return false;
  }

  if (backgroundAt(row, left - 1) === backgroundAt(row, left)) return false;
  if (right < row.width && backgroundAt(row, right) === backgroundAt(row, right - 1)) return false;

  if (BOX_GUTTER.test(sliceColumns(row.text, left - 1, left))) return false;
  return !BOX_GUTTER.test(sliceColumns(row.text, left, right));
}

/**
 * The modal overlay painted over an opencode transcript, or null.
 *
 * Call it only for opencode: the rule is about opencode's own dialog chrome, and
 * every other tool is left exactly as it was (Issue #2112 changes no other
 * tool's detection).
 *
 * The search is seeded from the rows that contain the literal `esc` and never
 * from the frame at large, so the cost is `rows × (background boundaries on a
 * hatch row)²` rather than anything quadratic in the pane. Background boundaries
 * are rare — a foreground-only SGR does not make one — so a 200-row opencode
 * capture typically seeds from a single row with fewer than ten of them.
 *
 * When more than one rectangle qualifies the widest-supported one wins, measured
 * by how many rows carry it: an overlay's own highlighted list item is a
 * rectangle too, and it is drawn on exactly one row.
 *
 * A caveat the seeding makes easy to miss: two identical rows are two entries in
 * `carrying`, so the title-bar check below compares object identity rather than
 * value.
 *
 * @param frame - The capture with its ANSI intact (`capture-pane -e`)
 */
export function detectOpenCodeModalOverlay(frame: string): OpenCodeModalOverlay | null {
  const rows = frame.split('\n').map(scanRow);
  const examined = new Set<string>();
  let best: OpenCodeModalOverlay | null = null;

  for (const row of rows) {
    if (!row.text.includes(ESCAPE_HATCH_WORD)) continue;
    const edges = [...row.edges].sort((a, b) => a - b);

    for (const left of edges) {
      if (left < OPENCODE_OVERLAY_MIN_LEFT) continue;
      for (const right of edges) {
        if (right - left < OPENCODE_OVERLAY_MIN_WIDTH) continue;
        const key = `${left}:${right}`;
        if (examined.has(key)) continue;
        if (!carriesRectangle(row, left, right)) continue;

        const header = sliceColumns(row.text, left, right);
        if (!OVERLAY_ESCAPE_HATCH.test(header)) continue;
        examined.add(key);

        const carrying = rows.filter(candidate => carriesRectangle(candidate, left, right));
        if (carrying.length < OPENCODE_OVERLAY_MIN_ROWS) continue;

        // Identity, not a re-test: `row` is the row whose slice just matched, and
        // asking which position it holds in the rectangle is the whole of the
        // title-bar rule. A second search by text would find the FIRST hatch-
        // shaped row instead, which is a different question.
        const headerRow = carrying.indexOf(row);
        if (headerRow < 0 || headerRow >= OPENCODE_OVERLAY_HEADER_ROW_LIMIT) continue;

        if (best === null || carrying.length > best.rows) {
          best = {
            id: OPENCODE_MODAL_OVERLAY_ID,
            headerText: truncateToByteBudget(
              header.trim(),
              OPENCODE_OVERLAY_EXCERPT_MAX_BYTES,
              OPENCODE_OVERLAY_TRUNCATION_MARKER,
            ),
            left,
            right,
            rows: carrying.length,
            headerRow,
          };
        }
      }
    }
  }

  return best;
}
