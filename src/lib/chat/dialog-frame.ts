/**
 * The slice of a tmux pane the chat surface draws as a dialog card (Issue #2254).
 *
 * Epic #2192's decision 5 said the chat surface would not drive a TUI dialog at
 * all: a selection list, a pager, an unclassified frame or a wait nobody could
 * parse raised a banner and the only offer was "open the terminal". **That
 * decision is withdrawn by this Issue.** The card the banner now sits above is
 * the pane's own last few rows, and this module is the only thing that decides
 * which rows those are.
 *
 * ## Compaction comes BEFORE the tail, and that ordering is the whole module
 *
 * A production pane is `TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT` = 200x1000
 * (`src/config/tmux-pane-config.ts`), and `capture-pane -p -e -S -N -E -`
 * returns every one of those rows whether or not the CLI painted them. Measured
 * on live panes captured for this Issue (see
 * `tests/fixtures/chat-dialog-card-2254/README.md`):
 *
 * | capture                        | rows | rows with content | where the content is |
 * |--------------------------------|------|-------------------|----------------------|
 * | claude 2.1.259 `/model`        | 1000 | 14                | the LAST 14 rows     |
 * | codex 0.151.0 `/model` picker  | 1000 | 25                | the FIRST 32 rows    |
 * | opencode 1.18.27 agent overlay | 1000 | 1000              | everywhere (painted) |
 *
 * The codex row is the one that settles the design. codex is not an
 * alternate-screen tool, so a session that has not yet produced 1000 rows of
 * output leaves the rest of the pane blank BELOW the dialog — a naive
 * `lines.slice(-16)` renders sixteen empty rows and the card is blank at exactly
 * the moment the user needs it. `realtimeSnippet` (the server's last-100-rows
 * window) has the same shape for the same reason, which is why the surface is
 * handed `terminal.output` rather than the snippet.
 *
 * So: collapse first (which DROPS the leading and trailing blank runs outright —
 * rule 2 of {@link compactBlankRuns}), then take the tail of what is left.
 *
 * ## What it does not do
 *
 * Extracting the OPTIONS out of a selection list — turning the picker into rows
 * the surface can render as controls — is Issue #2255, not this module. What it
 * does do, since #2309 and #2326, is decide WHERE a selection list starts on a
 * pane it shares with a transcript, and that reading is delegated per tool (see
 * {@link SELECTION_LIST_FRAME_CROPPERS}) rather than written here. The
 * consequence is still visible on the opencode fixture, where the overlay
 * shares its rows with the sidebar (#2095) and the sidebar comes along —
 * accepted, because the card's job is "you can see it", not "it is parsed".
 *
 * ## Issue #2309: a selection list is not given a tail at all
 *
 * The 12–20 row budget above assumes the dialog itself is short. command-code's
 * `/model` and opencode's pickers are search-type lists tens of rows long with
 * no number keys to jump by (#2297's `shouldOfferOptionNumbers` correctly
 * refuses them one), so arrows plus a 16-row window meant walking blind past
 * whatever the tail slice had already thrown away. `{ selectionList: true }`
 * skips the slice — the card scrolls instead ({@link ChatDialogCard}).
 *
 * ## Issue #2326: "no tail" is not "the whole pane" for an INLINE tool
 *
 * #2309 shipped that with one carve-out, opencode, whose overlay is painted
 * mid-transcript rather than onto a cleared screen. Command Code turned out to
 * be the same shape and was not covered: measured on 2026-09-05 (v1.47.1,
 * 200x1000), a five-turn session with `/model` open gives a 333-row frame of
 * which **256 rows are banner and transcript** and 77 are the picker, so the
 * card drew the conversation and put the picker below the fold. Both tools are
 * now cropped to the dialog's own rows first, by
 * {@link SELECTION_LIST_FRAME_CROPPERS}; a tool that clears its screen
 * (claude), or one whose dialog no cropper recognises, still gets every
 * compacted row exactly as #2309 left it.
 *
 * Pure, synchronous and free of React / DOM, so the rule is testable against raw
 * captures with no renderer.
 */

