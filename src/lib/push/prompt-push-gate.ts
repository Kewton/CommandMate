/**
 * Whether a prompt push notification still describes something a human has to
 * do (Issue #1999).
 *
 * Auto-Yes is a standing declaration that this session's prompts get answered
 * without a human, so a phone that buzzes for every one of them tells the
 * reader the opposite of the truth: by the time the notification is opened the
 * answer has already been sent. During a parallel orchestration — several
 * workers all running under Auto-Yes — that is most of the traffic, which is
 * what makes the phone unusable rather than merely noisy.
 *
 * ## Why the gate is here and not inside `notifyPushSubscribers`
 *
 * `NotificationEvent` carries `instanceId` but no `cliToolId`, and every
 * Auto-Yes lookup is keyed by `buildCompositeKey(worktreeId, cliToolId,
 * instanceId)`. An alias instance (`claude-2`) does not name its tool, so the
 * tool cannot be recovered from the event — the fan-out does not hold enough to
 * ask the question with. Both producers do, so the gate runs there.
 *
 * It also has to run *before* the fan-out for a second, independent reason:
 * `shouldSendWaitingPush` records the episode at the moment it decides to send
 * (`notification-dedup`), so a notification dropped after that call would still
 * consume the episode's one slot and take the escalation reminder down with it.
 *
 * ## What still notifies
 *
 * Everything that is not "Auto-Yes will deal with this in a moment":
 *
 *  - **No Auto-Yes, or Auto-Yes off.** `getAutoYesState` collapses every stop
 *    into `enabled === false`: it calls `disableAutoYes(…, 'expired', …)` on an
 *    expired state before returning it, and `disableAutoYes` writes
 *    `enabled: false` for `stop_pattern_matched` and `consecutive_errors`
 *    alike. One `enabled` read therefore covers all four rows of the Issue's
 *    table, and a stop reason nobody remembered to enumerate here fails towards
 *    notifying rather than towards silence.
 *  - **The contract policy withheld the answer** (#1547 / #1684). Auto-Yes is
 *    on but has decided *not* to answer this prompt, so nothing moves until a
 *    human acts.
 *  - **The escalation reminder** (#1790). See below.
 *
 * ## Which suppression record belongs to which wait
 *
 * `getLastPolicySuppression` keeps the *last* withheld answer per session and
 * never clears it, so the record outlives the wait it was about. #1684 defines
 * the reading: a record is the reason the session is stopped right now when its
 * `at` lines up with the current wait. Here that is `at >= waitingSince` — the
 * suppression was recorded at or after this episode opened. A record from an
 * earlier episode is older than `since` and is ignored.
 *
 * The poller re-evaluates a suppressed prompt on every poll (the duplicate
 * guard only remembers *answered* prompts), so `at` stays current for as long
 * as the prompt is on screen. At the opening edge the record may not exist yet
 * — the poller writes it on its own interval — and the wait is then treated as
 * one Auto-Yes is about to answer. That is deliberate: it is the common case,
 * it resolves in seconds, and the reminder below is what catches it when it
 * does not.
 *
 * ## The reminder is never muted
 *
 * `runEscalationTick` has already established that the wait is still open — it
 * re-reads `getWaitingEpisode` and drops anything Auto-Yes answered — so a wait
 * that reaches the threshold is one Auto-Yes did not resolve after ten minutes
 * of re-evaluating it every couple of seconds. The suppression record cannot be
 * relied on to explain why: a prompt the resolver has no answer for (free text,
 * or a type it does not recognise) returns `suppressedBy: null`, so nothing is
 * recorded and that stall is invisible to the check above. Muting the reminder
 * as well would make Auto-Yes a permanent mute for exactly the pipelines that
 * got stuck.
 *
 * @module lib/push/prompt-push-gate
 */

import { getAutoYesState, type AutoYesStopReason } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import type { AutoYesSuppressionReason } from '@/lib/polling/auto-yes-resolver';
import { getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';

const logger = createLogger('push/prompt-gate');

/** The wait a prompt notification is about, as the gate needs to see it. */
export interface PromptPushGateInput {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Omitted for the primary instance, exactly as `buildCompositeKey` expects. */
  instanceId?: string;
  /** The waiting episode's `since` (#1786) — the wait's identity, not its age. */
  waitingSince: number;
  /** True for the "still waiting" reminder (#1790), which is never suppressed. */
  escalated?: boolean;
}

/**
 * Why the gate decided as it did. Carried into the log line so that "the phone
 * stayed quiet" can be told apart from "the notification path is broken".
 */
export type PromptPushGateReason =
  /** No Auto-Yes state, or one that is off — including every stop reason. */
  | 'auto-yes-inactive'
  /** Auto-Yes is on but the contract policy withheld the answer to this wait. */
  | 'policy-withheld'
  /** The #1790 reminder for a wait Auto-Yes has not resolved. */
  | 'escalation-reminder'
  /** Auto-Yes is on and about to answer: the one case that stays quiet. */
  | 'auto-yes-answering';

export interface PromptPushGateDecision {
  /** True when no notification should be fanned out for this wait. */
  suppress: boolean;
  reason: PromptPushGateReason;
  /** The Auto-Yes stop reason, when the state carries one. Log context. */
  stopReason?: AutoYesStopReason;
  /** Why the policy withheld the answer, for `reason: 'policy-withheld'`. */
  suppressedBy?: AutoYesSuppressionReason;
}

/**
 * Decide whether this prompt notification is worth a human's attention.
 *
 * Reads Auto-Yes state and the policy-suppression record; writes neither.
 * Separated from {@link isPromptPushSuppressed} so a test can assert the reason
 * rather than only the outcome.
 */
export function decidePromptPush(input: PromptPushGateInput): PromptPushGateDecision {
  const { worktreeId, cliToolId, instanceId, waitingSince } = input;

  const state = getAutoYesState(worktreeId, cliToolId, instanceId);
  if (state === null || !state.enabled) {
    return { suppress: false, reason: 'auto-yes-inactive', stopReason: state?.stopReason };
  }

  const suppression = getLastPolicySuppression(worktreeId, cliToolId, instanceId);
  if (suppression !== null && suppression.at >= waitingSince) {
    return { suppress: false, reason: 'policy-withheld', suppressedBy: suppression.reason };
  }

  if (input.escalated === true) {
    return { suppress: false, reason: 'escalation-reminder' };
  }

  return { suppress: true, reason: 'auto-yes-answering' };
}

/**
 * {@link decidePromptPush}, logged.
 *
 * The single call both prompt-push producers make. A suppression is logged at
 * `info` because a notification that never arrived is indistinguishable from a
 * broken notifier from the outside, and the operator needs the worktree, the
 * instance, the wait and the reason to tell them apart
 * (`docs/design/discoverability-principle.md`). The notifying decisions are
 * logged at `debug`: they end in a notification the operator can already see,
 * so the line is only there for the "why did this one ring?" question.
 */
export function isPromptPushSuppressed(input: PromptPushGateInput): boolean {
  const decision = decidePromptPush(input);
  const context = {
    worktreeId: input.worktreeId,
    cliToolId: input.cliToolId,
    instanceId: input.instanceId ?? input.cliToolId,
    waitingSince: input.waitingSince,
    escalated: input.escalated === true,
    reason: decision.reason,
    ...(decision.stopReason !== undefined ? { stopReason: decision.stopReason } : {}),
    ...(decision.suppressedBy !== undefined ? { suppressedBy: decision.suppressedBy } : {}),
  };

  if (decision.suppress) logger.info('prompt-push-suppressed', context);
  else logger.debug('prompt-push-allowed', context);

  return decision.suppress;
}
