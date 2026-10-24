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
 * Issue #3798: a record that names its episode (`episodeId`) is matched to a
 * wait that names one by that id instead, since two episodes can share a
 * `since`; either side without an id falls back to the time comparison. A
 * record of the episode the poller then answered (`lastAnswer`), written
 * before that answer, is not the wait's reason any more: the success path of
 * a send does not clear the record, and the answer is the newer fact.
 *
 * The poller re-evaluates a suppressed prompt on every poll (the duplicate
 * guard only remembers *answered* prompts), so `at` stays current for as long
 * as the prompt is on screen. At the opening edge the record may not exist yet
 * — the poller writes it on its own interval — and the wait is then treated as
 * one Auto-Yes is about to answer. That is deliberate: it is the common case,
 * it resolves in seconds, and the reminder below is what catches it when it
 * does not.
 *
 * ## "About to answer" has a deadline (Issue #3757)
 *
 * Nothing recorded is not proof that Auto-Yes is answering. A screen the poller
 * cannot read at all (agy's folder-trust screen was the measured case: the
 * poller read no prompt, so it recorded nothing) looked exactly like the
 * common case above, and the wait was held silent until the ten-minute
 * reminder. So the hold lasts {@link AUTO_YES_ANSWER_GRACE_MS} — time for the
 * poller to answer or to record why it did not — and a wait still open after
 * that notifies as `auto-yes-not-answered`. `waiting-push-notifier` asks again
 * when the hold ends.
 *
 * The hold is NOT counted from `waitingSince`. That is the wait's identity,
 * not when anyone saw it: it can be a hook's timestamp older than the probe
 * that opened the edge, and it stays frozen across several prompts of one
 * episode. It is counted from {@link autoYesHoldStartedAt}: the later of the
 * moment the gate first held this episode and the poller's last answer, so a
 * second prompt right after an answer gets a full hold of its own. Both
 * producers ask through {@link decideAndLogPromptPush} and share that origin.
 *
 * ## Which hold belongs to which wait (Issue #3798)
 *
 * A wait is named by its episode id when the caller has one
 * (`waitingEpisodeId`), and by `waitingSince` when it does not. The two are
 * matched by the rule {@link isSameWait} states, the same rule the episode
 * dedup in `notification-dedup` uses: both ids present and equal, or one of
 * them absent and the `since`s equal. So an id-less producer (opencode's
 * question push, or the response poller when its commit changed nothing —
 * otherwise it names the episode it committed) and the id-bearing notifier asking about
 * one wait share one hold, and the session wait's tick (#3796) is read once,
 * when that hold begins. A rebind keeps the id, so it keeps the hold and its
 * end; a replacement brings a new id, so it begins a new hold that reads the
 * tick at its own start — even when the new wait reuses the old `since`.
 *
 * ## The hold reaches the session wait's tick (Issue #3791)
 *
 * The 9 s assume the poller's next tick is at most a cooldown away. Its ticks
 * are a poll interval, a cooldown or the thinking interval (5 s) apart — inside
 * the 9 s — with two exceptions. An error backoff (up to `MAX_BACKOFF_MS`) is
 * not waited for: a poller failing in a row is the least likely to answer, and
 * a broken Auto-Yes is when a human most needs the notification. The session
 * wait is: a capture that found no session puts the next tick `MAX_BACKOFF_MS`
 * away, and a session started meanwhile (`send --auto-yes` enables Auto-Yes
 * before the session exists) gets its first prompt answered on that tick. So
 * when the hold begins while that tick is pending, it lasts until the tick plus
 * two ticks (answer, or the Enter fallback's second look):
 * {@link autoYesHoldEndsAt}. The tick is read once, and only counts while the
 * poller that scheduled it is still the one running — a poller stopped or
 * replaced meanwhile will not tick. Issue #3796: the session's creation brings
 * that tick forward to a poll interval, and the hold follows it — the tick is
 * only ever read earlier than it was when the hold began.
 *
 * ## A wait the poller answered is not "not answered" (Issue #3798)
 *
 * The poller records which episode its answer went to (`lastAnswer`, read off
 * its state on `globalThis` like the answer's time), and closes that episode
 * when the confirmation is gone. Until a frame says so — the agent works on
 * over frames no rule reads — the episode stays open, and its hold can run
 * out. That end is not "Auto-Yes did not answer": when the wait asked about
 * names its id and it is the answered episode, still open and not a screen
 * only a person drives, the gate says `auto-yes-answered` and stays quiet.
 * Another confirmation in the same turn is another episode (R1-7), and a
 * survey or a picker after the answer turns the episode into a `screen`: both
 * notify as before. Without an id on either side nothing is matched, and the
 * hold's end notifies as before. The hold itself is unchanged — its start, its
 * end and the session wait's tick (#3796) are counted as above.
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

import {
  buildCompositeKey,
  COOLDOWN_INTERVAL_MS,
  getAutoYesState,
  MAX_BACKOFF_MS,
  POLLING_INTERVAL_MS,
  type AutoYesStopReason,
} from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import type { AutoYesSuppressionReason } from '@/lib/polling/auto-yes-resolver';
import {
  getLastPolicySuppression,
  type EpisodeScopedPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { getOrInitGlobal } from '@/lib/global-state';
import type { AutoYesPollerState } from '@/lib/polling/auto-yes-poller-state';
import { getWaitingEpisodeRecord } from '@/lib/session/waiting-episode-state';

const logger = createLogger('push/prompt-gate');

/**
 * How long a wait with nothing recorded about it is held as "Auto-Yes is
 * answering" (Issue #3757), from {@link autoYesHoldStartedAt}. The poller
 * answers a prompt it can read on the tick that sees it and records a reason
 * on the same tick when it will not, but that tick can be a cooldown away
 * (`COOLDOWN_INTERVAL_MS` after an answer, as long while thinking), and the
 * Enter fallback needs one more tick: a cooldown plus two ticks, 9 s.
 */
export const AUTO_YES_ANSWER_GRACE_MS = Math.max(
  3 * POLLING_INTERVAL_MS,
  COOLDOWN_INTERVAL_MS + 2 * POLLING_INTERVAL_MS,
);

/** When the gate first held one waiting episode as `auto-yes-answering`. */
interface AutoYesHoldStart {
  /** The episode's `waitingSince`: a new episode starts a new hold. */
  since: number;
  /**
   * The episode's id (Issue #3798), once any caller named it. Written into a
   * hold an id-less caller began, the first time an id-bearing caller asks
   * about the same wait.
   */
  episodeId?: string;
  firstHeldAt: number;
  /**
   * Issue #3791: the session wait's tick pending when the hold began
   * (`sessionWaitTickAt`), and the poller that scheduled it. Undefined: none
   * pending — the grace alone bounds the hold.
   */
  sessionWaitTick?: { at: number; poller: AutoYesPollerState; heldAt: number };
}

declare global {
  // eslint-disable-next-line no-var
  var __promptPushAutoYesHolds: Map<string, AutoYesHoldStart> | undefined;
}

/** compositeKey -> the hold of that session's current episode. globalThis per #1736. */
const autoYesHolds = getOrInitGlobal('__promptPushAutoYesHolds', () => new Map<string, AutoYesHoldStart>());

/** How a caller names one wait (Issue #3798): its `since`, and its episode id when known. */
export interface WaitIdentity {
  since: number;
  episodeId?: string | null;
}

/**
 * Whether two names are the same wait (Issue #3798): both ids present and
 * equal, or one of them absent and the `since`s equal. The id decides whenever
 * both sides have one — two waits can share a `since` (the same millisecond, a
 * structured `at` reused by the next prompt), and one wait keeps its id across
 * a rebind.
 */
export function isSameWait(a: WaitIdentity, b: WaitIdentity): boolean {
  const aId = a.episodeId ?? null;
  const bId = b.episodeId ?? null;
  if (aId !== null && bId !== null) return aId === bId;
  return a.since === b.since;
}

/**
 * Where this wait's `auto-yes-answering` hold is counted from (Issue #3757):
 * the later of the moment the gate first held this episode (recorded here on
 * the first call) and the Auto-Yes poller's last answer to this session.
 *
 * The poller's answer is read off its state on `globalThis`
 * (`__autoYesPollerStates`, `lastServerResponseTimestamp`) rather than through
 * `auto-yes-poller`, which imports `response-checker`, which imports this gate.
 *
 * @param now - Epoch ms of the decision; recorded as the start of a new hold
 */
export function autoYesHoldStartedAt(
  input: Pick<PromptPushGateInput, 'worktreeId' | 'cliToolId' | 'instanceId' | 'waitingSince' | 'waitingEpisodeId'>,
  now: number,
): number {
  const key = buildCompositeKey(input.worktreeId, input.cliToolId, input.instanceId);
  sweepStaleAutoYesHolds(now);
  const episodeId = input.waitingEpisodeId ?? undefined;
  let hold = autoYesHolds.get(key);
  if (hold === undefined || !isSameWait(hold, { since: input.waitingSince, episodeId })) {
    hold = {
      since: input.waitingSince,
      ...(episodeId !== undefined ? { episodeId } : {}),
      firstHeldAt: now,
      sessionWaitTick: pendingSessionWaitTick(key, now),
    };
    autoYesHolds.set(key, hold);
  } else if (hold.episodeId === undefined && episodeId !== undefined) {
    // Issue #3798: an id-less caller began this hold; the wait is now named.
    hold.episodeId = episodeId;
  }
  // Issue #3770: Auto-Yes switched off and on again inside one episode starts a
  // fresh hold; the old origin would read the poller's silence while it was off
  // as "did not answer".
  const enabledAt = getAutoYesState(input.worktreeId, input.cliToolId, input.instanceId)?.enabledAt;
  if (enabledAt !== undefined && enabledAt > hold.firstHeldAt && enabledAt <= now) hold.firstHeldAt = enabledAt;
  const lastAnswer = globalThis.__autoYesPollerStates?.get(key)?.lastServerResponseTimestamp ?? null;
  return lastAnswer !== null ? Math.max(hold.firstHeldAt, lastAnswer) : hold.firstHeldAt;
}

/**
 * How long after the poller's tick the hold still lasts (Issue #3791): that
 * tick answers, or records why not, and the Enter fallback answers on the tick
 * after it — the "two ticks" of {@link AUTO_YES_ANSWER_GRACE_MS}.
 */
export const AUTO_YES_ANSWER_AFTER_TICK_MS = 2 * POLLING_INTERVAL_MS;

/**
 * The Auto-Yes poller's pending session-wait tick (Issue #3791), read off its
 * state on `globalThis` for the same reason as `lastServerResponseTimestamp`.
 * Only a tick due after `now`, and no further than the session wait puts it.
 */
function pendingSessionWaitTick(key: string, now: number): AutoYesHoldStart['sessionWaitTick'] {
  const poller = globalThis.__autoYesPollerStates?.get(key);
  const at = poller?.sessionWaitTickAt;
  if (poller === undefined || at === undefined || at <= now) return undefined;
  return { at: Math.min(at, now + MAX_BACKOFF_MS), poller, heldAt: now };
}

/**
 * Issue #3796: when the session wait's tick the hold counts on actually comes.
 * The tick read when the hold began, brought forward when the poller ticked
 * early — its session was created, and it rescheduled the tick a poll interval
 * away (`sessionWaitTickAt`), or already ran it (`sessionWaitTickRanAt`,
 * `sessionAppearedAt`) — only times since the hold began count. Only
 * ever earlier: a session wait scheduled after the hold began does not extend
 * it (#3791).
 */
function effectiveSessionWaitTickAt(tick: NonNullable<AutoYesHoldStart['sessionWaitTick']>): number {
  let at = tick.at;
  for (const t of [tick.poller.sessionWaitTickAt, tick.poller.sessionWaitTickRanAt, tick.poller.sessionAppearedAt]) {
    if (t !== undefined && t >= tick.heldAt && t < at) at = t;
  }
  return at;
}

/**
 * When this wait's `auto-yes-answering` hold ends (Issue #3791): a full
 * {@link AUTO_YES_ANSWER_GRACE_MS} after {@link autoYesHoldStartedAt}, and not
 * before {@link AUTO_YES_ANSWER_AFTER_TICK_MS} past the session wait's tick
 * pending when the hold began — while the poller that scheduled it still runs.
 *
 * @param now - Epoch ms of the decision; recorded as the start of a new hold
 */
export function autoYesHoldEndsAt(
  input: Pick<PromptPushGateInput, 'worktreeId' | 'cliToolId' | 'instanceId' | 'waitingSince' | 'waitingEpisodeId'>,
  now: number,
): number {
  const startedAt = autoYesHoldStartedAt(input, now);
  const key = buildCompositeKey(input.worktreeId, input.cliToolId, input.instanceId);
  const tick = autoYesHolds.get(key)?.sessionWaitTick;
  const graceEndsAt = startedAt + AUTO_YES_ANSWER_GRACE_MS;
  // A poller stopped or replaced since (disable, off → on) will not tick.
  if (tick === undefined || globalThis.__autoYesPollerStates?.get(key) !== tick.poller) return graceEndsAt;
  // Kept on the hold: an earlier tick once adopted is not lost when the poller
  // later reschedules (an ordinary tick after a failed capture, a new session
  // wait) — the hold never moves back out.
  tick.at = effectiveSessionWaitTickAt(tick);
  return Math.max(graceEndsAt, tick.at + AUTO_YES_ANSWER_AFTER_TICK_MS);
}

/** A hold older than this is dropped (Issue #3770): its episode is long over. */
export const AUTO_YES_HOLD_MAX_AGE_MS = 60 * 60 * 1000;

function sweepStaleAutoYesHolds(now: number): void {
  for (const [key, hold] of autoYesHolds) {
    if (now - hold.firstHeldAt >= AUTO_YES_HOLD_MAX_AGE_MS) autoYesHolds.delete(key);
  }
}

/**
 * Drop the hold of one session (Issue #3770): Auto-Yes went off, or the
 * episode closed.
 *
 * @param wait - Issue #3776: drop it only when it is this episode's hold. A
 *   caller retiring one episode must not take the next episode's origin with it
 *   (that hold would start over, and its notification come up to a hold late).
 *   A number is the episode's `since`; Issue #3798 adds the episode's id, matched
 *   by {@link isSameWait}. Omitted, the session's hold goes whatever its episode.
 */
export function forgetAutoYesHold(key: string, wait?: number | WaitIdentity): void {
  if (wait !== undefined) {
    const hold = autoYesHolds.get(key);
    if (hold === undefined) return;
    const identity: WaitIdentity = typeof wait === 'number' ? { since: wait } : wait;
    if (!isSameWait(hold, identity)) return;
  }
  autoYesHolds.delete(key);
}

/** Forget every hold. Test seam. */
export function clearAutoYesHolds(): void {
  autoYesHolds.clear();
}

/** The wait a prompt notification is about, as the gate needs to see it. */
export interface PromptPushGateInput {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Omitted for the primary instance, exactly as `buildCompositeKey` expects. */
  instanceId?: string;
  /** The waiting episode's `since` (#1786) — the wait's identity, not its age. */
  waitingSince: number;
  /**
   * The waiting episode's id (Issue #3798), when the caller knows it. Matched
   * to holds and suppression records by {@link isSameWait}; omitted, the
   * `since` comparisons of #3757 / #1684 apply.
   */
  waitingEpisodeId?: string | null;
  /** True for the "still waiting" reminder (#1790), which is never suppressed. */
  escalated?: boolean;
  /** Epoch ms the decision is made at; defaults to now (Issue #3757). */
  now?: number;
  /**
   * Where the `auto-yes-answering` hold is counted from (Issue #3757). Omitted,
   * the hold has no end — {@link decideAndLogPromptPush} fills it in from
   * {@link autoYesHoldStartedAt}.
   */
  holdStartedAt?: number;
  /**
   * When the hold ends (Issue #3791); takes the place of `holdStartedAt` plus
   * the grace when given. {@link decideAndLogPromptPush} fills it in from
   * {@link autoYesHoldEndsAt}.
   */
  holdEndsAt?: number;
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
  | 'auto-yes-answering'
  /**
   * Issue #3757: Auto-Yes is on, nothing says why it has not answered, and
   * {@link AUTO_YES_ANSWER_GRACE_MS} has passed — it is not going to.
   */
  | 'auto-yes-not-answered'
  /**
   * Issue #3798: the hold is over, but the poller answered this very episode
   * ({@link autoYesAnsweredWait}) and it has not closed yet. Quiet; the
   * notifier asks again while the wait lasts.
   */
  | 'auto-yes-answered';

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
  const { worktreeId, cliToolId, instanceId } = input;

  const state = getAutoYesState(worktreeId, cliToolId, instanceId);
  if (state === null || !state.enabled) {
    return { suppress: false, reason: 'auto-yes-inactive', stopReason: state?.stopReason };
  }

  const suppression = getLastPolicySuppression(worktreeId, cliToolId, instanceId);
  if (
    suppression !== null &&
    suppressionBelongsToWait(suppression, input) &&
    !suppressionPredatesAnswer(suppression, input)
  ) {
    return { suppress: false, reason: 'policy-withheld', suppressedBy: suppression.reason };
  }

  if (input.escalated === true) {
    return { suppress: false, reason: 'escalation-reminder' };
  }

  const holdEndsAt =
    input.holdEndsAt ?? (input.holdStartedAt !== undefined ? input.holdStartedAt + AUTO_YES_ANSWER_GRACE_MS : undefined);
  if (holdEndsAt !== undefined && (input.now ?? Date.now()) >= holdEndsAt) {
    if (autoYesAnsweredWait(input)) return { suppress: true, reason: 'auto-yes-answered' };
    return { suppress: false, reason: 'auto-yes-not-answered' };
  }

  return { suppress: true, reason: 'auto-yes-answering' };
}

/**
 * Whether the Auto-Yes poller answered this wait (Issue #3798): the caller
 * names the episode, the poller's `lastAnswer` names the same one, and that
 * episode is still the one open and not a screen only a person drives (a
 * survey or a picker after the answer is rebound to `screen` under the same
 * id, and a person has to act on it). Read off the poller state on
 * `globalThis`, as {@link autoYesHoldStartedAt} reads the answer's time.
 */
export function autoYesAnsweredWait(
  input: Pick<PromptPushGateInput, 'worktreeId' | 'cliToolId' | 'instanceId' | 'waitingEpisodeId'>,
): boolean {
  const waitId = input.waitingEpisodeId ?? null;
  if (waitId === null || answerTo(input)?.episodeId !== waitId) return false;
  const episode = getWaitingEpisodeRecord(input.worktreeId, input.cliToolId, input.instanceId);
  return episode !== null && episode.episodeId === waitId && episode.binding.kind !== 'screen';
}

/** The poller's `lastAnswer` for this instance, read off `globalThis` (Issue #3798). */
function answerTo(
  input: Pick<PromptPushGateInput, 'worktreeId' | 'cliToolId' | 'instanceId'>,
): { episodeId: string; at: number } | null {
  const key = buildCompositeKey(input.worktreeId, input.cliToolId, input.instanceId);
  return globalThis.__autoYesPollerStates?.get(key)?.lastAnswer ?? null;
}

/**
 * Whether the policy's reason for this wait is older than the answer the
 * poller then sent to it (Issue #3798): the same episode withheld once — a
 * contract that changed, a lookup that failed — and answered after, by a send
 * whose success path does not clear the record. The answer is the newer fact,
 * so the record is not this wait's reason any more. A suppression written at
 * or after the answer, one for another episode, and a caller that names no
 * episode keep #1684's `policy-withheld`.
 */
function suppressionPredatesAnswer(
  suppression: EpisodeScopedPolicySuppression,
  input: Pick<PromptPushGateInput, 'worktreeId' | 'cliToolId' | 'instanceId' | 'waitingEpisodeId'>,
): boolean {
  const waitId = input.waitingEpisodeId ?? null;
  if (waitId === null) return false;
  const answer = answerTo(input);
  return answer !== null && answer.episodeId === waitId && suppression.at < answer.at;
}

/**
 * Whether a policy-suppression record is about this wait (Issue #3798). By the
 * episode id when both the record and the caller carry one — a record written
 * for an earlier episode is not this wait's reason however recent its `at` —
 * and by #1684's `at >= waitingSince` otherwise.
 */
function suppressionBelongsToWait(
  suppression: EpisodeScopedPolicySuppression,
  input: Pick<PromptPushGateInput, 'waitingSince' | 'waitingEpisodeId'>,
): boolean {
  const waitId = input.waitingEpisodeId ?? null;
  if (suppression.episodeId !== undefined && waitId !== null) return suppression.episodeId === waitId;
  return suppression.at >= input.waitingSince;
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
  return decideAndLogPromptPush(input).suppress;
}

/**
 * {@link isPromptPushSuppressed}, with the whole decision handed back — for the
 * caller that has to ask again when an `auto-yes-answering` hold ends
 * (`waiting-push-notifier`, Issue #3757).
 */
export function decideAndLogPromptPush(
  input: PromptPushGateInput,
  options: { recheck?: boolean } = {},
): PromptPushGateDecision {
  let decision = decidePromptPush(input);
  if (decision.reason === 'auto-yes-inactive') {
    forgetAutoYesHold(buildCompositeKey(input.worktreeId, input.cliToolId, input.instanceId));
  }
  // Issue #3757: only a wait that reached the hold gets an origin recorded.
  if (decision.reason === 'auto-yes-answering' && input.holdStartedAt === undefined && input.holdEndsAt === undefined) {
    const now = input.now ?? Date.now();
    decision = decidePromptPush({ ...input, now, holdEndsAt: autoYesHoldEndsAt(input, now) });
  }
  const context = {
    worktreeId: input.worktreeId,
    cliToolId: input.cliToolId,
    instanceId: input.instanceId ?? input.cliToolId,
    waitingSince: input.waitingSince,
    ...(input.waitingEpisodeId ? { waitingEpisodeId: input.waitingEpisodeId } : {}),
    escalated: input.escalated === true,
    reason: decision.reason,
    ...(decision.stopReason !== undefined ? { stopReason: decision.stopReason } : {}),
    ...(decision.suppressedBy !== undefined ? { suppressedBy: decision.suppressedBy } : {}),
  };

  // A re-ask at the end of a hold (Issue #3757) that holds again was already
  // logged when the hold began.
  if (decision.suppress && options.recheck === true) logger.debug('prompt-push-suppressed', context);
  else if (decision.suppress) logger.info('prompt-push-suppressed', context);
  else if (decision.reason === 'auto-yes-not-answered') logger.info('prompt-push-allowed', context);
  else logger.debug('prompt-push-allowed', context);

  return decision;
}
