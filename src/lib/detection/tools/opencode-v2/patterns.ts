/**
 * OpenCode V2 pattern constants moved out of `../../cli-patterns.ts`
 * (Issue #3217 I-3). `cli-patterns.ts` re-exports every public name.
 */

import { PASTED_TEXT_PATTERN } from '../../shared/pasted-text';
import {
  findOpenCodeChromeStart,
  OPENCODE_COMPOSER_BOTTOM_BORDER,
  OPENCODE_SEPARATOR_PATTERN,
} from '../opencode/patterns';

// =============================================================================
// OpenCode V2 (`opencode2`, Issue #2934)
// =============================================================================
//
// A separate tool id from `opencode` (Epic #2370, decision 1). Its TUI is drawn
// by the same toolkit and many rows look alike, but v1's constants are v1's:
// they are left exactly as they are, and v2 names its own here so a change on
// either side cannot move the other. Phase 1 reads only what the send path and
// the fallback status reader need; the approval dialog (`Always allow`, the
// reverse of v1's `Allow always`), the completion row and the session tabs are
// Phase 3's.

/**
 * OpenCode V2's empty composer: the input box's `┃` gutter with the
 * `Ask anything…` placeholder on the same row (2.0.18 draws U+2026; the ASCII
 * `...` is accepted too, as for v1 since #2915).
 *
 * Measured on 2.0.18 at 80x200 (2026-09-28):
 * `   ┃  Ask anything… "Fix broken tests"`. Match against the ANSI-stripped
 * frame BEFORE `stripBoxDrawing`, which removes the gutter this anchors on.
 *
 * Read by position (Issue #4188): the placeholder row, then only gutter rows (the
 * blank row and the agent/model row), then the composer's bottom border `╹▀▀▀…` —
 * the box as every frame under `tests/fixtures/opencode-v2*` that draws the
 * placeholder draws it. The gutter alone does not say "composer": the transcript
 * echoes each sent message in the same `┃` box, so a message that began with
 * `Ask anything…` put a placeholder on the pane and an empty input box with it,
 * for the send path's composer check, the `ready` branch and liveness alike. The
 * echo block ends in a non-gutter row (the reply, or a blank row), never the border.
 *
 * Read by {@link findOpencodeV2IdleComposer}, one pass over the rows: each border
 * walks up its own run of gutter rows, and the runs do not overlap (a border row is
 * not a gutter row), so the work is linear in the rows. The multi-line regular
 * expression it replaces retried from every gutter row, which a pane of `┃  Ask
 * anything…` rows with no border under them made quadratic (Issue #4188 review).
 *
 * Kept a `RegExp` because two readers outside this module take regular
 * expressions only — liveness's `alivePatterns` (`readonly RegExp[]`,
 * `src/types/cli-tool-contracts.ts`) and `getCliToolPatterns().promptPattern` — and
 * they must read the same rule as the send path's composer check and the `ready`
 * branch. A subclass whose `exec` is that pass gives all three one reader: `test`,
 * `match` and `replace` go through `exec`. `source` still spells the rule.
 */
export const OPENCODE_V2_IDLE_COMPOSER_PATTERN: RegExp = new (class OpencodeV2IdleComposerPattern extends RegExp {
  static get [Symbol.species](): RegExpConstructor {
    return RegExp;
  }

  constructor() {
    super(
      '^[^\\S\\n]*[\\u2502\\u2503][^\\S\\n]*Ask anything(?:\\.\\.\\.|\\u2026)[^\\n]*\\n(?:[^\\S\\n]*[\\u2502\\u2503][^\\n]*\\n)*[^\\S\\n]*\\u2579\\u2580{4,}',
      'm'
    );
  }

  override exec(text: string): RegExpExecArray | null {
    const found = findOpencodeV2IdleComposer(text);
    if (!found) return null;
    const match = [text.slice(found.start, found.end)] as unknown as RegExpExecArray;
    match.index = found.start;
    match.input = text;
    return match;
  }
})();

/** The placeholder at the start of a gutter row (Issue #2934). */
const IDLE_COMPOSER_PLACEHOLDER_ROW = /^[^\S\n]*[\u2502\u2503][^\S\n]*Ask anything(?:\.\.\.|\u2026)/;
/** A row of one of the `┃` boxes. */
const IDLE_COMPOSER_GUTTER_ROW = /^[^\S\n]*[\u2502\u2503]/;
/** The composer's bottom border, as the match ends on it. */
const IDLE_COMPOSER_BORDER_ROW = /^[^\S\n]*\u2579\u2580{4,}/;

