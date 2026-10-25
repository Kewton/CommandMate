/** Claude chrome (task panel, session-diff HUD, preview pane) split out of prompt-detect-multiple-choice.ts (Issue #3924). */

import { findClaudePreviewPanes } from './tools/claude/picker-chrome';

/**
 * [Issue #704] Pattern for Claude Code v2.1.142 prompt summary lines such as
 *   "  … +1 pending"
 *   "  +2 pending"
 *   "  ↑3 more"
 *   "  ↓1 more"
 * These lines are rendered BELOW the real options when Claude collapses the
 * remaining choices. They are not selectable options and must be skipped by
 * Pass 2 — otherwise NORMAL_OPTION_PATTERN matches them as option N with
 * label "pending"/"more", and the resulting (number, label) tuple poisons
 * isValidPrecedingOption() so that the real 1./2./3. options above are all
 * rejected (collectedOptions ends up with length 1 and Layer 4 returns
 * no_prompt).
 *
 * Scope of the pattern (FP suppression is critical):
 *   - Anchored at line start (^) and requires the trailing keyword to be
 *     `pending` or `more` followed by a word boundary (\b). This intentionally
 *     prevents matching legitimate option labels that mention these words
 *     mid-sentence (e.g. `2. Postpone (will remain pending)`,
 *     `3. Show me more`) — those still flow through NORMAL_OPTION_PATTERN.
 *   - Optional leading ellipsis (… U+2026) and optional collapse direction
 *     marker (+ - ↑ ↓ ⏵ ⏷) accept the variants observed in the wild.
 *   - [Issue #1708] `completed` joined `pending`/`more` after a live capture
 *     (fixtures/claude-live-1708) showed the task panel collapsing FINISHED
 *     rows as `… +2 completed`. That wording was outside the #704 guard, so it
 *     reached Pass 2 and was collected as `option 2 / label='completed'` —
 *     poisoning isValidPrecedingOption() exactly as `… +1 pending` used to.
 *   - The pattern deliberately omits any free `(.+)` capture — it must
 *     short-circuit, not extract data.
 *
 * Pattern shape: linear regex with no nested quantifiers — ReDoS safe (S4-001).
 */
export const SUMMARY_LINE_PATTERN = /^\s*[…]?\s*[+\-↑↓⏵⏷]?\s*\d+\s+(?:pending|more|completed)\b/i;

/**
 * [Issue #1708] Header row of Claude Code's bottom-anchored task panel, e.g.
 *   "  7 tasks (0 done, 1 in progress, 6 open)"
 *
 * The panel is an overlay pinned to the LAST rows of the pane, structurally
 * unrelated to whatever the agent is currently blocked on. In a production pane
 * (200x1000, alternate screen) a prompt dialog therefore renders near the top and
 * the panel ~880 blank rows below it — rows `compactBlankRows` collapses to one,
 * putting the panel squarely inside Pass 2's 50-line reverse-scan window.
 *
 * That is only harmless while something trims it away. #704/#807 trim at a
 * footer, but the AskUserQuestion *confirmation* step ("Ready to submit your
 * answers?") renders NEITHER footer, so nothing trims and the panel is the first
 * thing the reverse scan meets. Measured on the live capture in
 * fixtures/claude-live-1708/askuserquestion-submit-taskpanel.txt, two of its rows
 * match NORMAL_OPTION_PATTERN independently:
 *   - this header      → option 7,  label "tasks (2 done, 1 in progress, 4 open)"
 *   - "… +2 completed" → option 2,  label "completed"
 * Either one alone is enough to make isValidPrecedingOption() reject the real
 * `❯ 1. Submit answers` / `2. Cancel` above it, so collectedOptions never reaches
 * 2 and the frame is published as "no prompt" — Issue #1708's silent timeout.
 *
 * Anchored at line start and requires the literal `tasks (` + `<n> done`, which
 * no option label produced by any supported CLI carries. ReDoS safe (S4-001):
 * bounded repetition, no nesting.
 */
