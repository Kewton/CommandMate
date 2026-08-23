/**
 * Claude Code's positive dialog detection (Issue #1928, 方針書 §4 D1 決定 4).
 *
 * The seam Auto-Yes reads. Everything here answers ONE question — "is the block
 * at the bottom of this frame a dialog Claude is drawing, or is it text Claude
 * wrote?" — because that is the distinction `detectPrompt` cannot make and the
 * one #1896 turned on: an agent that lists `1. / 2. / 3.` in its ANSWER
 * satisfies the generic numbered-list inference, and Auto-Yes used to type `1`
 * at it.
 *
 * ## What was measured (claude-cli 2.1.240 / 2.1.218, 200x1000 pane)
 *
 * Claude draws exactly two shapes of numbered dialog, both with the selection
 * cursor `❯` on the highlighted row
 * (`tests/unit/lib/detection/fixtures/claude-live-1708/`):
 *
 * | frame                              | rows                                                              |
 * |------------------------------------|-------------------------------------------------------------------|
 * | `bash-approval-taskpanel.txt`      | ` Do you want to proceed?` / ` ❯ 1. Yes` … / ` Esc to cancel · Tab to amend · ctrl+e to explain` |
 * | `askuserquestion-submit-taskpanel.txt` | `Ready to submit your answers?` / `❯ 1. Submit answers` / `  2. Cancel` — **no footer at all** |
 *
 * and the `/model` overlay of #1495, whose footer is `Enter to set as default ·
 * s to use this session only · Esc to cancel`.
 *
 * So neither the footer alone nor the cursor alone covers the measured set: the
 * AskUserQuestion submit screen has no footer, and every frame has the cursor.
 * The cursor is therefore REQUIRED and the footer is required only when there is
 * one — which is the shape of the two guards below.
 *
 * ## Why the cursor must be `❯`, not "any selection glyph"
 *
 * `●` is in {@link findNumberedOptionBlock}'s glyph union because codex and
 * copilot draw a filled radio, but Claude uses `●` for an ordinary transcript
 * bullet — ` ● Which color scheme do you prefer?` is a live row of
 * `askuserquestion-submit-taskpanel.txt`. Accepting it here would let Claude's
 * own prose vouch for itself, which is the #1896 failure with a different glyph.
 */

import { stripBoxDrawing } from '../../cli-patterns';
import { findNumberedOptionBlock } from '../dialog-block';
import type { DialogVerdict, NormalizedFrame } from '../types';

/** What `detect.ts` measured about this frame before handing it over. */
export interface ClaudeDialogContext {
  /**
   * Index of the last transcript row, from `findClaudeTranscriptTail`.
   *
   * Passed in rather than recomputed so the dialog rule and the idle-evidence
   * rule read the same "where does Claude's chrome start" — and so this module
   * needs no import from `detect.ts`, which imports this one.
   */
  readonly transcriptTail: number;
}

/**
 * Claude's dialog footers, in every spelling measured.
 *
 * `Esc to cancel` is the permission dialog's and the `/model` overlay's; the
 * `Enter to …` alternatives are {@link CLAUDE_SELECTION_LIST_FOOTER}'s three
 * forms restated as a single test, because here they are being used to VOUCH
 * for a block rather than to classify a frame.
 *
 * Case-insensitive because 2.1.218 draws `Esc` and 2.1.240 draws `esc` in
 * different rows of the same UI. No `/g`, no nested quantifiers.
 */
const CLAUDE_DIALOG_FOOTER_PATTERN =
  /esc\s+to\s+cancel|enter\s+to\s+(?:select|confirm|set\s+as\s+default)/i;

/** The selection cursor Claude puts on the highlighted option. */
const CLAUDE_SELECTION_GLYPHS: ReadonlySet<string> = new Set(['❯', '>']);

/** How many non-blank rows above the options may hold the question. */
const QUESTION_SCAN_ROWS = 4;

/** The permission dialog's question, in the spellings 2.1.x draws. */
const CLAUDE_PERMISSION_QUESTION_PATTERN = /do you want to\b|allow\b.*\?$/i;

/** The AskUserQuestion review screen's closing question. */
const CLAUDE_ASK_USER_QUESTION_PATTERN = /ready to submit your answers\?|review your answers/i;

/** The `/model` overlay's footer verb (Issue #1495). */
const CLAUDE_PICKER_FOOTER_PATTERN = /set\s+as\s+default/i;

/** The non-blank rows immediately above `firstRow`, nearest first. */
function readContextAbove(lines: readonly string[], firstRow: number): string {
  const rows: string[] = [];
  for (let i = firstRow - 1; i >= 0 && rows.length < QUESTION_SCAN_ROWS; i--) {
    const row = lines[i].trim();
    if (row === '') continue;
    rows.push(row);
  }
  return rows.join('\n');
}

function classify(context: string, footer: string): string {
  if (CLAUDE_ASK_USER_QUESTION_PATTERN.test(context)) return 'ask_user';
  if (CLAUDE_PICKER_FOOTER_PATTERN.test(footer)) return 'picker';
  if (CLAUDE_PERMISSION_QUESTION_PATTERN.test(context)) return 'permission';
  return 'dialog';
}

/**
 * Does this frame carry a Claude dialog?
 *
 * @param frame - The normalised capture
 * @param context - What `detect.ts` measured; see {@link ClaudeDialogContext}
 * @returns The dialog, or null — which for a gated tool means Auto-Yes must not
 *   answer, whatever `detectPrompt` inferred from the same rows
 */
export function detectClaudeDialog(
  frame: NormalizedFrame,
  context: ClaudeDialogContext,
): DialogVerdict | null {
  if (context.transcriptTail < 0) return null;

  // `stripBoxDrawing` maps line-for-line, so an index taken from
  // `frame.contentLines` is valid here too — and a frame whose gutter the
  // Auto-Yes poller already removed parses to the same rows.
  const lines = stripBoxDrawing(frame.clean).split('\n');
  const block = findNumberedOptionBlock(lines, context.transcriptTail + 1);
  if (!block) return null;

  // Guard 1: the selection cursor. Claude puts it on the highlighted option of
  // every dialog it draws and on nothing it writes.
  if (block.selectedGlyph === null || !CLAUDE_SELECTION_GLYPHS.has(block.selectedGlyph)) {
    return null;
  }

  // Guard 2: whatever sits between the options and the end of the transcript
  // must be one of Claude's dialog footers, or nothing at all. A completion
  // marker (`✻ Brewed for 24s`) or a fresh line of prose there means the block
  // is finished output with something after it, not an open dialog.
  const footer = block.footer.trim();
  if (footer !== '' && !CLAUDE_DIALOG_FOOTER_PATTERN.test(footer)) return null;

  return {
    kind: classify(readContextAbove(lines, block.firstRow), footer),
    options: block.options,
    // Claude's menus take ↑/↓ + Enter, and `sendPromptAnswer` already knows
    // that: it NAVIGATES to the numbered option for claude rather than typing
    // the digit (`isCursorNavMultiChoice`). The answer is still expressed as a
    // number, which is what this field is about.
    answerMode: 'numbered',
  };
}
