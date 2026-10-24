/** Approval-context boundary logic split out of prompt-detect-multiple-choice.ts (Issue #3866). */

import type { ApprovalTargetCompleteness } from '@/types/prompt-reading';

/**
 * Pattern for separator lines (horizontal rules).
 * Matches lines consisting only of dash (-) or em-dash (─) characters.
 * Used to skip separator lines in question extraction and non-option line handling.
 * Anchored at both ends -- ReDoS safe (S4-001).
 */
export const SEPARATOR_LINE_PATTERN = /^[-─]+$/;

/**
 * Lines that mean "the previous turn ended here" when scanning upward.
 *
 * Every supported CLI renders its transcript as marker-prefixed rows — Claude's
 * tool-use `⏺` and result `⎿`, Codex's activity `•`, its approval receipts `✔`
 * / `✗`, the user's own `›` / `❯` / `>` echo, and its output continuation `└`.
 * The lines a prompt panel puts above its question (a header such as "Bash
 * command", the command itself, a one-line description) never carry one, which
 * is what makes this usable as the panel's upper edge after `stripBoxDrawing`
 * has erased the real box border.
 *
 * Horizontal rules count too: Codex draws one between turns.
 *
 * [Issue #3817] Not inside the panel's own frame: the command a panel shows can
 * carry the same glyphs (a here-document's `> quoted` rows), drawn deeper than
 * the panel's header, question and option rows. See
 * {@link findApprovalContextStart}.
 *
 * Anchored at the start of the trimmed line — ReDoS safe (no repetition).
 */
const TURN_BOUNDARY_PATTERN =
  /^[⏺⎿●○•✔✓✖✗✘›»❯└├>]/;

/**
 * How far above the question the approval context may reach (Issue #1699).
 *
 * The boundary marker above is the actual fix; this cap only exists so a frame
 * that happens to contain no marker at all (a bare shell `(y/n)` prompt under
 * plain command output) cannot drag an unbounded scrollback window into the
 * deny surface the way the old fixed 19-line lookback did. Sized for the
 * tallest real permission panel measured: header + blank + a wrapped multi-line
 * command + description + blank.
 */
export const APPROVAL_TARGET_MAX_LOOKBACK = 12;

/**
 * A previous tool call's result row (Issue #3817): claude's `⎿`, codex's `└` /
 * `├` output continuation. Never the user's echo or a quote (`>`).
 */
const RESULT_MARKER_PATTERN = /^[⎿└├]/;

/** Width of a row's leading whitespace. */
export function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The column the dialog's own frame is drawn at (Issue #3817): the least
 * indented non-blank row from the question down to `panelEnd`. Those rows are
 * the question, the option block and the footer — claude puts them at column 1
 * and the command at column 3, codex its `› 1.` cursor at column 0.
 */
export function panelFrameIndent(lines: string[], questionLineIndex: number, panelEnd: number): number {
  let indent = Infinity;
  for (let i = questionLineIndex; i < Math.min(panelEnd, lines.length); i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    indent = Math.min(indent, indentOf(line));
  }
  return indent === Infinity ? 0 : indent;
}

/** True when this line carries a transcript marker or is a rule. */
function isTurnBoundaryLine(rawLine: string | undefined): boolean {
  if (rawLine === undefined) return false;
  const line = rawLine.trim();
  if (line === '') return false;
  return TURN_BOUNDARY_PATTERN.test(line) || SEPARATOR_LINE_PATTERN.test(line);
}

