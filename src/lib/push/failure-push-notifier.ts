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
 * | session start failed| `lib/cli-tools/start-availability` (#2009/#2022)| event |
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
import {
  SESSION_START_FAILED_CODE,
  isSessionStartTimeoutError,
  isSessionStartUnavailableError,
  type SessionStartSubject,
} from '@/lib/session/session-start-error';
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
  | 'upstream-cooldown'
  /**
   * The start is merely slow (Issue #1637 / #2009). The tmux session and the CLI
   * process are both alive and deliberately left running, so there is nothing to
   * repair and the documented advice is to retry in a few seconds.
   */
  | 'session-still-starting';

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
  /**
   * Title and tap target for a subject that is not a worktree row (#2022).
   * Omitted, both are resolved from {@link worktreeId} exactly as before.
   */
  subject?: SessionStartSubject;
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
      // Issue #2022: a subject that is not a worktree row names itself. The
      // worktree lookup is not merely redundant for one — it would answer with
      // the raw id, which for Assistant Chat is a uuid nobody recognises.
      worktreeName: input.subject?.name ?? resolveWorktreeName(input.worktreeId),
      kind: 'failure',
      agentName: input.instanceId,
      instanceId: input.instanceId,
      excerpt: input.excerpt,
      failure: { reason: input.reason, signature: input.signature },
      ...(input.subject ? { url: input.subject.url } : {}),
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
   * Exactly what `startSession()` threw (Issue #2009).
   *
   * The caller hands the error over rather than a pre-digested reason: this
   * module is "the only module that decides whether a failure is worth ringing
   * for" (see the file docblock), and that decision is not one a seam sitting
   * above seven CLI tools can make. It is made once, here, in
   * {@link classifySessionStartFailure}.
   */
  error: unknown;
  /**
   * Title and tap target, for a start that does not belong to a worktree
   * (Issue #2022) — Assistant Chat, which is repository-scoped and lives at
   * `/chat`. Omitted by every tmux-session caller, which keeps the worktree
   * title and the `/worktrees/<id>` link #2000 shipped.
   */
  subject?: SessionStartSubject;
}

/**
 * What a caught session-start error means for the phone.
 *
 * `null` is the deliberate silence: it carries the suppression reason so the
 * caller's log line answers "why did my phone stay quiet?" without the reader
 * having to know which of the three shapes came back.
 */
type SessionStartVerdict =
  | { notify: false; reason: FailurePushSuppressionReason }
  | { notify: true; reason: FailurePushReason; excerpt: string; signature: string };

/**
 * Decide what a session-start failure is, from the error alone.
 *
 * ## The excerpt never carries captured output
 *
 * A notification body leaves this machine. `SessionStartFailedError` is the one
 * shape whose detail may be quoted, and it earns that by construction: its
 * `detectedPattern` is a fixed string from `cli-patterns.ts` that this
 * repository authored, never anything the CLI printed (`session-start-error`
 * spells the argument out). Every other shape — a bare `Error` from a tool's own
 * launch path, whose message interpolates raw tmux/CLI text — contributes only
 * the tool NAME, which is the fact the Issue's acceptance asks the body to
 * carry.
 *
 * @param input - The failure, as reported by the seam
 * @param instanceId - Resolved instance id; part of every signature
 */
function classifySessionStartFailure(
  input: SessionStartFailurePushInput,
  instanceId: string
): SessionStartVerdict {
  // #1637: the session and its process are both alive and still initializing.
  // Notifying here would be the "nothing needs repairing" case ringing a phone.
  if (isSessionStartTimeoutError(input.error)) {
    return { notify: false, reason: 'session-still-starting' };
  }

  if (isSessionStartUnavailableError(input.error)) {
    return {
      notify: true,
      reason: 'session-start-unavailable',
      // Just the name: the dictionary supplies "is not installed" in the
      // reader's language, which an English error message could not.
      excerpt: input.toolName,
      // Not the message — copilot's carries an install hint that would make two
      // attempts at the same missing binary look like two incidents.
      signature: `session-start:${instanceId}:not-installed`,
    };
  }

  if (readErrorCode(input.error) === SESSION_START_FAILED_CODE) {
    const detectedPattern = (input.error as { detectedPattern?: unknown }).detectedPattern;
    const pattern = typeof detectedPattern === 'string' ? detectedPattern : '';
    return {
      notify: true,
      reason: 'session-start-failed',
      excerpt: pattern ? `${input.toolName}: ${pattern}` : input.toolName,
      // Unchanged from #2000, so a claude start that keeps hitting the same
      // pattern still collapses to one notification exactly as it did.
      signature: `session-start:${instanceId}:${pattern}`,
    };
  }

  return {
    notify: true,
    reason: 'session-start-failed',
    excerpt: input.toolName,
    signature: `session-start:${instanceId}:start-error`,
  };
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Notify that a CLI session could not be started. Never throws.
 *
 * Called from exactly one place — `reportSessionStartFailure` in
 * `lib/cli-tools/start-availability` (Issue #2009 / #2022). Before #2009 it was
 * called from `claude-session`'s throw site, which is why six of the seven
 * agents failed silently: the other six never had a line to call it from. #2009
 * moved it to `BaseCLITool.startSession`, the method all seven tools inherit;
 * #2022 moved the line itself one step further out, because Assistant Chat
 * never reaches that method — it spawns `claude -p` rather than a tmux session —
 * and the alternative was a second, private call site.
 *
 * No edge of its own, and deliberately: this is raised from a `throw`, so its
 * rate is bounded by how often something asks to start the session rather than
 * by a poll interval. The 30 s content window in `push-sender` collapses the
 * burst a retrying caller produces; a human who retries minutes later gets a
 * second notification, which is correct — that is a second failed attempt.
 */
export async function notifySessionStartFailurePush(
  input: SessionStartFailurePushInput
): Promise<void> {
  const instanceId = input.instanceId ?? input.cliToolId;
  const verdict = classifySessionStartFailure(input, instanceId);

  if (!verdict.notify) {
    // At info, not debug: "the agent did not come up and my phone said nothing"
    // is a question an operator actually asks, and this is the line that answers
    // it. It is once per start attempt, not once per poll, so it cannot flood.
    logger.info('failure-push-suppressed', {
      worktreeId: input.worktreeId,
      instanceId,
      cliToolId: input.cliToolId,
      reason: verdict.reason,
    });
    return;
  }

  await raiseFailurePush({
    reason: verdict.reason,
    worktreeId: input.worktreeId,
    instanceId,
    signature: verdict.signature,
    excerpt: verdict.excerpt,
    logContext: { cliToolId: input.cliToolId },
    subject: input.subject,
  });
}