/**
 * The empty composer of {@link OPENCODE_V2_IDLE_COMPOSER_PATTERN}, by position, in
 * one pass (Issue #4188): the first placeholder row whose gutter run reaches a
 * bottom border, as character offsets from the placeholder row's start to the end
 * of the border's `▀` run; or null.
 *
 * @param text - ANSI-stripped capture, box drawing intact
 * @returns The match's `[start, end)` in `text`, or null
 */
export function findOpencodeV2IdleComposer(text: string): { start: number; end: number } | null {
  const rows = text.split('\n');
  const offsets: number[] = new Array(rows.length);
  let offset = 0;
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = offset;
    offset += rows[i].length + 1;
  }
  for (let border = 1; border < rows.length; border++) {
    const borderMatch = IDLE_COMPOSER_BORDER_ROW.exec(rows[border]);
    if (!borderMatch) continue;
    // Walk up the gutter run over this border, once; the topmost placeholder
    // row in it is where the match starts.
    let placeholder = -1;
    for (let j = border - 1; j >= 0 && IDLE_COMPOSER_GUTTER_ROW.test(rows[j]); j--) {
      if (IDLE_COMPOSER_PLACEHOLDER_ROW.test(rows[j])) placeholder = j;
    }
    if (placeholder >= 0) {
      return { start: offsets[placeholder], end: offsets[border] + borderMatch[0].length };
    }
  }
  return null;
}

/**
 * OpenCode V2's footer, which ends in `ctrl+p commands` on every frame the
 * TUI draws (before a turn: `<path>:<branch>  shift+tab agents  ctrl+p commands`;
 * after one: `<path>:<branch>  8.8K (1%)  ctrl+p commands`, 2.0.18).
 *
 * Proof that the TUI — and so its composer — is on screen, NOT that it is idle:
 * a running turn keeps the footer.
 *
 * Read by position (Issue #4175): the footer is the row right under the composer's
 * bottom border (`╹▀▀▀…`), on every frame under `tests/fixtures/opencode-v2*` —
 * pinned to the bottom of a session frame, under the centred composer on the
 * boot screen (row 106 of 200, with `2.0.18` below it). The words alone were
 * matched before, so a reply saying `ctrl+p commands` put the composer on a
 * frame that had none (the approval dialog replaces it) and made a frame with
 * no footer `ready`. The row ends in the words, or in them and the sidebar's
 * column two spaces later (`tests/fixtures/opencode-v2-usage-2981/`).
 *
 * Match against the ANSI-stripped text with its box drawing intact: the border is
 * the anchor. For a reader that sees one row at a time, {@link isOpencodeV2FooterRowAt}.
 */
export const OPENCODE_V2_FOOTER_PATTERN =
  /^[^\S\n]*\u2579\u2580{4,}[^\n]*\n[^\n]*ctrl\+p commands(?:[^\S\n]{2}[^\n]*)?[^\S\n]*$/m;

/** The end of the footer's row: the words, then nothing or the sidebar's column. */
const FOOTER_ROW_END_PATTERN = /ctrl\+p commands(?:[^\S\n]{2}[^\n]*)?[^\S\n]*$/;

/**
 * Whether `rows[index]` is the footer, by {@link OPENCODE_V2_FOOTER_PATTERN}'s rule:
 * the row under the composer's bottom border, ending as the footer ends.
 *
 * @param rows - ANSI-stripped rows, box drawing intact
 * @param index - The row to ask about
 */
export function isOpencodeV2FooterRowAt(rows: readonly string[], index: number): boolean {
  return (
    index > 0 &&
    index < rows.length &&
    OPENCODE_COMPOSER_BOTTOM_BORDER.test(rows[index - 1]) &&
    FOOTER_ROW_END_PATTERN.test(rows[index])
  );
}

