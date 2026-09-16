/**
 * Command Code's permission dialog, read for the `detectDialog` seam
 * (Issue #2574).
 *
 * ## What this is for, and what it is not
 *
 * Epic #2249 決定 3 left Command Code without a `detectDialog`, and its reason
 * still holds: `PreToolUse` fires AFTER the dialog is answered, so a hook-driven
 * permission decision cannot dismiss it, and Auto-Yes stays on the numbered
 * response path. That decision is about who ANSWERS the dialog. It says nothing
 * about how an answer has to be TYPED, which is the other thing `detectDialog`
 * declares — `answerMode` for #2033's key guard, and `submitMode` for whether
 * the sender follows the digit with an Enter. This module fills only that half;
 * the Auto-Yes rollout for this tool stays `legacy` (see
 * `AUTO_YES_DIALOG_GATE_DEFAULT_MODE`).
 *
 * ## Why the Enter is the defect
 *
 * Measured live on 1.53.1 at 200x1000: a bare `1` (or `2`) closes the dialog and
 * runs the command — the digit is a hotkey. With no `submitMode` on the prompt,
 * `sendPromptAnswer` resolved `answer_then_enter` and sent `C-m` a moment later,
 * by which time the composer was back. A draft typed while the agent was
 * thinking sat in that composer, and the Enter submitted it as a new user
 * message. Declaring `answer_only` here moves that decision onto the frame the
 * answer is actually sent at, so the Auto-Yes poller, `respond` and the chat
 * surface all get it without each consumer having to re-read the screen.
 *
 * ## The shape, on every build captured
 *
 * The same rows on 1.40.1 (`dialog-create-file.txt`, `dialog-shell-command.txt`),
 * 1.49.0 (`dialog-shell-1490.txt`, `dialog-kill-task-1490.txt`) and a live
 * 1.53.1 pane:
 *
 *     ──────────────────────────… (200 columns)
 *     Execute Shell Command
 *     Command Code needs to execute sleep 25 && echo done.
 *     Press [ctrl+e] to explain this command
 *     ❯ 1. Yes
 *       2. Yes, don't ask again for `sleep` commands in this project
 *       3. No, tell Command Code what to do differently
 *     ↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo to bypass all permissions (Docs ↗)
 *
 * The rule is positional as well as textual: the hint bar must be the LAST
 * content row and the numbered run must sit directly on top of it. Command Code
 * draws its composer at the bottom of the pane for the whole of a turn and after
 * it, so the only frames whose last row is not the composer are the ones where
 * an overlay took its place. An agent reply that quotes the hint bar still has
 * the composer under it, and an answered dialog is repainted as the tool call
 * with the composer back below.
 *
 * ## Input contract
 *
 * Either spelling of the capture: as captured, or through
 * `stripBoxDrawing(stripAnsi(...))` as Auto-Yes holds it. Nothing below reads
 * the rule row `stripBoxDrawing` blanks, so both reach the same verdict.
 *
 * ## Deliberately not recognised
 *
 * `AskUserQuestion` (`./dialog.ts`, no footer), the `/model` picker (`enter to
 * select · esc to cancel`) and the `/usage` panel (`Press Esc to close`). Their
 * prompts already carry what they need, or have no prompt to answer, and while
 * the rollout is `legacy` a `null` here gates nothing.
 */

import { findNumberedOptionBlock } from '../dialog-block';
import type { DialogVerdict, NormalizedFrame } from '../types';

/**
 * The hint bar under a permission dialog.
 *
 * `enter select` — not `enter to select`, which is the `/model` picker's — and
 * the `to bypass all permissions` tail, which is what makes it a PERMISSION
 * dialog rather than any other numbered overlay. `ctrl+e explain ·` sits
 * between the two on shell commands and is absent on file edits, so the middle
 * is not spelled out.
 */
export const COMMAND_CODE_PERMISSION_FOOTER_PATTERN =
  /^\s*↑\/↓\s+navigate\s+·\s+enter\s+select\s+·.*\bto\s+bypass\s+all\s+permissions\b/;

/** The cursor glyph Command Code draws on the highlighted option. */
const COMMAND_CODE_CURSOR_GLYPH = '❯';

/**
 * Does this frame carry Command Code's permission dialog?
 *
 * @param frame - The normalised capture, either spelling (see the module docblock)
 * @returns `permission` / `numbered` / `answer_only` with the drawn options, or null
 */
export function detectCommandCodePermissionDialog(frame: NormalizedFrame): DialogVerdict | null {
  const rows = frame.contentLines;
  const footer = rows[rows.length - 1];
  if (footer === undefined || !COMMAND_CODE_PERMISSION_FOOTER_PATTERN.test(footer)) return null;

  // One footer row and nothing else between it and the bottom option.
  const block = findNumberedOptionBlock(rows, rows.length, 1);
  if (block === null || block.footer !== footer.trim()) return null;
  if (block.selectedGlyph !== COMMAND_CODE_CURSOR_GLYPH) return null;

  return {
    kind: 'permission',
    options: block.options,
    answerMode: 'numbered',
    submitMode: 'answer_only',
  };
}
