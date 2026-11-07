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
 * Issue #2609 added one more measured footer, and only that one: codex's
 * tool-call approval FORM (`Field 1/1`, seen on a Browser use request) closes
 * with `enter to submit | esc to cancel`
 * ({@link CODEX_FORM_SUBMIT_FOOTER_PATTERN}). `detect.ts` already reported that
 * frame `waiting` through its structural branch (#2310), so without it the two
 * readings disagreed: `respond` answered `prompt_no_longer_active` for a prompt
 * the status API was showing.
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
  CODEX_FORM_SUBMIT_FOOTER_PATTERN,
  CODEX_PICKER_FOOTER_PATTERN,
  CODEX_EFFORT_PICKER_FOOTER_PATTERN,
  stripBoxDrawing,
  type CodexLifecycleDialog,
} from '../../cli-patterns';
import { findNumberedOptionBlock } from '../dialog-block';
import { readContextAbove as readContextAboveFrom } from '../context-above';
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
  'hooks-settled': 'picker',
  update: 'update',
  trust: 'trust',
};

function readContextAbove(lines: readonly string[], firstRow: number): string {
  return readContextAboveFrom(lines, firstRow, -1);
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
    // `sendPromptAnswer` sends the digit and then Enter unless told otherwise. Read
    // against the keys measured on 0.166.0 (`tests/fixtures/codex-dialogs-0166/README.md`,
    // Issue #4146): on the hook review and the folder trust the digit moves the cursor
    // and the Enter confirms that row, so the pair does what was asked.
    //
    // The update offer confirms on the digit alone. Issue #4161 measured where its
    // Enter went (isolated CODEX_HOME, private tmux, the same 100 ms apart): onto the
    // folder trust it wrote `trust_level = "trusted"`, onto the hook review it opened
    // the list, and on the composer it did nothing. Hence `answer_only`, for this
    // screen only.
    //
    // 未確認: a `respond` through a server at a live pane (the keys were sent with
    // tmux), and a digit on the hooks list and detail.
    return {
      kind: LIFECYCLE_DIALOG_KINDS[context.lifecycleDialog],
      options: block?.options ?? [],
      answerMode: 'numbered',
      ...(context.lifecycleDialog === 'update' ? { submitMode: 'answer_only' as const } : {}),
    };
  }

  if (!block) return null;

  // The footer is the whole guard. It is positional as well as textual: only the
  // rows between the options and the status bar are looked at, so the same words
  // quoted inside a transcript hundreds of rows up cannot reach it.
  //
  // Issue #2609: the approval form's footer is admitted as its own measured row,
  // not by widening the list pattern — an `esc to cancel` alone still vouches
  // for nothing. Issue #2868: 0.157's two `/model` footers (`enter select ·
  // esc back`, then `enter default · s session · esc back`) are admitted the
  // same way.
  if (
    !CODEX_SELECTION_LIST_PATTERN.test(block.footer) &&
    !CODEX_FORM_SUBMIT_FOOTER_PATTERN.test(block.footer) &&
    !CODEX_PICKER_FOOTER_PATTERN.test(block.footer) &&
    !CODEX_EFFORT_PICKER_FOOTER_PATTERN.test(block.footer)
  ) {
    return null;
  }

  // Issue #1160: an already-answered block still inside the window is not a
  // dialog. Codex keeps it on screen and goes on working underneath it.
  if (context.stalePrompt) return null;

  const question = readContextAbove(lines, block.firstRow);
  const isApproval =
    CODEX_APPROVAL_FOOTER_PATTERN.test(block.footer) || question.split('\n')[0]?.endsWith('?');

  return {
    kind: isApproval ? 'permission' : 'picker',
    options: block.options,
    // The digit reaches the dialog as text, and `sendPromptAnswer` types it and
    // presses Enter. On 0.157.1 `/model`'s digit decides by itself and opens the
    // second step (`tests/fixtures/codex-dialogs-0157/model-picker-digit.txt`), so
    // the Enter lands there.
    //
    // 未確認 on 0.166.0 (Issue #4146): `tests/fixtures/codex-dialogs-0166/` holds
    // the launch screens only, which take the branch above. No approval or picker
    // frame, and no `respond` at one, has been measured on that build.
    answerMode: 'numbered',
  };
}