/**
 * First line index that still belongs to *this* prompt, scanning upward.
 *
 * Walks up from `questionLineIndex - 1` and stops just below the nearest turn
 * boundary; with no boundary in reach it falls back to the lookback cap.
 * Everything above the returned index is a previous turn and must never reach a
 * deny pattern — that poisoning is Issue #1699.
 *
 * [Issue #3817] A marker row indented deeper than the dialog's frame
 * ({@link panelFrameIndent}) is the body of the command the panel asks about
 * when a frame row sits above it — the `> quoted` rows of a here-document
 * under a claude panel's ` Bash command` header. Cutting there took the command
 * rows above it out of the deny surface. The previous turn's markers are drawn
 * at or left of the frame (`⏺`, the user's `> msg` / `❯ msg` echo, a rule), or
 * deeper with no frame row above them (claude's `  ⎿` result right under its
 * `⏺`), and both still end the scan.
 *
 * A frame row cannot be told from a body row drawn at the frame's column (a
 * shell here-document's `EOF`), so a frame row is taken as an older panel's
 * header only in one shape: a tool-use block — a marker row at the frame's
 * column, then that row, then deeper rows that are all result markers
 * ({@link RESULT_MARKER_PATTERN}). Anything else between two frame rows is read
 * as body: when the screen cannot tell, the deny surface is taken wide.
 *
 * [Issue #3832] That shape also needs the older header to be one the current
 * panel draws below it (agy's `Command` above `  ⎿ User declined the tool
 * call` above its current `Command`). A body can take the shape too — a
 * 0-column command whose output is an indented `└──` tree, under a `●` row —
 * and cutting there dropped the command from the deny surface. A body that
 * repeats the current header word for word is still cut; the screen cannot
 * tell that one apart.
 *
 * Known limits, measured absent on the claude / codex / agy / copilot /
 * opencode fixtures and the production log (Issue #3832) and left alone:
 * - An older block's result with a row that is not a result marker (an
 *   unmarked continuation `     b` under `  ⎿ a`) under a header the current
 *   panel repeats is read as body: the previous turn enters the deny surface
 *   (over-suppresses).
 * - A body row carrying a marker at the frame's own column (a here-document's
 *   `> ` drawn at column 0 under a yes/no `(y/n)`) still ends the scan; the
 *   screen cannot tell it from the previous turn's echo. The command rows
 *   above the `> ` leave `approvalTarget`, and a yes/no `question` is the
 *   prompt line alone. Issue #3881 (the second half) no longer lets that be
 *   an answer: the yes/no path ({@link findYesNoApprovalContextRange}) reads
 *   a scan that stopped on a `>` row as `truncated`, so a deny miss withholds
 *   instead of passing. The boundary itself is left where it was.
 * - agy's older panel under a header the current one does not draw is read as
 *   body (over-suppresses), as is the first limit above; both stay.
 *
 * Shared by both detector paths: multiple_choice passes its `questionEndIndex`,
 * yes_no the line its pattern matched on.
 *
 * @param lines - Full frame, already ANSI/box stripped
 * @param questionLineIndex - Line the prompt's own question sits on
 * @param panelEnd - Exclusive end of the dialog's own rows (Issue #3817); their
 *   least indented row is the frame. Defaults to the question row alone.
 * @returns Index of the first line of the current prompt's own block
 */
export function findApprovalContextStart(
  lines: string[],
  questionLineIndex: number,
  panelEnd: number = questionLineIndex + 1,
): number {
  return findApprovalContextRange(lines, questionLineIndex, panelEnd).start;
}

/**
 * Where {@link findApprovalContextStart} put the top of the approval context,
 * and whether that top is a boundary (Issue #3881, H-3).
 *
 * The start index alone cannot say it. A scan that runs out at
 * {@link APPROVAL_TARGET_MAX_LOOKBACK} returns the same kind of number as one
 * that stopped at the previous turn's marker, and `joinApprovalTarget` turns
 * either into an ordinary string — so a deny pattern whose only match is the
 * 13th row above a yes/no question missed, and the resolver took the miss as
 * a pass. The completeness travels with the start instead:
 *
 * - `complete` — the scan stopped at a boundary (a marker at the frame, an
 *   older tool-use block);
 * - `truncated` — it ran out at the cap with a non-blank row still above it;
 * - `top-unknown` — it reached the frame's first row without a boundary.
 *
 * A scan that ran out at the cap over blank rows only is `complete`: nothing
 * above it could belong to the panel.
 */
export function findApprovalContextRange(
  lines: string[],
  questionLineIndex: number,
  panelEnd: number = questionLineIndex + 1,
): ApprovalContextRange {
  const { start, completeness } = scanApprovalContext(lines, questionLineIndex, panelEnd);
  return { start, completeness };
}

