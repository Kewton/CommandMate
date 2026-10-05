/**
 * Prompt Response Outcome
 *
 * What became of an answer POSTed to `/api/worktrees/:id/prompt-response` or
 * `/api/worktrees/:id/respond`, read from the reply's status and body.
 *
 * Issue #3292: three handlers each read the reply for themselves, and two of
 * them threw on anything but a 2xx and logged it — the card stayed, and
 * nothing told the user why the answer went nowhere. The reading lives here so
 * the PC split (`TerminalSplitPaneContent`), the detail screen's controller
 * (`useWorktreeDetailController`) and the phone's `/respond`
 * (`WorktreeDetailRefactored`) cannot disagree about a reply again.
 */

import type { ToastType } from '@/types/markdown-editor';

/**
 * - `answered`: the server took the answer.
 * - `refused`: the dialog it was for has changed or is gone, so nothing was sent.
 * - `failed`: the answer was not delivered for any other reason. Also what a
 *   handler reports when the request got no reply at all.
 */
export type PromptResponseOutcome = 'answered' | 'refused' | 'failed';

/**
 * The one `code` / `reason` on a non-2xx reply that says the dialog is gone:
 * `/respond` answers it, as a 404, when the decision is no longer pending for
 * the instance. Every other non-2xx reply is `failed` — a missing worktree, a
 * session another server owns (409) and a server error do not say the dialog
 * changed, and that is not guessed from the status.
 */
const DECISION_NOT_FOUND = 'decision_not_found';

/** The fields of a reply body this module reads. */
interface PromptResponseReplyBody {
  success?: unknown;
  code?: unknown;
  reason?: unknown;
}

/**
 * Read a prompt-response / respond reply and say what became of the answer.
 *
 * A refusal is usually a 200 `{ success: false, reason }` (Issue #2468), so
 * `ok` alone is not "answered". An unreadable 2xx body is not a refusal.
 */
export async function readPromptResponseOutcome(response: Response): Promise<PromptResponseOutcome> {
  const parsed: unknown = await response.json().catch(() => null);
  const body: PromptResponseReplyBody =
    typeof parsed === 'object' && parsed !== null ? parsed : {};

  if (response.ok) {
    return body.success === false ? 'refused' : 'answered';
  }
  const names = body.code === DECISION_NOT_FOUND || body.reason === DECISION_NOT_FOUND;
  return response.status === 404 && names ? 'refused' : 'failed';
}

/**
 * What to tell the user about an answer that was not taken: the key under the
 * `worktree` messages, and the toast's level.
 */
export const PROMPT_RESPONSE_NOTICES = {
  refused: { messageKey: 'promptResponse.refused', type: 'warning' },
  failed: { messageKey: 'promptResponse.failed', type: 'error' },
} as const satisfies Record<
  Exclude<PromptResponseOutcome, 'answered'>,
  { messageKey: string; type: ToastType }
>;
