/**
 * The one place a failure becomes a push notification (Issue #2000).
 *
 * Epic #2002 re-cut the notification axis from "what happened" to "do you have
 * to act". Three failure signals already existed and none of them reached a
 * phone; this module connects them, and it is the only module that decides
 * whether a failure is worth ringing for:
 *
 * | signal              | producer                                   | shape  |
 * |---------------------|--------------------------------------------|--------|
 * | verification failed | `lib/verification/gate-runner`              | event  |
 * | upstream API fault  | `lib/polling/response-checker` (#1839 match)| level  |
 * | session start failed| `lib/session/claude-session`                | event  |
 *
 * The shape column is the whole design. An **event** fires once by construction
 * — a run closes once, a start attempt throws once — so its only guard is the
 * existing 30 s content window in `push-sender`. A **level** is re-read on every
 * poll and needs an edge built for it before it can be notified at all; that is
 * `failure-episode-state`, and its docblock carries the reasoning and the
 * measurement.
 *
 * ## Every decision is logged with a reason code
 *
 * A notification that never arrived is indistinguishable from a broken notifier
 * from the outside (`docs/design/discoverability-principle.md`). So each call
 * ends in exactly one `failure-push-raised` or `failure-push-suppressed` line
 * carrying `reason`, the worktree and the instance. The single exception is
 * `no-fault` — a clean frame — which is the outcome of most polls of most
 * sessions and would drown the log it exists to make readable.
 *
 * ## Why none of this goes through `prompt-push-gate`
 *
 * #1999 mutes prompts that Auto-Yes is about to answer. No such claim can be
 * made about a failure: Auto-Yes answers dialogs, it does not fix a failing
 * gate, restore an upstream API or start a session that refused to start.
 * Muting failures during Auto-Yes would silence exactly the pipelines that got
 * stuck. The flood risk Auto-Yes creates is handled where it actually lives —
 * per-incident edges here, and the contract-task exclusion below.
 *
 * Everything here is advisory and must never throw into its caller: the
 * producers are a poller, a verification runner and a session starter, none of
 * which may fail because a phone could not be reached.
 *
 * @module lib/push/failure-push-notifier
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import type { VerificationRunTerminalStatus, VerificationTrigger } from '@/lib/db/verification-db';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { createLogger } from '@/lib/logger';
import { observeUpstreamFaultEdge } from './failure-episode-state';
import { notifyPushSubscribers, type FailurePushReason } from './push-sender';
import { isPushConfigured } from './vapid';

const logger = createLogger('push/failure-notifier');

/**
 * Why a failure notification was not raised.
 *
 * Kept as one union across all three signals so `grep failure-push-suppressed`
 * answers "why is my phone quiet?" without the reader having to know which
 * producer they are looking at.
 */
export type FailurePushSuppressionReason =
  /** No VAPID keys — this install cannot notify at all. */
  | 'push-unconfigured'
  /** The run judged an execution contract, so a human is not the audience. */
  | 'contract-task'
  /** The run did not fail. */
  | 'run-not-failed'
  /** The same upstream fault is still on the frame (not a new incident). */
  | 'upstream-same-episode'
  /** A new fault episode, but this instance rang inside the cooldown. */
  | 'upstream-cooldown';

/**
 * The worktree's display name, for the notification title.
 *
 * Falls back to the id rather than dropping the notification, exactly as
 * `waiting-push-notifier` does: a database that cannot answer is a reason to
 * send a less readable title, not a reason to leave a failure unreported.
 */
function resolveWorktreeName(worktreeId: string): string {
  try {
    return getWorktreeById(getDbInstance(), worktreeId)?.name ?? worktreeId;
  } catch {
    return worktreeId;
  }
}

interface RaiseFailurePushInput {
  reason: FailurePushReason;
  worktreeId: string;
  /** Instance the failure belongs to; also the title suffix. */
  instanceId?: string;
  /** Identity of this incident — the dedup key. Never rendered. */
  signature: string;
  /** Short human-readable detail for the body. */
  excerpt?: string;
  /** Extra fields for the log line only. Never sent to a device. */
  logContext?: Record<string, unknown>;
}

/**
 * Fan one failure notification out, logging the decision. Never throws.
 *
 * Callers reach this only after their own edge/scope decision has said yes, so
 * the only thing left to check here is whether push exists at all.
 */