import { compactBlankRuns, isPaintedPanelRow } from '@/lib/terminal-display-normalize';
import { extractOpenCodeModalOverlayFrame } from '@/lib/detection/opencode-modal-overlay';
import { extractCommandCodeSelectionListFrame } from '@/lib/detection/selection-shape';

/**
 * Fewest rows the card may be asked for.
 *
 * Issue #2254 specifies 12–20 rows. The floor matters because the shortest
 * dialog measured for this Issue — codex's directory-trust picker — is 6 rows of
 * question plus 2 options plus its footer, and a card that cut into the question
 * would be worse than no card.
 */
export const DIALOG_FRAME_MIN_LINES = 12;

/**
 * Most rows the card may be asked for.
 *
 * The ceiling is the phone's, not the desktop's: this strip is `shrink-0` and
 * every row it takes comes out of the transcript (Issue #2106's vertical
 * budget). 20 rows covers claude's `/model` overlay (14 rows of content) and
 * codex's 7-model picker (12 rows) whole.
 */
export const DIALOG_FRAME_MAX_LINES = 20;

/** Rows a caller gets when it expresses no preference. */
export const DIALOG_FRAME_DEFAULT_LINES = 16;

export interface DialogFrameTailOptions {
  /**
   * How many rows to keep, clamped into
   * [{@link DIALOG_FRAME_MIN_LINES}, {@link DIALOG_FRAME_MAX_LINES}].
   *
   * Clamped rather than validated because the value comes from a component prop
   * on a surface that must never fail to render: an out-of-range number is a
   * caller bug worth bounding, not worth throwing over. Ignored when
   * {@link DialogFrameTailOptions.selectionList} is set — see there.
   */
  maxLines?: number;
  /**
   * This frame is a selection list (Issue #2309): skip the tail slice and
   * return every compacted content row instead of the last `maxLines`.
   *
   * The row budget this module was built around assumes the dialog is a few
   * lines of question-plus-options sitting in an otherwise blank pane. A
   * search-type picker breaks that assumption outright — command-code's
   * `/model` is 89 rows of provider-grouped model names with no numbers to
   * jump by (`tests/fixtures/chat-dialog-card-2254/command-code-model-1-40-1.txt`)
   * — and slicing it to 12–20 rows before the card ever renders threw away
   * everything past the last screenful, leaving the arrow keys to walk blind
   * past rows the card had already discarded. The card scrolls the box
   * instead ({@link ChatDialogCard}), so there is no row budget left to keep.
   *
   * An INLINE tool is the exception within the exception (Issue #2326): it
   * paints the dialog over the transcript rather than clearing the pane, so
   * "everything left after compaction" would still drag the conversation
   * along with it — 256 of 333 rows on the Command Code capture, and the
   * conversation on both sides of the dialog on opencode's. When one of
   * {@link SELECTION_LIST_FRAME_CROPPERS} recognises the frame, its row span
   * is used instead of the whole compacted frame.
   */
  selectionList?: boolean;
}

/**
 * The per-tool "where does this dialog start" readings, tried in order.
 *
 * ## Why a list and not two `if`s (Issue #2326)
 *
 * #2309 shipped one carve-out — opencode, which paints its overlay over the
 * transcript rather than clearing the pane — as a single inline branch, on the
 * reading that it was the exception. Issue #2326 measured the second one:
 * Command Code is inline too (`alternate_on=0`), so a five-turn session with
 * `/model` open gives the card a 333-row frame of which 256 rows are banner and
 * transcript. Two exceptions with the same shape are a rule, and a third `if`
 * inside {@link extractDialogFrameTail} would put the tool-specific reading in
 * the module whose docblock says it does no per-tool detection.
 *
 * So the tool-specific part lives in `lib/detection` — {@link
 * extractOpenCodeModalOverlayFrame} reads opencode's painted rectangle,
 * {@link extractCommandCodeSelectionListFrame} reads Command Code's rule-to-
 * footer seam — and what stays here is the policy: try each, take the first
 * that yields rows, otherwise keep every compacted row exactly as before.
 *
 * Order is not load-bearing today and is not free to ignore either: the two
 * signatures are disjoint on every capture in `tests/fixtures` (opencode's
 * needs a background-painted rectangle with an `esc` hatch inside it, which
 * Command Code never draws; Command Code's needs a full-width rule row above
 * its footer, which opencode's box borders are not), and
 * `dialog-frame-2326.test.ts` re-derives that across all of them so a future
 * cropper cannot quietly start shadowing an earlier one.
 */
