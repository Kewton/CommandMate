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
 * No per-tool "where does this dialog start" detection. Issue #2254 is explicit
 * that the first cut is N rows off the end and nothing cleverer; extracting the
 * OPTIONS out of a selection list is Issue #2255. The consequence is visible on
 * the opencode fixture, where the overlay shares its rows with the sidebar
 * (#2095) and the sidebar comes along — accepted, because the card's job is
 * "you can see it", not "it is parsed".
 *
 * Pure, synchronous and free of React / DOM, so the rule is testable against raw
 * captures with no renderer.
 */

import { compactBlankRuns, isPaintedPanelRow } from '@/lib/terminal-display-normalize';

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
   * caller bug worth bounding, not worth throwing over.
   */
  maxLines?: number;
}

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

  // Issue #2049's predicate, not #1172's bare rule: opencode paints its overlay
  // panel with background-only rows that carry no glyphs, and collapsing those
  // deletes the panel's top band and its section separators — the exact rows
  // that make the card legible as a dialog.
  const compacted = compactBlankRuns(normalized, { isStructuralRow: isPaintedPanelRow });
  if (compacted === '') return '';

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
