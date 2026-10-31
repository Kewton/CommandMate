'use client';

/**
 * PlanReviewControls — Command Code's plan review (REVIEW) answered from the
 * chat surface (Issue #3139).
 *
 * Issue #2762 gave the screen one button, `ctrl+a`, sent through
 * `/special-keys`; the arrow pad's `Esc` already cancelled. What the browser
 * could never do was COMMENT on the plan and send it back (`Submit review`,
 * `ctrl+r`) — the one thing a reviewer on a phone most wants to do with a plan.
 *
 * Every control here posts to `/prompt-response` with `planReviewAction`
 * (Issue #3125), never to `/special-keys`. That route re-reads the pane, decides
 * the keys against the overlay's current phase (`lib/cli-tools/
 * command-code-plan-review`) and refuses with `plan_review_*` — sending nothing —
 * when the screen is not one it can answer safely. Those refusals are shown here
 * verbatim, under a localized line for the reasons this build knows.
 *
 * - `comment` pins the text typed in the box; `submit` sends the review. Two
 *   steps, so a comment is never submitted by accident.
 * - `approve` RUNS the plan, so it asks once more before posting (a phone tap is
 *   easy to misplace) — which is also why this replaces #2762's unconfirmed
 *   `ctrl+a` button rather than sitting next to it.
 * - `cancel` posts at once: it discards the review, it runs nothing.
 *
 * The request always names its action. An answer sent WITHOUT one would be
 * delivered as an ordinary prompt answer on any screen that is not the plan
 * review, which is exactly the misdelivery this route's re-verification exists
 * to prevent.
 *
 * ## The height rule (Issue #3999)
 *
 * On a 412x892 phone the chat card laid `Approve` out at 738px, under the
 * 698px bottom of an `overflow-hidden` surface with nothing to scroll — in the
 * DOM, out of reach. Lowering one cap would not have held: the comment box
 * resizes, the buttons wrap, the confirmation and a refusal each add rows.
 * So the group is split by what may give way:
 *
 *  - **pinned** (`shrink-0`): the button row and the approve confirmation —
 *    the things a reviewer must always be able to press;
 *  - **yielding** (`min-h-0`, scrolls inside itself): the comment editor and
 *    a refusal. Each is also capped, so the group's height is bounded on its
 *    own wherever it is mounted, and in a flex column that is short of room
 *    they shrink first — down to nothing — before a button is clipped.
 *
 * `compact` is the narrow mounts' form (the phone, a `/sessions` tile and
 * every terminal surface): a one-row comment box whose label is read by
 * assistive technology only. The comment stays offered everywhere.
 */

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { readPromptResponseReply } from '@/lib/prompt-response-outcome';

export type PlanReviewControlAction = 'comment' | 'submit' | 'approve' | 'cancel';

export interface PlanReviewControlsProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  /** Refresh the pane once an action was delivered. */
  onKeysSent?: () => void;
  /** Issue #3999: the narrow form — see "The height rule" above. */
  compact?: boolean;
}

/**
 * The group's DOM marker, for the composer's "go to the controls" link
 * (Issue #3999): `data-plan-review-target="<worktreeId>:<instanceId>"`.
 */
export function planReviewTargetKey(worktreeId: string, instanceId: string): string {
  return `${worktreeId}:${instanceId}`;
}

/** The `plan_review_*` refusals this build has a localized sentence for. */
const KNOWN_REFUSAL_KEYS: Record<string, string> = {
  plan_review_ambiguous_answer: 'planReview.refusal.ambiguousAnswer',
  plan_review_busy: 'planReview.refusal.busy',
  plan_review_nothing_to_submit: 'planReview.refusal.nothingToSubmit',
  plan_review_invalid_request: 'planReview.refusal.invalidRequest',
  plan_review_not_active: 'planReview.refusal.notActive',
  // Issue #4031: the keys stopped part-way (500, `keysSent: true`) — look first.
  answer_input_lost: 'planReview.refusal.inputLost',
};

