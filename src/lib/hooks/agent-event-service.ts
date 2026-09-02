/**
 * Effects of a structured agent event (Issue #1549, Phase 3-2).
 *
 * The agent CLI is the only party that knows for certain that it finished a
 * turn. Everything else in this codebase infers it by reading the terminal
 * frame. This module is the first-class path: an event the agent itself sent,
 * turned into a `task_events` row and — when the contract asks for it — a
 * verification run.
 *
 * It does not replace the string analysis. `detectSessionStatus` keeps running
 * and keeps deciding, because a hook only exists when a human wired one up and
 * a completion mechanism that silently does nothing on an unconfigured machine
 * is worse than one that is merely imprecise everywhere.
 *
 * Server-only: touches the filesystem (realpath) and the database.
 *
 * @module lib/hooks/agent-event-service
 */

import { realpathSync } from 'fs';
import { isAbsolute, sep } from 'path';
import type Database from 'better-sqlite3';
import { getWorktrees } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { getActiveTaskForInstance } from '@/lib/db/tasks-db';
import { isWithinRoot } from '@/lib/security/path-validator';
import { applyTaskEvent } from '@/lib/tasks/task-transition-service';
import { startVerification, VerificationConflictError } from '@/lib/verification/gate-runner';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { recordAgentStopEvent } from '@/lib/session/agent-event-state';
import { captureTranscriptTurnOnStop } from '@/lib/hooks/stop-history-capture';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/hooks/agent-event-service');

/**
 * The event vocabulary lives in `agent-event-types` (Issue #1722) so the
 * settings generator and the in-memory state can use it without importing this
 * module's database and verification dependencies. Re-exported here because
 * this is where callers have always found it.
 *
 * The Claude-specific mapping helpers that used to be re-exported alongside
 * them are gone (Issue #1759): a tool's spellings now belong to that tool's
 * `AgentEventSource`, and re-exporting one tool's from the generic service
 * would have made this module the next place a Phase 4-x implementer reached
 * for. Ask `getAgentEventSource(cliToolId).normalizeEvent()` instead.
 *
 * Every kind but `stop` is accepted, recorded and exposed without changing any
 * state: the receiver has to exist before agents can be told to send them, and
 * rejecting them would make every hook config a two-step rollout.
 */
export {
  AGENT_EVENT_TYPES,
  isAgentEventType,
  type AgentEventType,
} from '@/lib/hooks/agent-event-types';

/** Bound on the accepted `cwd`, comfortably above PATH_MAX on every supported platform. */
export const MAX_CWD_LENGTH = 4096;

/**
 * Why a `cwd` was refused outright, as opposed to merely not matching a worktree.
 *
 * The distinction matters at the route: a malformed path is a client bug worth a
 * 400, while an unknown-but-well-formed path is an ordinary miss that must not
 * tell the caller anything about which directories the server knows.
 */
export type CwdRejection = 'empty' | 'too_long' | 'nul_byte' | 'not_absolute' | 'traversal';

export type CwdValidation = { ok: true; cwd: string } | { ok: false; reason: CwdRejection };

/**
 * Reject a `cwd` that cannot be a legitimate agent working directory.
 *
 * A hook posts the directory the agent is running in, so the only shapes worth
 * accepting are absolute, traversal-free paths. `..` is refused rather than
 * normalised away: `resolve()` would happily turn `/repos/a/../../etc` into a
 * path that looks nothing like what the caller sent, and a value that changes
 * meaning between validation and use is exactly how traversal checks get
 * defeated. Percent-encoding is decoded first, so `%2e%2e%2f` cannot smuggle a
 * `..` past a raw string scan.
 */
export function validateHookCwd(raw: unknown): CwdValidation {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'empty' };
  }
  if (raw.length > MAX_CWD_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not valid percent-encoding; the raw string is the only interpretation.
    decoded = raw;
  }

  if (raw.includes('\0') || decoded.includes('\0')) {
    return { ok: false, reason: 'nul_byte' };
  }
  if (!isAbsolute(raw)) {
    return { ok: false, reason: 'not_absolute' };
  }
  if (hasTraversalSegment(raw) || hasTraversalSegment(decoded)) {
    return { ok: false, reason: 'traversal' };
  }

  return { ok: true, cwd: raw };
}

/** True when any path segment is `..`, under either separator convention. */
function hasTraversalSegment(value: string): boolean {
  return value
    .split(sep === '\\' ? /[\\/]/ : '/')
    .some((segment) => segment === '..');
}

/**
 * The registered worktree an agent's `cwd` belongs to, or null.
 *
 * Both sides are resolved through `realpath` before comparison because the two
 * ends disagree routinely and harmlessly: macOS hands agents `/var/...` for a
 * worktree stored as `/private/var/...`, and worktree roots are often symlinked.
 *
 * A descendant matches its worktree — agents commonly run from a subdirectory —
 * and the longest match wins, so a worktree nested inside another resolves to
 * the inner one rather than to whichever row the database returned first.
 *
 * @param cwd - Already through {@link validateHookCwd}
 * @returns null when the path does not exist or belongs to no worktree; the
 *   caller must not distinguish those two cases to the client
 */
