/**
 * Answering Command Code's plan review overlay from the CLI / API (Issue #3125).
 *
 * The overlay (`REVIEW` — `Approve ctrl+a` / `Cancel esc` / `type + enter to
 * comment`) is not a dialog with options and not the composer, so neither
 * `respond` (options) nor `send` (composer) could reach it. This module is the
 * one place its keys are decided:
 *
 * | action    | keys                                   | allowed on phase              |
 * |-----------|----------------------------------------|-------------------------------|
 * | `comment` | `Enter`, the text (`-l`), `Enter`      | `body`                        |
 * | `submit`  | [the comment keys], `C-r`              | `body` (needs ≥1 comment)     |
 * | `approve` | `C-a` — or `Enter` on the radio        | `body`, `approve-choice`      |
 * | `cancel`  | `Escape`                               | `body`, `approve-choice`      |
 *
 * Why the comment opens the box with `Enter` first instead of just typing: `?`
 * `x` `!` are one-key quick comments on this screen (measured on 1.58.0), so a
 * comment that begins with one of them would pin a canned sentence instead.
 * An empty `Enter` with the cursor in the plan body only opens the box
 * (measured, #2763 §1 問い 4), and inside the box every key is text.
 *
 * Everything else is refused with nothing sent:
 *  - `action-focus`: `Enter` RUNS the focused action there (#2763 approved a
 *    plan that way), and what the shortcuts and letters do with the focus on
 *    the list was not measured;
 *  - `comment-box`: someone is typing a comment in the pane, and `Escape` there
 *    discards it rather than cancelling the review;
 *  - `unknown`: a hint bar this module has not seen.
 *
 * Approval is only ever the explicit `approve` action. Nothing here is reached
 * by Auto-Yes: the detector publishes this screen with `hasActivePrompt: false`.
 *
 * @module lib/cli-tools/command-code-plan-review
 */

import { sendKeys, sendSpecialKeys } from '../tmux/tmux';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import type { CommandCodePlanReviewState } from '../detection/tools/command-code/plan-review-state';

export const PLAN_REVIEW_ACTIONS = ['comment', 'submit', 'approve', 'cancel'] as const;
export type PlanReviewAction = typeof PLAN_REVIEW_ACTIONS[number];

export function isPlanReviewAction(value: unknown): value is PlanReviewAction {
  return typeof value === 'string' && (PLAN_REVIEW_ACTIONS as readonly string[]).includes(value);
}

/** Refusal reason codes. All of them mean "nothing was sent". */
export const PLAN_REVIEW_REFUSAL = {
  /** The overlay is up, but its focus is somewhere these keys are unsafe. */
  BUSY: 'plan_review_busy',
  /** `submit` with no comment given and none pending. */
  NOTHING_TO_SUBMIT: 'plan_review_nothing_to_submit',
  /** A bare number / yes / no, which would otherwise become a comment. */
  AMBIGUOUS_ANSWER: 'plan_review_ambiguous_answer',
  /** The request does not fit this screen (no text for a comment, `--default`). */
  INVALID_REQUEST: 'plan_review_invalid_request',
} as const;

/** One step on the wire. */
export type PlanReviewKeyStep =
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: 'Enter' | 'Escape' | 'C-a' | 'C-r' };

export interface PlanReviewRequest {
  /** Explicit action; omitted means "the answer text is a comment". */
  action?: PlanReviewAction;
  /** The comment text. */
  text?: string;
  /** `respond --default`, which has no meaning here. */
  useDefault?: boolean;
}

export type PlanReviewPlan =
  | { ok: true; action: PlanReviewAction; steps: PlanReviewKeyStep[]; comment: string | null }
  | { ok: false; reason: string; message: string };

/**
 * A comment the caller did not label as one, that is really an answer meant
 * for an options dialog. Typed as a comment it would land on the plan.
 */
const DIALOG_ANSWER_LIKE = /^(?:\d+(?:\s*,\s*\d+)*|y|yes|n|no)$/i;

