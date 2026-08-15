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
 * Dictionary keys returned by {@link getNextAction} (Issue #1787).
 *
 * These are keys in the `worktree` namespace (`locales/{en,ja}/worktree.json`),
 * NOT display strings: the function runs on the server (`/api/worktrees`) and in
 * module scope, where `t()` cannot be called, so pinning English here would ship
 * "Approve / Reject" to a Japanese UI — the same problem #1271/#1273 fixed for
 * StatusDot's labels. Rendering surfaces resolve them with
 * `useTranslations('worktree')`.
 */
export const NEXT_ACTION_KEYS = {
  start: 'nextAction.start',
  sendMessage: 'nextAction.sendMessage',
  approveReject: 'nextAction.approveReject',
  replyToPrompt: 'nextAction.replyToPrompt',
  checkStalled: 'nextAction.checkStalled',
  running: 'nextAction.running',
} as const;

/** One of the {@link NEXT_ACTION_KEYS} values. */
export type NextActionKey = (typeof NEXT_ACTION_KEYS)[keyof typeof NEXT_ACTION_KEYS];

const NEXT_ACTION_KEY_SET: ReadonlySet<string> = new Set(Object.values(NEXT_ACTION_KEYS));

/**
 * Whether a value is a key this module produces (Issue #1787).
 *
 * `Worktree.nextAction` is a plain `string` on the wire, and a server that
 * predates this Issue still sends the old English literal. Callers must gate
 * `t()` on this: next-intl reports a missing key by rendering the key path, so
 * feeding it `"Approve / Reject"` would put `worktree.Approve / Reject` on
 * screen. Anything that fails this test is rendered verbatim instead.
 */
export function isNextActionKey(value: string): value is NextActionKey {
  return NEXT_ACTION_KEY_SET.has(value);
}

/**
 * Determine the next action for a given session state.
 *
 * @param status - Current session status (idle/ready/running/waiting) or null
 * @param promptType - Type of active prompt, if any
 * @param isStalled - Whether the session is considered stalled
 * @returns A dictionary key from {@link NEXT_ACTION_KEYS} (Issue #1787 — this
 *   used to be a hard-coded English string)
 */
export function getNextAction(
  status: SessionStatus | null,
  promptType: PromptType | null,
  isStalled: boolean
): NextActionKey {
  if (!status) return NEXT_ACTION_KEYS.start;
  if (status === 'idle') return NEXT_ACTION_KEYS.start;
  if (status === 'ready') return NEXT_ACTION_KEYS.sendMessage;
  if (status === 'waiting' && promptType === 'approval') return NEXT_ACTION_KEYS.approveReject;
  if (status === 'waiting') return NEXT_ACTION_KEYS.replyToPrompt;
  if (status === 'running' && isStalled) return NEXT_ACTION_KEYS.checkStalled;
  if (status === 'running') return NEXT_ACTION_KEYS.running;
  // exhaustive check: SessionStatus extensions will cause compile error [DR2-005]
  const _exhaustive: never = status;
  void _exhaustive;
  return NEXT_ACTION_KEYS.running;
}

/**
 * Determine the review status for a worktree.
 *
 * @param worktreeStatus - Worktree's status field (ready/in_progress/in_review/done/null)
 * @param sessionStatus - Current session status or null
 * @param promptType - Type of active prompt, if any
 * @param isStalled - Whether the session is considered stalled
 * @returns ReviewStatus if applicable, null otherwise
 */
export function getReviewStatus(
  worktreeStatus: 'ready' | 'in_progress' | 'in_review' | 'done' | null,
  sessionStatus: SessionStatus | null,
  promptType: PromptType | null,
  isStalled: boolean
): ReviewStatus | null {
  if (worktreeStatus === 'in_review') return 'done';
  if (sessionStatus === 'waiting' && promptType === 'approval') return 'approval';
  if (sessionStatus === 'running' && isStalled) return 'stalled';
  return null;
}