const SELECTION_LIST_FRAME_CROPPERS: readonly ((frame: string) => string | null)[] = [
  extractOpenCodeModalOverlayFrame,
  extractCommandCodeSelectionListFrame,
];

/** Clamp into the [MIN, MAX] window, mapping a non-finite value to the default. */
function resolveMaxLines(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DIALOG_FRAME_DEFAULT_LINES;
  const truncated = Math.trunc(requested);
  if (truncated < DIALOG_FRAME_MIN_LINES) return DIALOG_FRAME_MIN_LINES;
  if (truncated > DIALOG_FRAME_MAX_LINES) return DIALOG_FRAME_MAX_LINES;
  return truncated;
}

/**
 * The rows of `frame` the dialog card should draw.
 *
 * ANSI is PRESERVED, unchanged, in the returned string. The card renders it
 * through the same `sanitizeTerminalOutput()` the terminal surface uses, and
 * dropping the escapes here would take the selection highlight with them — on
 * claude's `/model` overlay the marked row is `ESC[38;5;153m❯` and on codex's
 * picker the current option is the only bold row, so a stripped card cannot say
 * which option is selected. Blank-run collapsing carries the escapes of the rows
 * it drops onto the row it keeps ({@link compactBlankRuns} rule 4), so colour
 * state spanning a collapsed gap still applies.
 *
 * @param frame - a raw `capture-pane -p -e` frame (`PaneTerminalState.output`)
 * @returns the tail rows, ANSI intact, or `''` when there is nothing to show
 */
export function extractDialogFrameTail(
  frame: string | null | undefined,
  options: DialogFrameTailOptions = {},
): string {
  if (!frame) return '';

  // tmux emits LF; a CRLF frame would otherwise leave a stray CR at the end of
  // every row, which `<pre>` renders as a zero-width nuisance and which would
  // make a row that is blank apart from the CR count as content.
  const normalized = frame.replace(/\r\n/g, '\n');

  // Issues #2309 / #2326: an inline tool's dialog is cropped to its own rows
  // BEFORE compaction runs, on the un-compacted frame — the row spans the
  // croppers return are measured against the original line numbers, and
  // compacting first would shift rows elsewhere in the pane out from under
  // that measurement. Detection needs the SGR the capture was taken with
  // (never a stripped frame), which `normalized` still is at this point.
  //
  // A cropper that returns `null`, or one whose crop compacts away to nothing,
  // hands the frame to the next one and finally to the whole-frame path below:
  // a card showing too much is Issue #2326's defect, and a card showing
  // nothing is worse than the defect.
  if (options.selectionList) {
    for (const crop of SELECTION_LIST_FRAME_CROPPERS) {
      const cropped = crop(normalized);
      if (cropped === null) continue;
      const compactedCrop = compactBlankRuns(cropped, { isStructuralRow: isPaintedPanelRow });
      if (compactedCrop !== '') return compactedCrop;
    }
  }

  // Issue #2049's predicate, not #1172's bare rule: opencode paints its overlay
  // panel with background-only rows that carry no glyphs, and collapsing those
  // deletes the panel's top band and its section separators — the exact rows
  // that make the card legible as a dialog.
  const compacted = compactBlankRuns(normalized, { isStructuralRow: isPaintedPanelRow });
  if (compacted === '') return '';

  // Issue #2309: a selection list keeps every compacted row — see
  // {@link DialogFrameTailOptions.selectionList}.
  if (options.selectionList) return compacted;

  const lines = compacted.split('\n');
  const maxLines = resolveMaxLines(options.maxLines);
  return lines.slice(-maxLines).join('\n');
}

/**
 * Would {@link extractDialogFrameTail} produce anything to draw?
 *
 * Exists so a caller can decide whether to mount the card at all without
 * building the string twice, and so "the flags say a dialog is up but the pane
 * is empty" (a pane captured between frames, or a session that just died) shows
 * the banner alone rather than an empty black box.
 */
export function hasDialogFrame(frame: string | null | undefined): boolean {
  return extractDialogFrameTail(frame) !== '';
}