const CLAUDE_TASK_PANEL_HEADER_PATTERN = /^\s*\d{1,3}\s+tasks?\s+\(\d+\s+done\b/i;

/**
 * [Issue #1708] A single task row of the panel described above, e.g. "  ◼ Phase 3".
 *
 * Today these rows are inert — `isContinuationLine()` already absorbs them — but
 * only because none of the observed titles begins with a digit. A title like
 * "2. Fix the parser" would render as "  ◻ 2. Fix the parser" and be collected as
 * option 2, reintroducing the same poisoning from a direction no single-line
 * guard anticipates. Skipping the whole panel block closes that off structurally
 * instead of one wording at a time.
 *
 * The glyph set is exactly the two forms measured on a live pane — ◼ (in
 * progress) and ◻ (open) — and nothing else. Every extra glyph is a line this
 * guard can delete from the frame, so the set is an allowlist of things seen,
 * not a guess at what the family might contain:
 *
 *   - ❯ ● › are DEFAULT_OPTION_PATTERN's cursor indicators.
 *   - ⏺ ⎿ ✔ ✗ are the transcript markers TURN_BOUNDARY_PATTERN reads.
 *   - ☐ ☑ ☒ are the natural rendering of a MULTI-SELECT choice, and
 *     AskUserQuestion has a multiSelect mode. Measured: with those in the set,
 *     `☐ 1. Blue / ☑ 2. Green / ☐ 3. Red` under a panel header is claimed as
 *     panel content and the prompt above it disappears entirely
 *     (isPrompt=false, zero options) — Issue #1708's own failure, recreated by
 *     its fix. See the regression test.
 *
 * A completed row never appears (the panel collapses those into `… +N
 * completed`, which SUMMARY_LINE_PATTERN handles), so no done-marker is needed.
 * An unmatched glyph simply ends the block, which is the safe direction: those
 * rows go back to being handled exactly as they were before this guard existed.
 *
 * To widen this, capture a live pane that actually renders the new glyph and add
 * it as a fixture. Do not widen it from the shape of the character.
 */
const CLAUDE_TASK_PANEL_ROW_PATTERN = /^\s*[◼◻]\s/;

/**
 * [Issue #2468] Claude Code 2.1.267's session-diff HUD row, in the two
 * spellings measured on a live pane (tests/fixtures/claude-live-2468):
 *   "No changes this session"
 *   "+28 files edited before this session (show)"
 *
 * Chrome like the task panel, but a single row and RIGHT-aligned: on a
 * 200-column pane it is ~110 columns of padding and then the text. It is
 * therefore matched on the trimmed row — a reader that slices the row from the
 * left sees nothing but blanks.
 *
 * It broke two readers. Pass 2 below parses `+2 files edited …` as option 2,
 * which poisons the real `1. / 2.` above it the way `… +2 completed` did in
 * #1708. And `findClaudeTranscriptTail` took it for the last transcript row, so
 * `detectClaudeDialog` read it as the footer of the AskUserQuestion
 * confirmation screen — a dialog that draws no footer — and refused a dialog
 * that was open on screen: Auto-Yes, the UI's answer and `commandmate respond`
 * all got `prompt_no_longer_active`.
 *
 * `files?` is the one spelling not seen on a pane: a one-file session was not
 * captured, and the singular is accepted so that it is not the case that
 * regresses. Everything else is literal, for the same reason the glyph set
 * above is an allowlist. Anchored at both ends, no nested quantifiers — ReDoS
 * safe (S4-001).
 */
const CLAUDE_SESSION_DIFF_HUD_PATTERN =
  /^(?:No changes this session|\+\d+ files? edited before this session \(show\))$/;

/**
 * Line indices belonging to Claude's bottom-pinned panels within [start, end).
 *
 * Two panels, both chrome rather than transcript or prompt:
 *  - the task panel (#1708). Walks down from each header row for as long as
 *    rows keep looking like panel content (task rows or the collapsed `… +N …`
 *    summary). The first line that is neither ends the block, so a panel that
 *    abuts other content cannot swallow it.
 *  - the session-diff HUD (#2468), a single row claimed on its own.
 *
 * Pass 2 here, `findClaudeTranscriptTail` and `detectClaudeDialog`'s footer
 * guard all read this one set — through {@link findClaudeChrome}, which adds an
 * AskUserQuestion preview pane to it (Issue #2486) — so they cannot disagree
 * about which rows are chrome.
 *
 * @param lines - Full frame, already ANSI/box stripped
 * @param start - First index to consider (inclusive)
 * @param end - Last index to consider (exclusive)
 * @returns Indices Pass 2 must treat as metadata rather than options
 */
export function findClaudeTaskPanelLines(lines: string[], start: number, end: number): Set<number> {
  const panelLines = new Set<number>();
  for (let i = Math.max(0, start); i < Math.min(end, lines.length); i++) {
    if (CLAUDE_SESSION_DIFF_HUD_PATTERN.test(lines[i].trim())) {
      panelLines.add(i);
      continue;
    }
    if (!CLAUDE_TASK_PANEL_HEADER_PATTERN.test(lines[i])) continue;
    panelLines.add(i);
    for (let j = i + 1; j < Math.min(end, lines.length); j++) {
      const row = lines[j];
      if (!CLAUDE_TASK_PANEL_ROW_PATTERN.test(row) && !SUMMARY_LINE_PATTERN.test(row)) break;
      panelLines.add(j);
    }
  }
  return panelLines;
}

/**
 * [Issue #2486] Everything Claude draws around a dialog that is not the dialog,
 * in one reading: the two bottom-pinned panels above, plus an AskUserQuestion
 * picker's preview pane (`tools/claude/picker-chrome.ts`).
 *
 * The pane is why this is more than a row set. It opens to the RIGHT of the
 * options, so the option rows share their line with it; those rows are not
 * chrome but must be read as the options column alone — hence {@link cuts}.
 * Its other rows (the interior beside an empty options column, its bottom
 * border, its `Notes:` row) are chrome like a panel row and join {@link rows}.
 *
 * Pass 2 here, `findClaudeTranscriptTail` and `detectClaudeDialog` all read this
 * one reading, so they cannot disagree about which rows are chrome — the
 * disagreement #2468 was, and #2486 was again for a chrome they did not know.
 */
export interface ClaudeChrome {
  /** Rows holding nothing but chrome. */
  readonly rows: ReadonlySet<number>;
  /** Rows the preview pane shares with the options column: row → index at which the pane begins. */
  readonly cuts: ReadonlyMap<number, number>;
}

/**
 * Claude's chrome within [start, end). See {@link ClaudeChrome}.
 *
 * @param lines - Full frame, ANSI stripped; box drawing optional
 * @param start - First index to consider (inclusive)
 * @param end - Last index to consider (exclusive)
 */
export function findClaudeChrome(lines: string[], start: number, end: number): ClaudeChrome {
  const rows = findClaudeTaskPanelLines(lines, start, end);
  const panes = findClaudePreviewPanes(lines, start, end);
  for (const row of panes.rows) rows.add(row);
  return { rows, cuts: panes.cuts };
}

/**
 * The frame with Claude's chrome taken out: chrome rows blank, rows shared with
 * the preview pane cut back to the options column. Row indices are unchanged,
 * so a reader of the result can report positions in the original frame.
 */
export function maskClaudeChrome(lines: readonly string[], chrome: ClaudeChrome): string[] {
  return lines.map((line, i) => {
    if (chrome.rows.has(i)) return '';
    const cut = chrome.cuts.get(i);
    return cut === undefined ? line : line.slice(0, cut).trimEnd();
  });
}