/** {@link findApprovalContextRange}, with the row the scan stopped on (Issue #3881). */
function scanApprovalContext(
  lines: string[],
  questionLineIndex: number,
  panelEnd: number,
): ApprovalContextScan {
  const floor = Math.max(0, questionLineIndex - APPROVAL_TARGET_MAX_LOOKBACK);
  const frameIndent = panelFrameIndent(lines, questionLineIndex, panelEnd);
  // The lowest deeper marker row with no frame row found above it yet.
  let unenclosed = -1;
  // The deeper rows since the last frame row: are they all result markers?
  let segmentRows = 0;
  let segmentAllResults = true;
  // Frame rows already passed: the current panel's header among them.
  const framesBelow = new Set<string>();
  for (let i = questionLineIndex - 1; i >= floor; i--) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    const atFrame = indentOf(line) <= frameIndent;
    const marker = isTurnBoundaryLine(line);
    if (marker && atFrame) {
      return { start: (unenclosed >= 0 ? unenclosed : i) + 1, completeness: 'complete', boundaryRow: i };
    }
    if (!atFrame) {
      if (marker && unenclosed < 0) unenclosed = i;
      segmentRows++;
      segmentAllResults &&= RESULT_MARKER_PATTERN.test(line.trim());
      continue;
    }
    // A frame row: an older tool-use block's header only in that one shape,
    // and only when the current panel draws the same header (Issue #3832).
    const frameText = line.trim();
    if (
      unenclosed >= 0 && segmentRows > 0 && segmentAllResults && framesBelow.has(frameText)
      && isMarkerRowAtFrameAbove(lines, i, floor, frameIndent)
    ) {
      return { start: unenclosed + 1, completeness: 'complete', boundaryRow: i };
    }
    framesBelow.add(frameText);
    unenclosed = -1;
    segmentRows = 0;
    segmentAllResults = true;
  }
  return {
    start: unenclosed >= 0 ? unenclosed + 1 : floor,
    completeness: scanEndCompleteness(lines, floor),
  };
}

/** What {@link findApprovalContextRange} read (Issue #3881). */
export interface ApprovalContextRange {
  start: number;
  completeness: ApprovalTargetCompleteness;
}

interface ApprovalContextScan extends ApprovalContextRange {
  /** The row the scan stopped on, when it stopped at a boundary rather than ran out. */
  boundaryRow?: number;
}

/**
 * A here-document's continuation rows, or a quotation: `>` at the start of a
 * row is the one marker a shell's own output draws (PS2), so a scan that
 * stops on it may have stopped inside the command (Issue #3881).
 */
const AMBIGUOUS_BOUNDARY_PATTERN = /^>/;

/**
 * {@link findApprovalContextRange} for a yes/no prompt (Issue #3881, the
 * second half: limit 3 of #3832).
 *
 * A yes/no prompt has no panel of its own, so its frame is the prompt line's
 * column, and a here-document's `> ` continuation rows drawn at that column
 * end the scan exactly like the previous turn's `> msg` echo: the screen
 * cannot tell the two apart. Stopped on such a row, the boundary is not known
 * to be the previous turn's, so the target is `truncated` — not the whole
 * request: a deny pattern that misses it withholds as `deny-pattern-unusable`
 * rather than passing (the resolver's `approvalTargetCompleteness`). The
 * boundary is not moved: widening the target past a real echo would put the
 * previous turn's text on the deny surface (#1699).
 *
 * Multiple choice keeps {@link findApprovalContextRange}: its panels draw the
 * command deeper than their frame (#3817), and claude's legacy `> msg` echo at
 * the frame is a real boundary there.
 */
export function findYesNoApprovalContextRange(
  lines: string[],
  promptLine: number,
  panelEnd: number,
): ApprovalContextRange {
  const { start, completeness, boundaryRow } = scanApprovalContext(lines, promptLine, panelEnd);
  const boundary = boundaryRow === undefined ? undefined : lines[boundaryRow]?.trim();
  if (completeness === 'complete' && boundary !== undefined && AMBIGUOUS_BOUNDARY_PATTERN.test(boundary)) {
    return { start, completeness: 'truncated' };
  }
  return { start, completeness };
}

/** How complete a scan that ran down to `floor` without a boundary is (Issue #3881). */
function scanEndCompleteness(lines: string[], floor: number): ApprovalTargetCompleteness {
  if (floor === 0) return 'top-unknown';
  for (let i = 0; i < floor; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== '') return 'truncated';
  }
  return 'complete';
}

/** True when the nearest non-blank row above `row` is a marker row at the frame's column. */
function isMarkerRowAtFrameAbove(lines: string[], row: number, floor: number, frameIndent: number): boolean {
  for (let i = row - 1; i >= floor; i--) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    return indentOf(line) <= frameIndent && isTurnBoundaryLine(line);
  }
  return false;
}

/**
 * Join a slice of the frame into an approval-target string.
 *
 * @returns The trimmed block, or undefined when it is empty
 */
export function joinApprovalTarget(lines: string[], start: number, end: number): string | undefined {
  const joined = lines
    .slice(start, end)
    .map(l => l.trimEnd())
    .join('\n')
    .trim();
  return joined.length > 0 ? joined : undefined;
}