/**
 * OpenCode V2 working indicator: the footer's `esc interrupt` hint, drawn only
 * while a turn is running (2.0.18). After one Esc it reads `esc again to interrupt`
 * and the reply keeps being written (measured, Issue #4161), as V1's does (#1894).
 *
 * Read by position, because a reply can say those words and can even quote the
 * whole row (Issue #4161): the hint has to be on the LAST non-blank row of the text,
 * where the TUI pins its footer on a session frame, so no `m` flag. On that row it
 * is followed by the footer's columns, two spaces apart: `   ⬝⬝⬝⬝■■■■ esc interrupt
 *     shift+tab agents  ctrl+p commands`. A pane wide enough for the sidebar draws
 * one more column after `ctrl+p commands` (`tests/fixtures/opencode-v2-usage-2981/`).
 *
 * Every reader hands over the bottom of the frame. Not for a reader that sees one row
 * at a time, where each row is the last one: the extraction cuts the footer off by
 * position instead ({@link findOpencodeV2ChromeStart}, Issue #4175). Confirmed on the
 * 80-column footers measured for #4175 (`tests/fixtures/opencode-v2-live-4175/`).
 */
export const OPENCODE_V2_THINKING_PATTERN =
  /(?:^|\s)esc (?:again to )?interrupt[^\S\n]{2,}(?:[^\n]*[^\S\n]{2})?ctrl\+p commands(?:[^\S\n]{2}[^\n]*)?\s*$/;

/**
 * The footer as one row, by its column (Issue #4161): 2.0.18 starts the footer in
 * column 2 or 3 and a reply's text in column 5 (every frame under
 * `tests/fixtures/opencode-v2*`).
 *
 * Issue #4175: no longer in the skip list. The extraction cuts the footer off with
 * the rest of the chrome ({@link findOpencodeV2ChromeStart}), so the column is read
 * only where that finds no composer — and there only on the last row of the frame.
 */
export const OPENCODE_V2_FOOTER_ROW_PATTERN =
  /^[^\S\n]{0,4}\S[^\n]*ctrl\+p commands(?:[^\S\n]{2}[^\n]*)?$/;

/**
 * Whether OpenCode V2's composer is on screen, so a send may type into it
 * (Issue #2934, D6): the gutter-anchored placeholder inside the box over the
 * composer's border (Issue #4188: not a transcript echo starting with the phrase),
 * or the footer under that border (Issue #4175: not the words anywhere on the pane).
 *
 * @param text - ANSI-stripped capture, box drawing intact
 */
export function isOpencodeV2ComposerVisible(text: string): boolean {
  return findOpencodeV2IdleComposer(text) !== null || OPENCODE_V2_FOOTER_PATTERN.test(text);
}

/**
 * Where OpenCode V2's bottom-pinned chrome starts — the composer box (or the dialog
 * drawn in its place), its border and the footer — or -1 (Issue #4175).
 *
 * V1's reader ({@link findOpenCodeChromeStart}): the same toolkit draws the same box,
 * `┃` gutter rows over a `╹▀▀▀` border with the footer under it, on every frame under
 * `tests/fixtures/opencode-v2*`, and the approval and question forms run their gutter
 * to the last row as V1's dialog does. Without it the extraction knew the footer only
 * by its column ({@link OPENCODE_V2_FOOTER_ROW_PATTERN}) and the composer's rows went
 * into the reply. When it finds nothing, the footer as the last non-blank row.
 *
 * @param lines - ANSI-stripped rows, box drawing intact
 * @returns Index of the first chrome row, or -1
 */
export function findOpencodeV2ChromeStart(lines: string[]): number {
  const structural = findOpenCodeChromeStart(lines);
  if (structural >= 0) return structural;
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  return last >= 0 && OPENCODE_V2_FOOTER_ROW_PATTERN.test(lines[last]) ? last : -1;
}

/**
 * The composer's placeholder row, on the composer's `┃` gutter (Issue #4175). The
 * skip list held `/Ask anything(?:\.\.\.|\u2026)/`, which dropped any row of a reply
 * with those words. One row at a time, so no `m` flag.
 */
const OPENCODE_V2_PLACEHOLDER_ROW_PATTERN = /^[^\S\n]*[\u2502\u2503][^\S\n]*Ask anything(?:\.\.\.|\u2026)/;

/**
 * OpenCode V2 rows that are chrome, never reply content.
 *
 * Issue #4175: the footer and the placeholder are matched on their own rows only —
 * the chrome is cut off before this list is read ({@link findOpencodeV2ChromeStart}),
 * so what reaches it is the transcript, where those words are a reply's.
 */
export const OPENCODE_V2_SKIP_PATTERNS: readonly RegExp[] = [
  OPENCODE_SEPARATOR_PATTERN,
  OPENCODE_V2_PLACEHOLDER_ROW_PATTERN,
  /^Build\s+·/,
  PASTED_TEXT_PATTERN,
] as const;
