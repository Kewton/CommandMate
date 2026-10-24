/**
 * In-memory record of the last Auto-Yes answer withheld by a contract policy
 * (Issue #1684).
 *
 * Until now a policy suppression (Issue #1547) was visible only in the server
 * log (`poller:auto-yes-suppressed-by-policy`), so an unattended pipeline that
 * stalled on a suppressed prompt looked identical to one that simply had no
 * answer. This module keeps the last suppression per session so
 * `buildCurrentOutput` can publish it and `commandmate capture --json` can show
 * *why* the worker is waiting.
 *
 * Exposure only: nothing reads this to make a decision. The poller keeps
 * re-evaluating a suppressed prompt every poll (the duplicate guard only
 * remembers *answered* prompts), so while the prompt stays on screen the record
 * is refreshed and `at` stays current; consumers combine it with
 * `isPromptWaiting` to tell an active suppression from a historical one.
 *
 * In-memory and not in SQLite for the same reason `agent-event-state` is: the
 * record describes a prompt on a live tmux session, and a session does not
 * survive a server restart for the record to still be about.
 *
 * @module lib/polling/auto-yes-suppression-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { PromptType } from '@/types/models';
import type { AutoYesMode, AutoYesSuppressionReason } from './auto-yes-resolver';
import { getOrInitGlobal } from '../global-state';
import { getWaitingEpisodeRecord } from '../session/waiting-episode-state';

/** What the policy withheld, and why — the log line's payload, made queryable. */
export interface AutoYesPolicySuppression {
  /** Why the answer was withheld (mirrors AutoYesResolution.suppressedBy). */
  reason: AutoYesSuppressionReason;
  /** Policy mode in force at the time (null = contract stated no mode). */
  mode: AutoYesMode | null;
  /** Type of the prompt that was left unanswered. */
  promptType: PromptType;
  /** The deny pattern responsible, when `reason` is a deny-pattern case. */
  pattern?: string;
  /** Epoch ms of the suppression; refreshed on every poll that re-suppresses. */
  at: number;
  /**
   * The waiting episode open for this instance when the record was written
   * (Issue #3798), or the one a caller carried over from an earlier record of
   * the same dialog (`auto-yes-poller-receipt-log`). Present, the push gate and
   * `cmate wait` match the record to a wait by this id rather than by time;
   * absent — no wait was open yet — the time comparison applies.
   */
  episodeId?: string;
}

/**
 * The name the push gate reads the record under (Issue #3798). The id now
 * belongs to the published record itself ({@link AutoYesPolicySuppression}).
 */
export type EpisodeScopedPolicySuppression = AutoYesPolicySuppression;

/**
 * Reached through `globalThis` for the same reason `agent-event-state` is
 * (Issue #1736): the writer and the reader are different route handlers, and
 * under `next dev` each one is bundled separately and would hold its own copy
 * of this map.
 *
 * That split is not hypothetical here. `recordPolicySuppression` is called
 * from `/api/hooks/permission-request` (via `permission-decision-service`) and
 * from the Auto-Yes poller, while `getLastPolicySuppression` is only ever read
 * by `buildCurrentOutput` — i.e. `/api/worktrees/:id/current-output` and the WS
 * streamer. This record exists precisely so an unattended pipeline that stalled
 * on a suppressed prompt can say *why*, so losing it in dev restores the
 * unexplained stall the Issue set out to remove.
 *
 * `docs/module-reference.md` states the rule: "プロセス全体で共有する in-memory
 * 状態は globalThis 経由で持つ".
 */
declare global {
  // eslint-disable-next-line no-var
  var __autoYesPolicySuppressions: Map<string, AutoYesPolicySuppression> | undefined;
}

/** compositeKey -> the most recent policy suppression for that session. */
const lastPolicySuppressions = getOrInitGlobal('__autoYesPolicySuppressions', () => new Map<string, AutoYesPolicySuppression>());

/**
 * Record that the policy withheld an answer for `instanceId`'s current prompt.
 *
 * Issue #3798: the record names the waiting episode open for the instance at
 * this moment — unless the caller names one (a record carried over for the
 * same dialog) — so it is never taken for the reason of a later wait.
 *
 * @param at - Epoch ms; defaults to now. Overridable so tests are deterministic.
 */
export function recordPolicySuppression(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  suppression: Omit<AutoYesPolicySuppression, 'at'>,
  at: number = Date.now()
): void {
  const { episodeId: carried, ...rest } = suppression;
  const episodeId = carried ?? getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId)?.episodeId;
  lastPolicySuppressions.set(buildCompositeKey(worktreeId, cliToolId, instanceId), {
    ...rest,
    at,
    ...(episodeId !== undefined ? { episodeId } : {}),
  });
}

/**
 * @returns The last policy suppression for this session, or null when the
 *   policy has never withheld an answer — the ordinary case for a session
 *   running without a contract.
 */
export function getLastPolicySuppression(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AutoYesPolicySuppression | null {
  return lastPolicySuppressions.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Whether the record is older than the Auto-Yes answer to the wait it would
 * explain (Issue #3798): the poller's last answer (`lastAnswer`) went to
 * `waitingEpisodeId`, the wait open now, after the record was written. The
 * success path of a send does not clear the record — it stays as history —
 * but the answer is the newer fact, so the record is not that wait's reason
 * any more. The push gate and `current-output` (`lastSuppressionAnswered`,
 * which `cmate wait` reads) both decide it here. A record written at or after
 * the answer, an answer to another episode, no answer and no wait id are not.
 */
export function suppressionPredatesAnswer(
  suppression: Pick<AutoYesPolicySuppression, 'at'>,
  waitingEpisodeId: string | null | undefined,
  answer: { episodeId: string; at: number } | null
): boolean {
  if (waitingEpisodeId === null || waitingEpisodeId === undefined || answer === null) return false;
  return answer.episodeId === waitingEpisodeId && suppression.at < answer.at;
}

/**
 * Drop the record of one session (Issue #3796): the reason it gives no longer
 * holds for the prompt still on screen (the contract that withheld it changed),
 * so leaving it to age out would have `cmate wait` report a stale reason for up
 * to a minute.
 */
export function forgetPolicySuppression(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): void {
  lastPolicySuppressions.delete(buildCompositeKey(worktreeId, cliToolId, instanceId));
}

/** Drop every recorded suppression. Test seam. */
export function clearPolicySuppressions(): void {
  lastPolicySuppressions.clear();
}
