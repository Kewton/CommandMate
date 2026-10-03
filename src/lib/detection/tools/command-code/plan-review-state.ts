/**
 * Which part of Command Code's plan review overlay has the keyboard
 * (Issue #3125).
 *
 * The detector already says THAT the overlay is up
 * (`command_code_plan_review`, see `detect.ts`). Answering it needs one more
 * fact, because the same keys mean different things depending on where the
 * focus is — measured on 1.58.0 (`tests/fixtures/command-code-plan-review-2763/`)
 * and unchanged in the 1.74.0 rows #3059 observed
 * (`tests/fixtures/command-code-plan-review-3125/`):
 *
 * | phase            | hint bar (last content row)                  | `Enter` does            |
 * |------------------|----------------------------------------------|-------------------------|
 * | `body`           | `type + enter to comment · …`                | opens / pins a comment  |
 * | `comment-box`    | `enter to pin · esc discard`                 | pins what is typed      |
 * | `action-focus`   | `↑/↓ choose · enter to run` (a `❯` on a row) | RUNS the focused action |
 * | `approve-choice` | `←/→ choose · enter confirm · esc back`      | confirms the approval   |
 *
 * The body cursor itself is drawn by background colour alone and cannot be read
 * off a plain capture; the hint bar and the `❯` can, which is all this needs.
 *
 * Browser-safe and pure, like `selection-shape.ts` it builds on.
 *
 * @module lib/detection/tools/command-code/plan-review-state
 */

import { stripAnsi } from '../../ansi';
import {
  hasCommandCodePlanReviewFooterAtBottom,
  isCommandCodePlanApproveChoice,
} from '../../selection-shape';

export type CommandCodePlanReviewPhase =
  | 'body'
  | 'comment-box'
  | 'action-focus'
  | 'approve-choice'
  | 'unknown';

export interface CommandCodePlanReviewState {
  phase: CommandCodePlanReviewPhase;
  /** The badge's `N pending comment(s)`; 0 when the badge carries no count. */
  pendingComments: number;
  /** On `approve-choice`: which radio is `(•)`. Null on every other phase. */
  approveChoice: 'with-comments' | 'discard-comments' | null;
}

/** Rows read from the end of the frame — the same 15 the detector reads. */
const TAIL_CONTENT_ROWS = 15;

const BODY_HINT = /^\s*type \+ enter to comment\b/i;
const COMMENT_BOX_HINT = /^\s*enter to pin\s*·\s*esc discard\s*$/i;
const ACTION_FOCUS_HINT = /^\s*↑\/↓ choose\s*·\s*enter to run\s*$/i;
const FOCUSED_ACTION_ROW = /^\s*❯ +(?:Submit review\b|Approve\s+ctrl\+a\b|Cancel\s+esc\b)/im;
const PENDING_BADGE = /^\s*REVIEW\s+(\d+)\s+pending comments?\b/im;
const APPROVE_WITH_COMMENTS_SELECTED = /\(•\)\s+with\s+\d+\s+comments?\s+as\s+notes/i;

/**
 * Read the plan review overlay's focus off a capture.
 *
 * @param frame - a raw `capture-pane` frame, ANSI intact or stripped
 * @returns null when the overlay is not at the bottom of this frame
 */
export function readCommandCodePlanReviewState(
  frame: string | null | undefined,
): CommandCodePlanReviewState | null {
  if (!frame) return null;
  const rows = stripAnsi(frame.replace(/\r\n/g, '\n'))
    .split('\n')
    .filter((row) => row.trim() !== '')
    .slice(-TAIL_CONTENT_ROWS);
  if (rows.length === 0) return null;
  const tail = rows.join('\n');
  const pendingMatch = PENDING_BADGE.exec(tail);
  const pendingComments = pendingMatch ? Number(pendingMatch[1]) : 0;

  if (isCommandCodePlanApproveChoice(tail)) {
    return {
      phase: 'approve-choice',
      pendingComments,
      approveChoice: APPROVE_WITH_COMMENTS_SELECTED.test(tail) ? 'with-comments' : 'discard-comments',
    };
  }
  if (!hasCommandCodePlanReviewFooterAtBottom(tail)) return null;

  const hint = rows[rows.length - 1];
  let phase: CommandCodePlanReviewPhase = 'unknown';
  if (FOCUSED_ACTION_ROW.test(tail) || ACTION_FOCUS_HINT.test(hint)) phase = 'action-focus';
  else if (COMMENT_BOX_HINT.test(hint)) phase = 'comment-box';
  else if (BODY_HINT.test(hint)) phase = 'body';
  return { phase, pendingComments, approveChoice: null };
}
