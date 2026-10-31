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
 *
 * Issue #3331: browser-side Auto-Yes (`useAutoYes`) and Command Code's plan
 * review (`PlanReviewControls`) read their replies here too.
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

/**
 * The `reason` of an answer stopped part-way (Issue #3975 / #3982): both
 * routes answer it as a 500 with `keysSent: true`. Restated from
 * `prompt-answer-errors` (`ANSWER_INPUT_LOST_REASON`), which this client
 * module does not import; a unit test keeps the two equal.
 */
export const ANSWER_INPUT_LOST_REASON = 'answer_input_lost';

/** The fields of a reply body this module reads. */
interface PromptResponseReplyBody {
  success?: unknown;
  code?: unknown;
  reason?: unknown;
  keysSent?: unknown;
}

/**
 * A reply read once: the outcome, and the body it was read from (an empty
 * object when the body was not a JSON object), for a caller that also shows
 * the reply's own words.
 */
export interface PromptResponseReply {
  outcome: PromptResponseOutcome;
  body: Record<string, unknown>;
  /**
   * Issue #4031: a `failed` answer that was stopped part-way — the reply says
   * `reason: answer_input_lost` and `keysSent: true` — so some of its keys may
   * be on the pane. Answering again blindly could type them twice; the user is
   * told to look first ({@link PROMPT_RESPONSE_PARTIAL_NOTICE}). False for
   * every other reply.
   */
  partial: boolean;
}

/**
 * Read a prompt-response / respond reply and say what became of the answer,
 * keeping the body. A `Response` body can be read only once, so a caller that
 * needs `reason` / `message` reads them from here rather than reading the
 * reply again (Issue #3331: `PlanReviewControls`).
 *
 * A refusal is usually a 200 `{ success: false, reason }` (Issue #2468), so
 * `ok` alone is not "answered". An unreadable 2xx body is not a refusal.
 */
export async function readPromptResponseReply(response: Response): Promise<PromptResponseReply> {
  const parsed: unknown = await response.json().catch(() => null);
  const body: Record<string, unknown> =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const fields: PromptResponseReplyBody = body;

  if (response.ok) {
    return { outcome: fields.success === false ? 'refused' : 'answered', body, partial: false };
  }
  const names = fields.code === DECISION_NOT_FOUND || fields.reason === DECISION_NOT_FOUND;
  if (response.status === 404 && names) return { outcome: 'refused', body, partial: false };
  const partial = fields.reason === ANSWER_INPUT_LOST_REASON && fields.keysSent === true;
  return { outcome: 'failed', body, partial };
}

/** Read a prompt-response / respond reply and say what became of the answer. */
export async function readPromptResponseOutcome(response: Response): Promise<PromptResponseOutcome> {
  return (await readPromptResponseReply(response)).outcome;
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

/**
 * What to tell the user about an answer stopped part-way (Issue #4031): some
 * keys may have reached the pane, so look at the screen before answering
 * again. A `failed` reply that is not {@link PromptResponseReply.partial}
 * keeps {@link PROMPT_RESPONSE_NOTICES}' `failed`.
 */
export const PROMPT_RESPONSE_PARTIAL_NOTICE = {
  messageKey: 'promptResponse.partial',
  type: 'warning',
} as const satisfies { messageKey: string; type: ToastType };

/**
 * The notice for an answer that was not taken (Issue #4031): the partial one
 * for a `failed` reply stopped part-way, else the outcome's own.
 */
export function promptResponseNotice(
  outcome: Exclude<PromptResponseOutcome, 'answered'>,
  partial: boolean,
): { messageKey: string; type: ToastType } {
  return outcome === 'failed' && partial ? PROMPT_RESPONSE_PARTIAL_NOTICE : PROMPT_RESPONSE_NOTICES[outcome];
}