export function resolveWorktreeByCwd(db: Database.Database, cwd: string): Worktree | null {
  const resolvedCwd = safeRealpath(cwd);
  if (resolvedCwd === null) {
    return null;
  }

  let best: Worktree | null = null;
  let bestLength = -1;

  for (const worktree of getWorktrees(db)) {
    const resolvedWorktree = safeRealpath(worktree.path);
    if (resolvedWorktree === null) continue;
    if (!isWithinRoot(resolvedCwd, resolvedWorktree)) continue;
    if (resolvedWorktree.length > bestLength) {
      best = worktree;
      bestLength = resolvedWorktree.length;
    }
  }

  return best;
}

/** realpath, or null when the path does not exist / is unreadable. */
function safeRealpath(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

export interface AgentStopOutcome {
  /** Active task the event was applied to, or null when none governs the instance. */
  taskId: string | null;
  /** False when there was no task, or the state machine rejected `agent_idle`. */
  taskEventApplied: boolean;
  /** Verification run started by `success.autoVerifyOnStop`, or null. */
  verificationRunId: number | null;
  /**
   * Whether the transcript reader recorded this instance's newest turn (#2246).
   *
   * False for every tool without a transcript to pull from, and for one that has
   * it whenever the reader could not write — no session pointer, no file, a turn
   * whose body has not been flushed even after the retry. Never a failure on its
   * own: the poller's own trigger is still behind it.
   */
  structuredHistoryCaptured: boolean;
}

/**
 * Apply a `stop` event to whatever the worktree is currently doing.
 *
 * The no-op is the load-bearing case. Sessions with no contract, and therefore
 * no task, are the overwhelming majority; for them this records the timestamp,
 * asks the transcript reader for the turn, and returns.
 *
 * ## Why the history read is here (Issue #2246)
 *
 * Because it must happen for *every* stop event and not only for the ones that
 * govern a task — the majority case above is exactly the session whose replies
 * this is trying not to lose — and because both callers of this function are
 * stop receivers (`/api/hooks/agent-event` and the compatibility
 * `/api/hooks/claude-done`). Putting it in one of the routes would have left the
 * other one on the old behaviour.
 *
 * It runs **before** the task lookup so that the two early returns below cannot
 * skip it, and after `recordAgentStopEvent` because the reader resolves its
 * transcript through the session pointer that call refreshes.
 *
 * It is awaited rather than detached. The turn has already ended, so the cost is
 * paid by nobody who is waiting for an answer, and a detached promise here would
 * be one whose failures nothing observes.
 *
 * Never throws. A hook is fire-and-forget from a CLI's stop handler, and a
 * failure here must not become the agent's problem.
 */
export async function applyAgentStopEvent(
  db: Database.Database,
  worktree: Worktree,
  cliToolId: CLIToolType,
  instanceId: string
): Promise<AgentStopOutcome> {
  recordAgentStopEvent(worktree.id, cliToolId, instanceId);

  const structuredHistoryCaptured = await captureTranscriptTurnOnStop(
    worktree,
    cliToolId,
    instanceId
  );

  let task;
  try {
    task = getActiveTaskForInstance(db, worktree.id, cliToolId, instanceId);
  } catch (error) {
    logger.warn('agent-stop-task-lookup-failed', {
      worktreeId: worktree.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      taskId: null,
      taskEventApplied: false,
      verificationRunId: null,
      structuredHistoryCaptured,
    };
  }

  if (!task) {
    return {
      taskId: null,
      taskEventApplied: false,
      verificationRunId: null,
      structuredHistoryCaptured,
    };
  }

  let taskEventApplied = false;
  try {
    const result = applyTaskEvent(db, task.id, 'agent_idle', { source: 'hook' });
    taskEventApplied = result !== null && result.toStatus !== null;
  } catch (error) {
    logger.warn('agent-stop-event-failed', {
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!task.contract.success.autoVerifyOnStop) {
    return {
      taskId: task.id,
      taskEventApplied,
      verificationRunId: null,
      structuredHistoryCaptured,
    };
  }

  let verificationRunId: number | null = null;
  try {
    const { runId } = await startVerification({
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      instanceId,
      taskId: task.id,
      trigger: 'task',
    });
    verificationRunId = runId;
  } catch (error) {
    // A run already in flight is the expected collision, not a fault: the agent
    // stopping twice while gates execute is ordinary.
    if (!(error instanceof VerificationConflictError)) {
      logger.error('agent-stop-auto-verify-failed', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { taskId: task.id, taskEventApplied, verificationRunId, structuredHistoryCaptured };
}
