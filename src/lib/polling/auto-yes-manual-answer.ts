/**
 * A person's answer through `/prompt-response`, as Auto-Yes's poller sees it
 * (Issue #3821, review 2).
 *
 * Dropping the published decision is not enough to keep the poller's keys off
 * a confirmation a person is answering: a tick already past its checks — the
 * ownership check, a wait inside the send — acts for its generation (#3706),
 * which a manual answer did not touch. So the start of a manual answer
 *
 *  - moves the instance's manual-answer sequence on; a tick whose generation
 *    was taken under an earlier one is no longer current (`isTickCurrent`) and
 *    sends no further key;
 *  - holds the instance for {@link MANUAL_ANSWER_HOLD_MS}: a tick that reads a
 *    confirmation meanwhile leaves it to the person (`answered-by-human`)
 *    instead of answering what they may be answering right now;
 *  - drops the published decision.
 *
 * How the answer ENDED decides what happens to an answer the poller holds at
 * that confirmation (Issue #3880, {@link settleManualAnswer}).
 *
 * Auto-Yes itself stays on: past the hold the poller answers again.
 *
 * In-memory and on `globalThis` (the route and the poller are bundled apart
 * under `next dev`).
 *
 * @module lib/polling/auto-yes-manual-answer
 */

import { DUPLICATE_RETRY_EXPIRY_MS } from '@/lib/auto-yes-state';
import { getOrInitGlobal } from '../global-state';
import { forgetAutoYesDecision } from './auto-yes-decision-state';
import {
  beginManualSendAttempt,
  nextSendOrder,
  partialAnswerScreenKey,
  releasePartialAnswerToHuman,
  settleSendAttempt,
  UNIDENTIFIED_SCREEN_KEY,
  holdOriginOf,
  type AutoYesSendAttempt,
  type HoldOrigin,
} from './auto-yes-poller-state';
import type { PromptData } from '@/types/models';
import { deliveryMayBeOnPane, type AnswerDelivery, type PaneAnswerContext } from '@/lib/session/pane-answer-context';

/** How long a manual answer keeps the poller off the instance's confirmations. */
export const MANUAL_ANSWER_HOLD_MS = DUPLICATE_RETRY_EXPIRY_MS;

/** The decision reason a tick withholds under while the hold lasts. */
export const ANSWERED_BY_HUMAN_DECISION_REASON = 'answered-by-human';

interface ManualAnswerMark {
  seq: number;
  at: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __autoYesManualAnswers: Map<string, ManualAnswerMark> | undefined;
}

const marks = getOrInitGlobal('__autoYesManualAnswers', () => new Map<string, ManualAnswerMark>());

/**
 * One person's answer, from its start to its end (Issue #3880). What its end
 * does to Auto-Yes's hold is about THIS answer, in two orders kept apart: the
 * hold it releases is one recorded before it began (`order`), and what its
 * send records is ordered by that send — its place among the sends, the screen
 * and the session epoch all fixed right before the first key.
 */
export interface ManualAnswerTicket {
  readonly compositeKey: string;
  /** Where it began among the sends (`nextSendOrder`): the cutoff of the hold it releases. */
  readonly order: number;
  /** Its send, from right before the first key ({@link noteManualSendStarting}). */
  attempt: AutoYesSendAttempt | null;
}

/** A person began answering on this instance (called before the first key or API call). */
export function noteManualAnswerStarted(compositeKey: string, at: number = Date.now()): ManualAnswerTicket {
  marks.set(compositeKey, { seq: (marks.get(compositeKey)?.seq ?? 0) + 1, at });
  forgetAutoYesDecision(compositeKey);
  return { compositeKey, order: nextSendOrder(), attempt: null };
}

/**
 * The person's keys are about to go out (Issue #3880), at the confirmation
 * `promptData` is — or, when no prompt could be read off the screen (the
 * capture before the send failed), at an unidentified one. Registered as a
 * send in flight, so a screen seen gone, a relaunch, or a worktree going away
 * before it ends keeps its end from recording a hold.
 */
export function noteManualSendStarting(ticket: ManualAnswerTicket, promptData: PromptData | null | undefined): void {
  noteSendStarting(ticket, promptData, AGENT_API_ORIGIN);
}

/** A verdict over the agent's API names no pane (Issue #4304 F1-a). */
const AGENT_API_ORIGIN: HoldOrigin = Object.freeze({ kind: 'agent-api' as const });

function noteSendStarting(ticket: ManualAnswerTicket, promptData: PromptData | null | undefined, origin: HoldOrigin): void {
  if (ticket.attempt !== null) return;
  const screenKey = promptData ? partialAnswerScreenKey(promptData) : UNIDENTIFIED_SCREEN_KEY;
  ticket.attempt = beginManualSendAttempt(ticket.compositeKey, screenKey, origin);
}

/**
 * The person's KEYS are about to go out to the pane `context` names (Issue
 * #4304 F1-a, §3.3-2): {@link noteManualSendStarting} for a keystroke answer,
 * the send registered with that pane's generation, so the hold its end may
 * record is G's — never applied to another pane H, and never releasing H's.
 * `noteManualSendStarting` (no context) is the verdict over the agent's API.
 */
