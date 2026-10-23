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
