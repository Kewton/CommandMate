/** Approval-context boundary logic split out of prompt-detect-multiple-choice.ts (Issue #3866). */

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
 *   screen cannot tell it from the previous turn's echo. This one stays an
 *   error on the answering side: the command rows above the `> ` leave
 *   `approvalTarget`, and a yes/no `question` is the prompt line alone, so a
 *   deny pattern on them can miss.
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
    if (marker && atFrame) return (unenclosed >= 0 ? unenclosed : i) + 1;
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
      return unenclosed + 1;
    }
    framesBelow.add(frameText);
    unenclosed = -1;
    segmentRows = 0;
    segmentAllResults = true;
  }
  return unenclosed >= 0 ? unenclosed + 1 : floor;
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