export function noteManualPaneSendStarting(
  ticket: ManualAnswerTicket,
  promptData: PromptData | null | undefined,
  context: PaneAnswerContext,
): void {
  noteSendStarting(ticket, promptData, { kind: 'pane', generation: context.generation });
}

/**
 * A person's keystroke answer ended (Issue #4304 F1-a): settled by what its
 * delivery says — `sent` and `not-sent` are `answered` / `not-sent`, a delivery
 * that may have left keys on the pane is `may-be-on-pane`, one that says
 * nothing of its keys is only abandoned. The hold it records or releases is
 * the pane the delivery's keys went to ({@link noteManualPaneSendStarting}).
 */
export function settleManualPaneAnswer(ticket: ManualAnswerTicket, delivery: AnswerDelivery, at: number = Date.now()): void {
  if (delivery.kind === 'sent') settleManualAnswer(ticket, 'answered', at);
  else if (delivery.kind === 'not-sent') settleManualAnswer(ticket, 'not-sent', at);
  else if (deliveryMayBeOnPane(delivery)) settleManualAnswer(ticket, 'may-be-on-pane', at);
  else abandonManualSend(ticket);
}

/**
 * A person's keystroke answer refused on the frame it was decided on, before
 * any send (Issue #4304 F1-a): `not-sent`, releasing only a hold about that
 * pane (or one over the agent's API).
 */
export function settleManualPaneRefusal(ticket: ManualAnswerTicket, context: PaneAnswerContext, at: number = Date.now()): void {
  if (ticket.attempt !== null) settleSendAttempt(ticket.attempt, false, at);
  releasePartialAnswerToHuman(ticket.compositeKey, ticket.order, { kind: 'pane', generation: context.generation });
}

/**
 * How a person's answer ended, for the answer Auto-Yes holds at the
 * confirmation (Issue #3880, see {@link settleManualAnswer}):
 *
 * - `answered`: every key of it reached tmux.
 * - `not-sent`: refused, or failed, before any key reached the pane.
 * - `may-be-on-pane`: some of its keys are on the pane, or a tmux call of it
 *   ended with its outcome unknown.
 */
export type ManualAnswerOutcome = 'answered' | 'not-sent' | 'may-be-on-pane';

/**
 * A person's answer ended (Issue #3880). Starting one does not touch what
 * Auto-Yes holds — the start only stops the tick under way and holds the
 * poller off for {@link MANUAL_ANSWER_HOLD_MS} — so a manual send that fails
 * cannot leave the confirmation free for Auto-Yes to type at again once that
 * hold passes. Everything is matched to THIS answer (`ticket`), not to the
 * instance's key alone:
 *
 * - `answered` / `not-sent`: the hold recorded before this answer began is
 *   released (the person answered, or saw the screen and nothing of theirs is
 *   on it). One recorded since — by another person's send that may be on the
 *   pane, or a tick's — stays.
 * - `may-be-on-pane`: the send records a hold at its screen (unidentified
 *   when none was read), as Auto-Yes's own does: only for the session epoch it
 *   went to, never over a hold of a send registered after it, and not at all when
 *   the screen it typed at was seen gone since. And every tick under way stops
 *   (the manual-answer sequence moves on): one that read no hold before its
 *   last wait does not type over this one.
 *
 * An end nobody reports (a send that threw saying nothing of its keys, a
 * verdict the agent's API gave no receipt for — both only abandoned; a
 * structured verdict `/prompt-response` refused) leaves the hold as it was. A verdict delivered over the
 * agent's API reports its receipt like a send (Issue #3925).
 */
export function settleManualAnswer(
  ticket: ManualAnswerTicket,
  outcome: ManualAnswerOutcome,
  at: number = Date.now(),
): void {
  const { compositeKey, attempt } = ticket;
  if (outcome !== 'may-be-on-pane') {
    if (attempt !== null) settleSendAttempt(attempt, false, at);
    // Issue #4304 F1-a (T4): only a hold this answer speaks for — its pane's,
    // or any for a verdict over the agent's API (or one with no send at all).
    releasePartialAnswerToHuman(compositeKey, ticket.order, attempt === null ? AGENT_API_ORIGIN : holdOriginOf(attempt));
    return;
  }
  if (attempt !== null) settleSendAttempt(attempt, true, at);
  const mark = marks.get(compositeKey);
  if (mark !== undefined) marks.set(compositeKey, { ...mark, seq: mark.seq + 1 });
}

/**
 * A person's send ended in a way that says nothing of its keys (Issue #3880):
 * it is no longer in flight, and the hold is left as it was.
 */
export function abandonManualSend(ticket: ManualAnswerTicket): void {
  if (ticket.attempt !== null) settleSendAttempt(ticket.attempt, false);
}

/** The instance's manual-answer sequence (0 until a person answers there). */
export function getManualAnswerSeq(compositeKey: string): number {
  return marks.get(compositeKey)?.seq ?? 0;
}

/** Whether a manual answer began on this instance less than {@link MANUAL_ANSWER_HOLD_MS} ago. */
export function isManualAnswerHolding(compositeKey: string, now: number = Date.now()): boolean {
  const mark = marks.get(compositeKey);
  return mark !== undefined && now - mark.at < MANUAL_ANSWER_HOLD_MS;
}

/** Drop every mark: a test seam. The sequences only ever move forward otherwise. */
export function clearManualAnswers(): void {
  marks.clear();
}
