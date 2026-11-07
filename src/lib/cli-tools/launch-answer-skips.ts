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
import {
  instanceInputAnswerSkipLife,
  isInstanceInputAnswerSkipLife,
  type InstanceInputAnswerSkip,
  type InstanceInputAnswerSkipLife,
} from '@/lib/session/instance-input-lock';

/**
 * Why a launch answer did not go out: the lock's refusal, or (Issue #4189) a key
 * tmux refused after the lock let it through (`send-failed`, the auto-default nudge's),
 * or (Issue #4211) a Claude trust dialog whose cursor row could not be read, so no key
 * was decided (`cursor-unreadable`).
 */
export type LaunchAnswerSkipReason = InstanceInputAnswerSkip | 'send-failed' | 'cursor-unreadable';

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
  /**
   * The session's life each event's reason was recorded in (Issue #4189): a decline
   * after the session was made again (`invalidateInstanceInput`) is a new one.
   */
  readonly lifeByEvent: Map<string, { readonly sessionName: string; readonly life: InstanceInputAnswerSkipLife }>;
}

export function newLaunchAnswerSkips(): LaunchAnswerSkips {
  return { byEvent: new Map(), last: null, lastEvent: null, lifeByEvent: new Map() };
}

/**
 * Record a declined answer at warn, unless the same reason was the last under `event`
 * in the same life of the session (Issue #4189: `fields.sessionName`; without it
 * the life is not compared, as before).
 *
 * The life is the one the answer started in (`startedIn`, taken before its await),
 * as the input lock judges its own warn: a decline of an older life — the session
 * was made again while it waited or read the screen again — is written, but neither
 * reads nor writes the record of the new life. Without `startedIn` the life at this
 * call is used.
 *
 * @param logger - The caller's logger, so the record keeps its module
 * @param skips - This wait's record
 * @param event - The log event, one per kind of answer
 * @param fields - The log fields; `reason` is an enum, nothing captured goes in
 * @param startedIn - {@link instanceInputAnswerSkipLife} of `fields.sessionName`, taken before the answer
 */
export function noteLaunchAnswerSkipped(
  logger: Pick<Logger, 'warn'>,
  skips: LaunchAnswerSkips,
  event: string,
  fields: { reason: LaunchAnswerSkipReason } & Record<string, unknown>,
  startedIn?: InstanceInputAnswerSkipLife
): void {
  const sessionName = typeof fields.sessionName === 'string' ? fields.sessionName : null;
  if (sessionName !== null && startedIn !== undefined && !isInstanceInputAnswerSkipLife(sessionName, startedIn)) {
    // An answer of an older life: its warn, and no record for the new one.
    logger.warn(event, fields);
    skips.last = fields.reason;
    skips.lastEvent = event;
    return;
  }
  const recorded = skips.lifeByEvent.get(event);
  const sameLife =
    recorded === undefined ||
    (recorded.sessionName === sessionName && isInstanceInputAnswerSkipLife(recorded.sessionName, recorded.life));
  if (skips.byEvent.get(event) !== fields.reason || !sameLife) logger.warn(event, fields);
  skips.byEvent.set(event, fields.reason);
  if (sessionName === null) skips.lifeByEvent.delete(event);
  else skips.lifeByEvent.set(event, { sessionName, life: startedIn ?? instanceInputAnswerSkipLife(sessionName) });
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
  skips.lifeByEvent.delete(event);
  if (skips.lastEvent === event) {
    skips.last = null;
    skips.lastEvent = null;
  }
}