/** One line: a newline inside the box would pin the comment half-typed. */
function normalizeComment(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

const PHASE_REFUSALS: Record<string, string> = {
  'action-focus':
    'The plan review has its focus on the action list (`↑/↓ choose · enter to run`), where Enter runs the ' +
    'focused action, so no key was sent. Move the focus back into the plan (↑) in the terminal, then retry.',
  'comment-box':
    'A comment is being typed in the plan review (`enter to pin · esc discard`), so no key was sent. ' +
    'Pin or discard it in the terminal, then retry.',
  unknown:
    'The plan review is up, but its hint bar is not one this version knows, so no key was sent. ' +
    'Answer it in the terminal.',
};

/**
 * Decide the keys for a request against the screen as it is now. Pure.
 *
 * @param state - `readCommandCodePlanReviewState` of the frame about to be answered
 * @param request - what the caller asked for
 */
export function planCommandCodePlanReviewKeys(
  state: CommandCodePlanReviewState,
  request: PlanReviewRequest,
): PlanReviewPlan {
  const comment = request.text === undefined ? '' : normalizeComment(request.text);
  const action: PlanReviewAction = request.action ?? 'comment';

  if (request.useDefault) {
    return {
      ok: false,
      reason: PLAN_REVIEW_REFUSAL.INVALID_REQUEST,
      message:
        'The plan review has no default option. Comment with text, or choose ' +
        '--plan-review submit | approve | cancel.',
    };
  }
  if ((action === 'approve' || action === 'cancel') && comment) {
    return {
      ok: false,
      reason: PLAN_REVIEW_REFUSAL.INVALID_REQUEST,
      message: `--plan-review ${action} takes no text. Comment first, then ${action}.`,
    };
  }
  if (action === 'comment' && !comment) {
    return {
      ok: false,
      reason: PLAN_REVIEW_REFUSAL.INVALID_REQUEST,
      message: 'A plan review comment needs text.',
    };
  }
  if (request.action === undefined && DIALOG_ANSWER_LIKE.test(comment)) {
    return {
      ok: false,
      reason: PLAN_REVIEW_REFUSAL.AMBIGUOUS_ANSWER,
      message:
        `The plan review has no numbered options, and "${comment}" would be pinned to the plan as a ` +
        'comment, so no key was sent. Approve or cancel with --plan-review approve | cancel; to really ' +
        'comment this text, add --plan-review comment.',
    };
  }

  if (state.phase === 'approve-choice') {
    // The radio `ctrl+a` opens when comments are pending (1.58.0): `enter
    // confirm · esc back`. Enter confirms whichever side is `(•)`.
    if (action === 'approve') return { ok: true, action, steps: [{ kind: 'key', key: 'Enter' }], comment: null };
    if (action === 'cancel') return { ok: true, action, steps: [{ kind: 'key', key: 'Escape' }], comment: null };
    return {
      ok: false,
      reason: PLAN_REVIEW_REFUSAL.BUSY,
      message:
        'The plan review is asking how to approve (`←/→ choose · enter confirm · esc back`), so no key was ' +
        'sent. Confirm with --plan-review approve, or go back with --plan-review cancel.',
    };
  }
  if (state.phase !== 'body') {
    return { ok: false, reason: PLAN_REVIEW_REFUSAL.BUSY, message: PHASE_REFUSALS[state.phase] };
  }

  const commentSteps: PlanReviewKeyStep[] = comment
    ? [{ kind: 'key', key: 'Enter' }, { kind: 'text', text: comment }, { kind: 'key', key: 'Enter' }]
    : [];

  switch (action) {
    case 'comment':
      return { ok: true, action, steps: commentSteps, comment };
    case 'submit':
      if (!comment && state.pendingComments === 0) {
        return {
          ok: false,
          reason: PLAN_REVIEW_REFUSAL.NOTHING_TO_SUBMIT,
          message:
            'The plan review has no pending comment to submit, so no key was sent. Give the comment text ' +
            'with --plan-review submit, or approve / cancel the plan.',
        };
      }
      return { ok: true, action, steps: [...commentSteps, { kind: 'key', key: 'C-r' }], comment: comment || null };
    case 'approve':
      return { ok: true, action, steps: [{ kind: 'key', key: 'C-a' }], comment: null };
    case 'cancel':
      return { ok: true, action, steps: [{ kind: 'key', key: 'Escape' }], comment: null };
  }
}

/** Pause between steps, so the TUI handles each one as its own input event. */
export const PLAN_REVIEW_STEP_DELAY_MS = 300;

/**
 * Send the planned steps, one tmux invocation each.
 *
 * `C-r` goes through `sendKeys` (a fixed key name, not user text) because the
 * special-keys allow-list in `lib/tmux` does not carry it; the comment text
 * goes through `-l` so it is never resolved as a key name.
 */
export async function sendCommandCodePlanReviewKeys(
  sessionName: string,
  steps: readonly PlanReviewKeyStep[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind === 'text') {
      await sendKeys(sessionName, step.text, false, { literal: true });
    } else if (step.key === 'C-r') {
      await sendKeys(sessionName, 'C-r', false);
    } else {
      await sendSpecialKeys(sessionName, [step.key]);
    }
    if (i < steps.length - 1) await sleep(PLAN_REVIEW_STEP_DELAY_MS);
  }
  invalidateCache(sessionName);
}
