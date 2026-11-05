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

/** What one wait has declined so far. */
export interface LaunchAnswerSkips {
  /** The reason last recorded under each event. */
  readonly byEvent: Map<string, InstanceInputAnswerSkip>;
  /** The latest reason under any event; null while none was declined. */
  last: InstanceInputAnswerSkip | null;
}

export function newLaunchAnswerSkips(): LaunchAnswerSkips {
  return { byEvent: new Map(), last: null };
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
  fields: { reason: InstanceInputAnswerSkip } & Record<string, unknown>
): void {
  if (skips.byEvent.get(event) !== fields.reason) logger.warn(event, fields);
  skips.byEvent.set(event, fields.reason);
  skips.last = fields.reason;
}