async function raiseFailurePush(input: RaiseFailurePushInput): Promise<void> {
  const context = {
    worktreeId: input.worktreeId,
    instanceId: input.instanceId,
    failureReason: input.reason,
    signature: input.signature,
    ...input.logContext,
  };

  if (!isPushConfigured()) {
    logger.debug('failure-push-suppressed', {
      ...context,
      reason: 'push-unconfigured' satisfies FailurePushSuppressionReason,
    });
    return;
  }

  logger.info('failure-push-raised', context);

  try {
    await notifyPushSubscribers({
      worktreeId: input.worktreeId,
      worktreeName: resolveWorktreeName(input.worktreeId),
      kind: 'failure',
      agentName: input.instanceId,
      instanceId: input.instanceId,
      excerpt: input.excerpt,
      failure: { reason: input.reason, signature: input.signature },
    });
  } catch (error) {
    // `notifyPushSubscribers` already contains its own failures; this is the
    // belt for a producer bug (a malformed event) that would otherwise reach a
    // poller's catch and be reported as "no response found".
    logger.warn('failure-push-failed', {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ===========================================================================
// 1. Verification gate failure
// ===========================================================================

export interface VerificationFailurePushInput {
  worktreeId: string;
  runId: number;
  /** The task this run judged, after `startVerification` resolved it. */
  taskId: string | null;
  status: VerificationRunTerminalStatus;
  trigger: VerificationTrigger;
  instanceId?: string | null;
  /** Ids of the gates that did not pass, for the body. */
  failedGateIds?: string[];
}

/**
 * Statuses that mean "your work was not shown to pass, and you have to do
 * something about it".
 *
 * `not_started` is excluded because it is the work-evidence gate saying there
 * was nothing to judge, and `cancelled` because somebody already knows. `error`
 * IS included: an unusable `verify.yaml` or a runner that broke leaves the
 * verdict just as absent as a red gate does, and the operator's next move is
 * the same.
 */
const NOTIFIABLE_RUN_STATUSES: readonly VerificationRunTerminalStatus[] = ['failed', 'error'];

/**
 * Notify about a verification run that did not pass — unless it judged a
 * contract.
 *
 * ## The contract-task exclusion (adjudicated on Issue #2000)
 *
 * `/orchestrate` runs N workers in parallel and every one of them ends in a
 * verification run. Ringing for each red one is N notifications about work a
 * human deliberately delegated and is not watching gate-by-gate — the exact
 * collision with Epic #2002 that the adjudication names. So the audience test
 * is "was this run about an execution contract".
 *
 * ### The discriminator is the RESOLVED task, not `payload.taskId`
 *
 * The Issue's draft reading was that the API's `payload.taskId` separates them,
 * because `commandmate verify` does not send one. Measured, that is not
 * sufficient: `startVerification` calls `resolveTask`, which falls back to
 * `getVerifiableTask(worktreeId)` (#1545) whenever no `taskId` was named — so a
 * worker's `wait --verify` that happened not to bind a task id still attaches to
 * the worktree's own contract. Keying on `input.taskId` would have let exactly
 * the runs the adjudication excludes through. The resolved `taskId` written on
 * the run row is the fact that says whether a contract was judged, so that is
 * what is read here.
 */
export async function notifyVerificationFailurePush(
  input: VerificationFailurePushInput
): Promise<void> {
  const instanceId = input.instanceId ?? undefined;
  const context = {
    worktreeId: input.worktreeId,
    instanceId,
    runId: input.runId,
    status: input.status,
    trigger: input.trigger,
  };

  if (!NOTIFIABLE_RUN_STATUSES.includes(input.status)) {
    logger.debug('failure-push-suppressed', {
      ...context,
      reason: 'run-not-failed' satisfies FailurePushSuppressionReason,
    });
    return;
  }

  if (input.taskId !== null) {
    logger.info('failure-push-suppressed', {
      ...context,
      taskId: input.taskId,
      reason: 'contract-task' satisfies FailurePushSuppressionReason,
    });
    return;
  }

  const failed = input.failedGateIds ?? [];
  await raiseFailurePush({
    reason: 'verification-failed',
    worktreeId: input.worktreeId,
    instanceId,
    // The run id, so two runs of the same worktree are two incidents even when
    // the same gates fail with the same wording inside the 30 s window.
    signature: `verification:${input.runId}`,
    excerpt: failed.length > 0 ? failed.join(', ') : undefined,
    logContext: { runId: input.runId, status: input.status, trigger: input.trigger },
  });
}

// ===========================================================================
// 2. Upstream (model API) fault
// ===========================================================================

export interface UpstreamFaultPushInput {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Omitted for the primary instance, as `buildCompositeKey` expects. */
  instanceId?: string;
  /** {@link UpstreamFault.id} matched on this frame, or null when clean. */
  faultId: string | null;
  /** The matched line, already bounded by `upstream-faults`. */
  matchedText?: string;
  now?: number;
}

/**
 * Observe this frame's upstream-fault level and notify on a new incident.
 *
 * Safe to call on every poll — that is what it is for. The edge and the
 * cooldown live in `failure-episode-state`; this function is the logging and
 * fan-out half.
 */
export async function notifyUpstreamFaultPush(input: UpstreamFaultPushInput): Promise<void> {
  // Checked before the edge, not after, so an install without VAPID keys is
  // inert rather than merely quiet — no episode map, no cooldown state, nothing
  // to go stale. `waiting-push-notifier` takes the same position for the same
  // reason. The other two producers are event-shaped and check inside
  // `raiseFailurePush`, where the decision is worth a log line.
  if (!isPushConfigured()) return;

  const instanceId = input.instanceId ?? input.cliToolId;
  const edge = observeUpstreamFaultEdge({
    worktreeId: input.worktreeId,
    cliToolId: input.cliToolId,
    instanceId: input.instanceId,
    faultId: input.faultId,
    now: input.now,
  });

  if (edge.reason === 'no-fault') return;

  if (!edge.notify) {
    const reason: FailurePushSuppressionReason =
      edge.reason === 'cooldown' ? 'upstream-cooldown' : 'upstream-same-episode';
    // `same-episode` at debug, `cooldown` at info: the first is the ordinary
    // steady state of a fault that is still on screen (once per poll), the
    // second is the one an operator asks about — "it is broken again and my
    // phone said nothing".
    const line = {
      worktreeId: input.worktreeId,
      cliToolId: input.cliToolId,
      instanceId,
      faultId: input.faultId,
      since: edge.since,
      reason,
      ...(edge.cooldownRemainingMs !== undefined
        ? { cooldownRemainingMs: edge.cooldownRemainingMs }
        : {}),
    };
    if (edge.reason === 'cooldown') logger.info('failure-push-suppressed', line);
    else logger.debug('failure-push-suppressed', line);
    return;
  }

  await raiseFailurePush({
    reason: 'upstream-fault',
    worktreeId: input.worktreeId,
    instanceId,
    // The episode's own start, so a genuinely new incident past the cooldown is
    // a different signature even when the same banner text comes back.
    signature: `upstream:${input.faultId}:${edge.since}`,
    excerpt: input.matchedText,
    logContext: { cliToolId: input.cliToolId, faultId: input.faultId, since: edge.since },
  });
}

// ===========================================================================
// 3. Session start failure
// ===========================================================================

export interface SessionStartFailurePushInput {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  /** Display name of the CLI tool, e.g. `Claude Code`. */
  toolName: string;
  /**
   * The matched entry from `cli-patterns.ts` — a fixed string this repository
   * authored, never captured output (see `session-start-error`), so it is safe
   * to put in a notification body.
   */
  detectedPattern: string;
}

/**
 * Notify that a CLI session printed a terminal error while starting.
 *
 * No edge of its own, and deliberately: this is raised from a `throw`, so its
 * rate is bounded by how often something asks to start the session rather than
 * by a poll interval. The 30 s content window in `push-sender` collapses the
 * burst a retrying caller produces; a human who retries minutes later gets a
 * second notification, which is correct — that is a second failed attempt.
 *
 * Note that only `SessionStartFailedError` reaches here.
 * `SessionStartTimeoutError` is explicitly *not* a failure (#1637: the session
 * and its process are both alive and still initializing, and the documented
 * advice is to retry in a few seconds), so notifying for it would be the
 * "nothing needs repairing" case ringing a phone.
 */
export async function notifySessionStartFailurePush(
  input: SessionStartFailurePushInput
): Promise<void> {
  const instanceId = input.instanceId ?? input.cliToolId;
  await raiseFailurePush({
    reason: 'session-start-failed',
    worktreeId: input.worktreeId,
    instanceId,
    signature: `session-start:${instanceId}:${input.detectedPattern}`,
    excerpt: `${input.toolName}: ${input.detectedPattern}`,
    logContext: { cliToolId: input.cliToolId },
  });
}
