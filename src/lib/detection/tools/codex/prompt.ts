/**
 * Codex CLI's positive dialog detection (Issue #1928, 方針書 §4 D1 決定 4).
 *
 * ## What was measured (codex-cli 0.148.0 / 0.146.0, 200x1000 pane)
 *
 * Codex draws every numbered dialog the same way — a `›` cursor on the
 * highlighted option and a `Press enter to confirm …` footer — and encodes the
 * DIFFERENCE between "the agent is asking you for permission" and "you opened a
 * menu" in the escape verb of that footer
 * (`tests/unit/lib/detection/fixtures/codex-live-1628/`):
 *
 * | frame                       | footer                                     | family     |
 * |-----------------------------|--------------------------------------------|------------|
 * | `approval-run-command.txt`  | `Press enter to confirm or esc to cancel`  | permission |
 * | `approval-apply-patch.txt`  | `Press enter to confirm or esc to cancel`  | permission |
 * | `model-picker-step1.txt`    | `Press enter to confirm or esc to go back` | picker     |
 * | `model-picker-step2.txt`    | `Press enter to confirm or esc to go back` | picker     |
 *
 * That is the same pair of anchors Issue #1628 measured for `detect.ts`'s
 * selection-list branch, and they are deliberately the same anchors here: two
 * readings of "is this codex's dialog?" would be two chances to disagree, and
 * this one is the one Auto-Yes acts on.
 *
 * ## Why the footer and not the numbers
 *
 * Codex draws on the NORMAL screen, so its pane keeps scrollback: an approval
 * the operator answered five minutes ago is still on the frame, options and
 * footer intact. That is Issue #1160, and the guard for it already exists —
 * `isCodexStalePrompt` — so this module takes its verdict rather than inventing
 * a second one. Without it a `detectDialog` that only looked at the rows would
 * vouch for a dead prompt and Auto-Yes would answer it again.
 */

import {
  CODEX_SELECTION_LIST_PATTERN,
  CODEX_APPROVAL_FOOTER_PATTERN,
  stripBoxDrawing,
  type CodexLifecycleDialog,
} from '../../cli-patterns';
import { findNumberedOptionBlock } from '../dialog-block';
import type { DialogVerdict, NormalizedFrame } from '../types';

/** What `detect.ts` measured about this frame before handing it over. */
export interface CodexDialogContext {
  /**
   * Exclusive end of the content region — the row above codex's status bar,
   * with the trailing blank padding already walked off, or `contentLines.length`
   * when the bar could not be located (Issue #1150's drift case).
   */
  readonly contentEnd: number;
  /** `isCodexStalePrompt(frame.contentLines)` — Issue #1160's answered-block guard. */
  readonly stalePrompt: boolean;
  /** `getCodexLifecycleDialog(frame.clean)` — Issue #1829's launch screens. */
  readonly lifecycleDialog: CodexLifecycleDialog | null;
}

/**
 * The dialog family each lifecycle screen belongs to (Issue #1829).
 *
 * They are dialogs by any reading — the pane is blocked on a keypress — so this
 * module reports them. Auto-Yes never reaches the report: `detectAndRespondToPrompt`
 * suppresses a lifecycle screen with `agent-launch-dialog` BEFORE consulting the
 * gate, because answering one is `CodexTool.waitForReady()`'s job and its
 * answers differ from the defaults. Naming them anyway keeps `respond` and the
 * UI able to say what is on screen.
 */
const LIFECYCLE_DIALOG_KINDS: Readonly<Record<CodexLifecycleDialog, string>> = {
  'hooks-review': 'permission',
  'hooks-list': 'picker',
  'hooks-detail': 'picker',
  update: 'update',
  trust: 'trust',
};

/** How many non-blank rows above the options may hold the question. */
const QUESTION_SCAN_ROWS = 4;

function readContextAbove(lines: readonly string[], firstRow: number): string {
  const rows: string[] = [];
  for (let i = firstRow - 1; i >= 0 && rows.length < QUESTION_SCAN_ROWS; i--) {
    const row = lines[i].trim();
    if (row === '') continue;
    rows.push(row);
  }
  return rows.join('\n');
}

/**
 * Does this frame carry a Codex dialog?
 *
 * @param frame - The normalised capture
 * @param context - What `detect.ts` measured; see {@link CodexDialogContext}
 */
export function detectCodexDialog(
  frame: NormalizedFrame,
  context: CodexDialogContext,
): DialogVerdict | null {
  const lines = stripBoxDrawing(frame.clean).split('\n');
  const block = findNumberedOptionBlock(lines, context.contentEnd);

  if (context.lifecycleDialog) {
    return {
      kind: LIFECYCLE_DIALOG_KINDS[context.lifecycleDialog],
      options: block?.options ?? [],
      answerMode: 'numbered',
    };
  }

  if (!block) return null;

  // The footer is the whole guard. It is positional as well as textual: only the
  // rows between the options and the status bar are looked at, so the same words
  // quoted inside a transcript hundreds of rows up cannot reach it.
  if (!CODEX_SELECTION_LIST_PATTERN.test(block.footer)) return null;

  // Issue #1160: an already-answered block still inside the window is not a
  // dialog. Codex keeps it on screen and goes on working underneath it.
  if (context.stalePrompt) return null;

  const question = readContextAbove(lines, block.firstRow);
  const isApproval =
    CODEX_APPROVAL_FOOTER_PATTERN.test(block.footer) || question.split('\n')[0]?.endsWith('?');

  return {
    kind: isApproval ? 'permission' : 'picker',
    options: block.options,
    // Measured: codex takes the digit as text. `sendPromptAnswer` types it for
    // this tool, and the hooks-review screens confirm the digit lands
    // immediately (reference: codex 0.148 review flow).
    answerMode: 'numbered',
  };
}
