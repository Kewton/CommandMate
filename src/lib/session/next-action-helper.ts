/**
 * Next Action Helper - Derived state for worktree next actions and review status.
 *
 * Issue #600: UX refresh - provides getNextAction() and getReviewStatus()
 * for Review screen and WorktreeCard display.
 *
 * Uses exhaustive check (satisfies never) pattern to catch future
 * SessionStatus extensions at compile time [DR2-005].
 */

import type { SessionStatus } from '@/lib/detection/status-detector';
import type { PromptType } from '@/types/models';

/**
 * Review status for filtering in Review screen.
 * - done: worktree status is 'done'
 * - approval: session waiting for approval prompt
 * - stalled: session running but no recent activity
 */
export type ReviewStatus = 'done' | 'approval' | 'stalled';

/**
 * Determine the next action string for a given session state.
 *
 * @param status - Current session status (idle/ready/running/waiting) or null
 * @param promptType - Type of active prompt, if any
 * @param isStalled - Whether the session is considered stalled
 * @returns Human-readable next action string
 */
export function getNextAction(
  status: SessionStatus | null,
  promptType: PromptType | null,
  isStalled: boolean
): string {
  if (!status) return 'Start';
  if (status === 'idle') return 'Start';
  if (status === 'ready') return 'Send message';
  if (status === 'waiting' && promptType === 'approval') return 'Approve / Reject';
  if (status === 'waiting') return 'Reply to prompt';
  if (status === 'running' && isStalled) return 'Check stalled';
  if (status === 'running') return 'Running...';
  // exhaustive check: SessionStatus extensions will cause compile error [DR2-005]
  const _exhaustive: never = status;
  void _exhaustive;
  return 'Running...';
}

/**
 * Determine the review status for a worktree.
 *
 * @param worktreeStatus - Worktree's status field (todo/doing/done/null)
 * @param sessionStatus - Current session status or null
 * @param promptType - Type of active prompt, if any
 * @param isStalled - Whether the session is considered stalled
 * @returns ReviewStatus if applicable, null otherwise
 */
export function getReviewStatus(
  worktreeStatus: 'todo' | 'doing' | 'done' | null,
  sessionStatus: SessionStatus | null,
  promptType: PromptType | null,
  isStalled: boolean
): ReviewStatus | null {
  if (worktreeStatus === 'done') return 'done';
  if (sessionStatus === 'waiting' && promptType === 'approval') return 'approval';
  if (sessionStatus === 'running' && isStalled) return 'stalled';
  return null;
}
