/**
 * Launch answers that did not go out (Issue #4161).
 *
 * The automatic answer to a launch screen goes through the instance input lock,
 * which can decline it, and the screen is due again on every poll. The record of
 * that is a warn, as the Claude trust dialog's is (#4149): at info a WARN- or
 * ERROR-only setting left no trace of a start that sent nothing. It is written
 * once while the same reason goes on, per event, per wait.
 *
 * @module lib/cli-tools/launch-answer-skips
 */

import type { Logger } from '@/lib/logger';
import type { InstanceInputAnswerSkip } from '@/lib/session/instance-input-lock';

/**
 * Why a launch answer did not go out: the lock's refusal, or (Issue #4189) a key
 * tmux refused after the lock let it through (`send-failed`, the auto-default nudge's).
 */
export type LaunchAnswerSkipReason = InstanceInputAnswerSkip | 'send-failed';

/**
 * What one wait has declined so far. Also the wait's `repeatScope` for
 * `answerUnderInstanceInputLock` (Issue #4189), so the lock's own warn of the
 * decline is once per streak as well.
 */
export interface LaunchAnswerSkips {
  /** The reason last recorded under each event. */
  readonly byEvent: Map<string, LaunchAnswerSkipReason>;
  /** The latest reason under any event; null while none is outstanding. */
  last: LaunchAnswerSkipReason | null;
  /** The event {@link LaunchAnswerSkips.last} was recorded under. */
  lastEvent: string | null;
}

export function newLaunchAnswerSkips(): LaunchAnswerSkips {
  return { byEvent: new Map(), last: null, lastEvent: null };
}

/**
 * Record a declined answer at warn, unless the same reason was the last under `event`.
 *
 * @param logger - The caller's logger, so the record keeps its module
 * @param skips - This wait's record
 * @param event - The log event, one per kind of answer
 * @param fields - The log fields; `reason` is an enum, nothing captured goes in
 */
export function noteLaunchAnswerSkipped(
  logger: Pick<Logger, 'warn'>,
  skips: LaunchAnswerSkips,
  event: string,
  fields: { reason: LaunchAnswerSkipReason } & Record<string, unknown>
): void {
  if (skips.byEvent.get(event) !== fields.reason) logger.warn(event, fields);
  skips.byEvent.set(event, fields.reason);
  skips.last = fields.reason;
  skips.lastEvent = event;
}

/**
 * Forget what was declined under `event`: the answer went through, or the screen it
 * was for has gone. The record describes a key that has not gone out, so a refusal
 * must not repeat it after that, and a later decline is a new one to report, even
 * for the same reason. Other events' records are theirs.
 *
 * @param skips - This wait's record
 * @param event - The log event the answer belongs to
 */
export function forgetLaunchAnswerSkip(skips: LaunchAnswerSkips, event: string): void {
  skips.byEvent.delete(event);
  if (skips.lastEvent === event) {
    skips.last = null;
    skips.lastEvent = null;
  }
}