interface PlanReviewError {
  reason: string | null;
  message: string | null;
}

/** A body field shown to the user, when the reply carried it as text. */
function textField(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === 'string' ? value : null;
}

/**
 * The request body for one action. Pure; exported for tests.
 *
 * `comment` always carries the text; `submit` carries it only when the box is
 * not empty (the route then pins it before `ctrl+r`); `approve` and `cancel`
 * carry none, which the route requires.
 */
export function buildPlanReviewRequestBody(
  action: PlanReviewControlAction,
  cliToolId: CLIToolType,
  comment: string,
  instanceId?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { planReviewAction: action, cliTool: cliToolId };
  const text = comment.trim();
  if ((action === 'comment' || action === 'submit') && text) body.answer = text;
  if (instanceId && instanceId !== cliToolId) body.instanceId = instanceId;
  return body;
}

export function PlanReviewControls({
  worktreeId,
  cliToolId,
  instanceId,
  onKeysSent,
  compact = false,
}: PlanReviewControlsProps) {
  const t = useTranslations('worktree');
  const [comment, setComment] = useState('');
  const [confirmingApprove, setConfirmingApprove] = useState(false);
  const [pending, setPending] = useState<PlanReviewControlAction | null>(null);
  const [error, setError] = useState<PlanReviewError | null>(null);
  // Issue #3999: the controls also sit in terminal footers, so two panes of
  // one worktree (2x2) can show them at once. Key the textarea by instance
  // too, or the second label points at the first box.
  const targetKey = planReviewTargetKey(worktreeId, instanceId ?? cliToolId);
  const commentInputId = `plan-review-comment-${targetKey}`;

  const post = useCallback(
    async (action: PlanReviewControlAction) => {
      setPending(action);
      setError(null);
      try {
        const response = await fetch(
          `/api/worktrees/${encodeURIComponent(worktreeId)}/prompt-response`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPlanReviewRequestBody(action, cliToolId, comment, instanceId)),
          },
        );
        // Issue #3331: read like every other answer to a dialog. A 2xx whose
        // body has no `success` is now taken as delivered (it used to show the
        // error); a refusal and a failure both still show it here.
        const { outcome, body } = await readPromptResponseReply(response);
        if (outcome !== 'answered') {
          setError({
            reason: textField(body, 'reason'),
            message: textField(body, 'message') ?? textField(body, 'error'),
          });
          return;
        }
        if (action === 'comment' || action === 'submit') setComment('');
        onKeysSent?.();
      } catch {
        setError({ reason: null, message: null });
      } finally {
        setPending(null);
      }
    },
    [worktreeId, cliToolId, comment, instanceId, onKeysSent],
  );

  const hasComment = comment.trim().length > 0;
  const busy = pending !== null;
  const refusalKey = error?.reason ? KNOWN_REFUSAL_KEYS[error.reason] : undefined;

  const buttonClass =
    'min-h-[44px] rounded-md border px-3 py-2 text-sm font-medium transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50';
  const plainButtonClass = `${buttonClass} border-border bg-surface text-foreground hover:bg-muted dark:bg-surface-2`;

  // Issue #3999: the compact form names the actions without their key hints
  // ("Approve", not "Approve (Ctrl+A)") so Submit / Approve / Cancel fit one
  // row at 360px; the full label stays the accessible name's tooltip.
  const label = (key: 'submit' | 'approve' | 'cancel'): string =>
    t(compact ? `planReview.${key}Compact` : `planReview.${key}`);

  const commentButton = (
    <button
      type="button"
      data-testid="plan-review-comment"
      disabled={busy || !hasComment}
      onClick={() => void post('comment')}
      className={`${plainButtonClass}${compact ? ' shrink-0' : ''}`}
    >
      {t('planReview.comment')}
    </button>
  );

  return (
    <div
      data-testid="plan-review-controls"
      data-plan-review-target={targetKey}
      role="group"
      aria-label={t('planReview.groupLabel')}
      // Issue #3999: focusable, so the composer's link can move focus here.
      tabIndex={-1}
      className="flex min-h-0 flex-col gap-2 rounded-lg bg-muted px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Yielding: the comment editor (see "The height rule"). `p-0.5` keeps
          the textarea's focus ring inside the scroller. Compact puts "Add
          comment" beside a one-row box, so the pinned row below holds only
          the three actions. */}
      <div
        data-testid="plan-review-comment-area"
        className={`min-h-0 overflow-y-auto p-0.5 ${
          compact ? 'flex max-h-24 items-start gap-1.5' : 'max-h-40'
        }`}
      >
        <label
          className={compact ? 'sr-only' : 'mb-1 block text-xs text-muted-foreground'}
          htmlFor={commentInputId}
        >
          {t('planReview.commentLabel')}
        </label>
        <textarea
          id={commentInputId}
          data-testid="plan-review-comment-input"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t('planReview.commentPlaceholder')}
          rows={compact ? 1 : 2}
          className={`block resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-surface-2 ${
            compact ? 'min-h-[44px] min-w-0 flex-1' : 'w-full'
          }`}
        />
        {compact ? commentButton : null}
      </div>
      {/* Pinned: the actions. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {compact ? null : commentButton}
        <button
          type="button"
          data-testid="plan-review-submit"
          disabled={busy}
          onClick={() => void post('submit')}
          title={compact ? t('planReview.submit') : undefined}
          className={plainButtonClass}
        >
          {label('submit')}
        </button>
        <button
          type="button"
          data-testid="plan-review-approve"
          disabled={busy || confirmingApprove}
          onClick={() => setConfirmingApprove(true)}
          title={compact ? t('planReview.approve') : undefined}
          className={`${buttonClass} border-accent-500 bg-surface text-accent-600 hover:bg-muted dark:bg-surface-2 dark:text-accent-400`}
        >
          {label('approve')}
        </button>
        <button
          type="button"
          data-testid="plan-review-cancel"
          disabled={busy}
          onClick={() => void post('cancel')}
          title={compact ? t('planReview.cancel') : undefined}
          className={plainButtonClass}
        >
          {label('cancel')}
        </button>
      </div>
      {confirmingApprove ? (
        // Pinned too. Compact keeps the question and its answers on one
        // wrapping row rather than two stacked blocks.
        <div
          data-testid="plan-review-approve-confirm"
          role="alertdialog"
          aria-label={t('planReview.approveConfirmLabel')}
          className={`shrink-0 rounded-md border border-warning-border bg-warning-subtle px-2 py-1.5 ${
            compact ? 'flex flex-wrap items-center gap-1.5' : 'space-y-1.5'
          }`}
        >
          <p className={`text-xs text-foreground${compact ? ' min-w-0 flex-1 basis-40' : ''}`}>
            {t('planReview.approveConfirmText')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              data-testid="plan-review-approve-confirm-yes"
              disabled={busy}
              onClick={() => {
                setConfirmingApprove(false);
                void post('approve');
              }}
              className={`${buttonClass} border-accent-500 bg-accent-500 text-white`}
            >
              {t('planReview.approveConfirmYes')}
            </button>
            <button
              type="button"
              data-testid="plan-review-approve-confirm-no"
              onClick={() => setConfirmingApprove(false)}
              className={plainButtonClass}
            >
              {t('planReview.approveConfirmNo')}
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        // Yielding: a refusal can be long (`message` is the server's text).
        <div
          data-testid="plan-review-error"
          role="alert"
          className="max-h-16 min-h-0 space-y-0.5 overflow-y-auto text-xs text-danger-foreground"
        >
          <p>{refusalKey ? t(refusalKey) : t('planReview.refusal.generic')}</p>
          {error.message ? <p data-testid="plan-review-error-detail">{error.message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export default PlanReviewControls;
