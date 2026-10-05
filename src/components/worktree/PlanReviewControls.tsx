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
}

/** The `plan_review_*` refusals this build has a localized sentence for. */
const KNOWN_REFUSAL_KEYS: Record<string, string> = {
  plan_review_ambiguous_answer: 'planReview.refusal.ambiguousAnswer',
  plan_review_busy: 'planReview.refusal.busy',
  plan_review_nothing_to_submit: 'planReview.refusal.nothingToSubmit',
  plan_review_invalid_request: 'planReview.refusal.invalidRequest',
  plan_review_not_active: 'planReview.refusal.notActive',
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
}: PlanReviewControlsProps) {
  const t = useTranslations('worktree');
  const [comment, setComment] = useState('');
  const [confirmingApprove, setConfirmingApprove] = useState(false);
  const [pending, setPending] = useState<PlanReviewControlAction | null>(null);
  const [error, setError] = useState<PlanReviewError | null>(null);

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

  return (
    <div
      data-testid="plan-review-controls"
      role="group"
      aria-label={t('planReview.groupLabel')}
      className="space-y-2 rounded-lg bg-muted px-2 py-1.5"
    >
      <label className="block text-xs text-muted-foreground" htmlFor={`plan-review-comment-${worktreeId}`}>
        {t('planReview.commentLabel')}
      </label>
      <textarea
        id={`plan-review-comment-${worktreeId}`}
        data-testid="plan-review-comment-input"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={t('planReview.commentPlaceholder')}
        rows={2}
        className="w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-surface-2"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid="plan-review-comment"
          disabled={busy || !hasComment}
          onClick={() => void post('comment')}
          className={`${buttonClass} border-border bg-surface text-foreground hover:bg-muted dark:bg-surface-2`}
        >
          {t('planReview.comment')}
        </button>
        <button
          type="button"
          data-testid="plan-review-submit"
          disabled={busy}
          onClick={() => void post('submit')}
          className={`${buttonClass} border-border bg-surface text-foreground hover:bg-muted dark:bg-surface-2`}
        >
          {t('planReview.submit')}
        </button>
        <button
          type="button"
          data-testid="plan-review-approve"
          disabled={busy || confirmingApprove}
          onClick={() => setConfirmingApprove(true)}
          className={`${buttonClass} border-accent-500 bg-surface text-accent-600 hover:bg-muted dark:bg-surface-2 dark:text-accent-400`}
        >
          {t('planReview.approve')}
        </button>
        <button
          type="button"
          data-testid="plan-review-cancel"
          disabled={busy}
          onClick={() => void post('cancel')}
          className={`${buttonClass} border-border bg-surface text-foreground hover:bg-muted dark:bg-surface-2`}
        >
          {t('planReview.cancel')}
        </button>
      </div>
      {confirmingApprove ? (
        <div
          data-testid="plan-review-approve-confirm"
          role="alertdialog"
          aria-label={t('planReview.approveConfirmLabel')}
          className="space-y-1.5 rounded-md border border-warning-border bg-warning-subtle px-2 py-1.5"
        >
          <p className="text-xs text-foreground">{t('planReview.approveConfirmText')}</p>
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
              className={`${buttonClass} border-border bg-surface text-foreground hover:bg-muted dark:bg-surface-2`}
            >
              {t('planReview.approveConfirmNo')}
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div data-testid="plan-review-error" role="alert" className="space-y-0.5 text-xs text-danger-foreground">
          <p>{refusalKey ? t(refusalKey) : t('planReview.refusal.generic')}</p>
          {error.message ? <p data-testid="plan-review-error-detail">{error.message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export default PlanReviewControls;
