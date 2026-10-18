/**
 * agy 1.4's `/model` picker, read for the prompt observation (Issue #3797).
 *
 * agy 1.4 draws the picker with a search box between the `Switch Model` header
 * and the model rows, and keeps the composer ABOVE it:
 *
 * ```
 * >
 * ────────────────
 * Switch Model
 *
 *   Search: claude
 *           ────────────────────
 *
 * > Claude Opus 5.5
 *   Claude Sonnet 5.5
 *
 *   Effort  ◂        ●━━━━━━━━━━━━━━◉──────────────○        ▸
 *                   low          medium          high
 *             Balanced speed and reasoning quality for most tasks
 *
 * Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Clear search
 * ```
 *
 * (measured: `tests/fixtures/prompt-observation-3797/antigravity-model-picker-1.4.2*.txt`,
 * agy 1.4.2, 200x1000). The 1.1.27 reader (`detection/tools/antigravity/screens.ts`)
 * takes the first rows under the header as the model list, finds `Search:`
 * and the underline with no highlight among them, and gives up — so the
 * screen came out `unknown` (#3773 D, #3788 3). That reader sits outside this
 * Issue's scope, and it is not the status detector's either; this one is read
 * only when it returned null.
 *
 * ## Identified only by its whole shape
 *
 * Every part below must be on the frame, in this order, or the frame is not
 * the picker (and stays whatever `classifyScreen` reads it as — `unknown`
 * while something waits):
 *
 * 1. the footer `Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back`
 *    (or `esc Clear search` while a query is typed), whole on one row — a
 *    footer folded by a narrow pane is not read;
 * 2. under the footer only blank rows and agy's right-aligned model status
 *    row — a picker quoted in a reply, or left in the scrollback above a live
 *    composer, has other rows under it;
 * 3. above it, within {@link PICKER_MAX_ROWS}: `Switch Model`, blank rows, the
 *    `Search:` row, the search underline, blank rows, the model rows (up to a
 *    blank row, exactly one of them wearing the `>`), a blank row, and the
 *    `Effort` row.
 *
 * A search that matches nothing (`No models match "…"`, footer
 * `Keyboard: esc Clear search`) has no rows to choose and no `↑/↓ Navigate`,
 * so it is not read here: it stays `unknown`.
 *
 * ## Input contract
 *
 * ANSI-stripped text.
 *
 * @module lib/prompt-observation/antigravity-model-picker
 */

/** The picker's footer, whole. agy 1.4.2 swaps `Go Back` for `Clear search` while a query is typed. */
const PICKER_FOOTER_PATTERN =
  /^\s*Keyboard:\s+↑\/↓\s+Navigate\s+←\/→\s+Effort\s+enter\s+Select\s+esc\s+(?:Go Back|Clear search)\s*$/;

/** The picker's header. Same wording as `ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN`. */
const PICKER_HEADER_PATTERN = /^\s*Switch Model\s*$/;

/** The search box: `Search:` and the query typed so far (possibly none). */
const SEARCH_ROW_PATTERN = /^\s*Search:(?:\s.*)?$/;

/** The rule agy draws under the search box. */
const SEARCH_UNDERLINE_PATTERN = /^\s*─+\s*$/;

/** The effort slider, the first row under the model rows. */
const EFFORT_ROW_PATTERN = /^\s*Effort\b/;

/** The highlighted model row: `> label`. */
const HIGHLIGHTED_ROW_PATTERN = /^\s*>\s+(\S.*)$/;

/** agy's model status row under a screen's footer: drawn flush right, far from the left edge. */
const STATUS_ROW_PATTERN = /^ {40,}\S/;

/**
 * How far above the footer the header may sit. The measured picker spans 16
 * rows with five models; agy 1.4.2 lists five.
 */
const PICKER_MAX_ROWS = 30;

/** How many rows the slider block (slider, its scale, the effort's description, a blank) may take. */
const EFFORT_BLOCK_MAX_ROWS = 6;

/** What the picker shows. */
export interface AntigravityModelPicker {
  /** `Switch Model`, as drawn. */
  readonly question: string;
  /** The model rows in draw order, highlight removed, runs of spaces folded. */
  readonly options: readonly string[];
  /** Index into {@link options} of the highlighted row. */
  readonly selectedIndex: number;
}

const isBlank = (row: string): boolean => row.trim() === '';

/** A label as drawn: highlight removed, runs of spaces folded, ends trimmed. */
function labelOf(row: string): string {
  return row.replace(/^\s*>\s+/, '').replace(/\s{2,}/g, ' ').trim();
}

/** Index of the picker footer when it is the last thing drawn, or -1. */
function liveFooter(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isBlank(lines[i]) || STATUS_ROW_PATTERN.test(lines[i])) continue;
    return PICKER_FOOTER_PATTERN.test(lines[i]) ? i : -1;
  }
  return -1;
}

/**
 * Read agy 1.4's `/model` picker when it is the screen open on this frame, or
 * null — see the module comment for what must be on the frame.
 *
 * @param text - ANSI-stripped frame
 */
export function readAntigravityModelPicker(text: string): AntigravityModelPicker | null {
  const lines = text.split('\n').map(row => row.trimEnd());
  const footer = liveFooter(lines);
  if (footer < 0) return null;

  const floor = Math.max(0, footer - PICKER_MAX_ROWS);
  let header = -1;
  for (let i = footer - 1; i >= floor; i--) {
    if (PICKER_HEADER_PATTERN.test(lines[i])) {
      header = i;
      break;
    }
  }
  if (header < 0) return null;

  let row = header + 1;
  while (row < footer && isBlank(lines[row])) row++;
  if (row >= footer || !SEARCH_ROW_PATTERN.test(lines[row])) return null;
  row++;
  if (row >= footer || !SEARCH_UNDERLINE_PATTERN.test(lines[row])) return null;
  row++;
  while (row < footer && isBlank(lines[row])) row++;

  const options: string[] = [];
  let selectedIndex = -1;
  for (; row < footer && !isBlank(lines[row]); row++) {
    if (EFFORT_ROW_PATTERN.test(lines[row])) return null;
    if (HIGHLIGHTED_ROW_PATTERN.test(lines[row])) {
      if (selectedIndex >= 0) return null;
      selectedIndex = options.length;
    }
    options.push(labelOf(lines[row]));
  }
  if (options.length === 0 || selectedIndex < 0) return null;

  while (row < footer && isBlank(lines[row])) row++;
  if (row >= footer || !EFFORT_ROW_PATTERN.test(lines[row])) return null;
  if (footer - row > EFFORT_BLOCK_MAX_ROWS) return null;

  return { question: lines[header].trim(), options, selectedIndex };
}
