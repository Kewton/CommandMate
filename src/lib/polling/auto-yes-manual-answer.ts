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
  holdPartialAnswerForManualSend,
  partialAnswerScreenKey,
  releasePartialAnswerToHuman,
} from './auto-yes-poller-state';
import type { PromptData } from '@/types/models';

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

/** A person began answering on this instance (called before the first key or API call). */
export function noteManualAnswerStarted(compositeKey: string, at: number = Date.now()): void {
  marks.set(compositeKey, { seq: (marks.get(compositeKey)?.seq ?? 0) + 1, at });
  forgetAutoYesDecision(compositeKey);
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
 * hold passes:
 *
 * - `answered` / `not-sent`: the held answer is released (the person answered,
 *   or saw the screen and nothing of theirs is on it).
 * - `may-be-on-pane`: the hold stays, or — when there was none — is recorded
 *   at `promptData`'s screen (nothing is recorded without it).
 *
 * An end nobody reports (the agent's API answered it, the route threw) leaves
 * the hold as it was.
 */
export function settleManualAnswer(
  compositeKey: string,
  outcome: ManualAnswerOutcome,
  promptData?: PromptData | null,
  at: number = Date.now(),
): void {
  if (outcome !== 'may-be-on-pane') {
    releasePartialAnswerToHuman(compositeKey);
    return;
  }
  if (promptData) holdPartialAnswerForManualSend(compositeKey, partialAnswerScreenKey(promptData), at);
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
