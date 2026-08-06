/**
 * In-memory record of the structured lifecycle events an agent has reported,
 * and the session status they imply (#1549, #1722, promoted in #1723).
 *
 * The agent CLI telling us what it did is a different kind of fact from the
 * screen-scraped status: it is exact, but it only exists where hooks actually
 * fire. #1549 and #1722 therefore kept it strictly beside the detector's
 * output. #1723 promotes it to a first-class source — {@link
 * getStructuredSessionState} answers with a `SessionStatus`, and
 * `current-output-builder` prefers that answer to the scraper's — while
 * `detectSessionStatus()` stays a pure function of the terminal frame and stays
 * in charge wherever no event has arrived.
 *
 * Three things bound how far that trust extends, because a hook is an
 * unreliable channel by design (every failure is fail-open):
 *
 *  - **generation** — events are keyed by (worktree, tool, instance), a key a
 *    recreated session reuses, so a generation marker fences off the previous
 *    process's events. See {@link beginAgentEventGeneration}.
 *  - **age** — see {@link STRUCTURED_STATE_MAX_AGE_MS}, which bounds the damage
 *    of a `Stop` that never arrived.
 *  - **liveness** — a dead tmux session has no structured state; the caller
 *    establishes that before asking.
 *
 * In-memory and not in SQLite for the same reason `auto-yes-state` is: the value
 * describes a live tmux session, and a session does not survive a server restart
 * for the timestamp to still be about. Losing it on restart is safe precisely
 * because the scraper is still there to answer.
 *
 * @module lib/session/agent-event-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { agentEventToSessionStatus, type StructuredStatusVerdict } from '@/lib/session/status-mapping';

/** compositeKey -> epoch ms of the most recent stop event. */
const lastStopEventAt = new Map<string, number>();

/** compositeKey -> the most recent event of any kind. */
const lastAgentEvent = new Map<string, AgentEventRecord>();

/** compositeKey -> epoch ms the current generation began. See {@link beginAgentEventGeneration}. */
const generationStartedAt = new Map<string, number>();

/** dedup key -> epoch ms it was first seen. See {@link isDuplicateAgentEvent}. */
const recentEventKeys = new Map<string, number>();

/**
 * How long two identical events count as one delivery.
 *
 * Issue #1722 injects hooks at session start, and `--settings` hooks are
 * *concatenated* with the user's own rather than replacing them, so anyone who
 * followed the #1549 manual setup now has two `Stop` hooks posting the same
 * turn. `applyAgentStopEvent` is idempotent for the timestamp, but
 * `applyTaskEvent` is not: each delivery writes its own `agent_idle` row, and a
 * reader counting rows would see one turn as two.
 *
 * A turn cannot end twice in three seconds, and both deliveries carry the same
 * `session_id`, so the window is generous relative to the real signal and tight
 * relative to anything it could wrongly swallow.
 */
export const AGENT_EVENT_DEDUP_WINDOW_MS = 3000;

/** Cap on retained dedup keys, so a long-lived server cannot grow one per turn. */
const MAX_RECENT_EVENT_KEYS = 512;

/** The most recent structured event reported for one agent instance. */
export interface AgentEventRecord {
  /** Event kind, in this codebase's vocabulary rather than the CLI's spelling. */
  event: AgentEventType;
  /** Epoch ms the server received it. */
  at: number;
  /**
   * The event's subtype where it has one — `permission_prompt` / `idle_prompt`
   * for `notification`, `clear` for a `/clear`-driven `session_end` — else null.
   */
  detail: string | null;
  /**
   * The agent's own session id, or null.
   *
   * Recorded for correlation with the agent's transcript, never used as an
   * identity: `/clear` ends the session and starts a new one with a *different*
   * `session_id` while the instance, the worktree and the tmux pane all stay put
   * (Issue #1721, §1.1). Instance identity comes from the injected URL.
   */
  sessionId: string | null;
}

/**
 * Record that `instanceId` reported it stopped.
 *
 * @param at - Epoch ms; defaults to now. Passed explicitly by callers that need
 *   the stored value and their own record of the event to agree exactly.
 */
export function recordAgentStopEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  at: number = Date.now()
): void {
  lastStopEventAt.set(buildCompositeKey(worktreeId, cliToolId, instanceId), at);
}

/**
 * @returns Epoch ms of the last stop event, or null when none has been received
 *   — which is the ordinary case for a session whose agent has no hook set up.
 */
export function getLastStopEventAt(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): number | null {
  return lastStopEventAt.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Record any structured event against an instance (Issue #1722).
 *
 * Deliberately does not touch `lastStopEventAt`: that timestamp belongs to
 * `applyAgentStopEvent`, which writes it alongside the task transition it drives
 * so the two cannot disagree.
 */
export function recordAgentEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  record: AgentEventRecord
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  lastAgentEvent.set(key, record);
  if (record.event === 'session_start') {
    // The agent restarting inside a pane CommandMate never touched — `claude`
    // relaunched by hand, or a `/clear` (which emits SessionEnd then
    // SessionStart on a live session) — is a new generation just as much as a
    // new tmux session is. Recorded from the event's own timestamp, so the
    // event that opens a generation is never stale against it.
    generationStartedAt.set(key, record.at);
  }
}

/**
 * @returns The last structured event reported by this instance, or null when it
 *   has reported none.
 */
export function getLastAgentEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AgentEventRecord | null {
  return lastAgentEvent.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * How long a structured verdict is trusted after the event that produced it
 * (Issue #1723).
 *
 * Hooks are fail-open by design: a timeout or a refused connection costs the
 * event and never the agent's turn (`agent-hooks-live-verification.md` §1.1).
 * A *lost* `Stop` is therefore possible, and without a bound it would leave
 * this layer asserting `running` for a session that finished — `commandmate
 * wait` would then poll until `--timeout` on a session the scraper could have
 * called done. The bound converts "forever" into "at most this long", after
 * which the scraper takes the session back.
 *
 * Deliberately generous. A single agent turn running past 30 minutes is
 * ordinary for the workloads this tool exists to babysit, and expiring a live
 * verdict mid-turn costs the whole benefit of the two-layer split. Expiry is
 * not a failure mode: it is exactly the pre-#1723 behaviour.
 */
export const STRUCTURED_STATE_MAX_AGE_MS = 30 * 60 * 1000;

/** A structured verdict about one instance, with the event that produced it. */
export interface StructuredSessionState extends StructuredStatusVerdict {
  /** The event this verdict was derived from. */
  event: AgentEventType;
  /** Epoch ms the event was received. */
  at: number;
  /** The event's subtype, or null. */
  detail: string | null;
}

/**
 * Open a new generation for this instance, invalidating everything reported
 * before now (Issue #1723).
 *
 * Called from the session *creation* path, not from every start: a
 * `startClaudeSession()` that finds a healthy session and returns is the same
 * generation, and bumping there would throw away a still-valid verdict on
 * every reconnect.
 *
 * The failure this prevents is specific. Events live in a Map keyed by
 * (worktree, tool, instance) — a key a recreated session reuses exactly — so
 * without a generation the last `user_prompt_submit` of the *previous* Claude
 * process would be read as the current one's, and a freshly started session
 * would report `running` before anybody had typed anything into it.
 *
 * @param at - Epoch ms; defaults to now
 */
export function beginAgentEventGeneration(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  at: number = Date.now()
): void {
  generationStartedAt.set(buildCompositeKey(worktreeId, cliToolId, instanceId), at);
}

/**
 * @returns Epoch ms the current generation began, or null when no generation
 *   has been opened — the ordinary case for a session that predates this
 *   server process, whose events are then judged on age alone.
 */
export function getAgentEventGenerationStartedAt(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): number | null {
  return generationStartedAt.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Discard the structured state for one instance — the session it described is
 * gone (Issue #1723).
 *
 * `lastStopEventAt` is deliberately left alone. It is #1549's observational
 * timestamp with its own published meaning ("when did this agent last say it
 * stopped"), it decides nothing, and clearing it here would silently change
 * what the field has always reported.
 */
export function discardAgentEventState(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  lastAgentEvent.delete(key);
  generationStartedAt.delete(key);
}

/**
 * The status this instance's structured events imply, or null when they imply
 * nothing (Issue #1723).
 *
 * Null is the answer for every session on a machine where hooks never fire,
 * which is what keeps the unconfigured environment on exactly the behaviour it
 * had before this Issue. It is also the answer when:
 *
 *  - the last event carries no verdict (`session_start`, `session_end`, a
 *    `Notification` of an unrecognised type) — see `agentEventToSessionStatus`;
 *  - the event predates the current generation, i.e. it belongs to a previous
 *    Claude process in a reused pane;
 *  - the event is older than {@link STRUCTURED_STATE_MAX_AGE_MS}.
 *
 * Whether the tmux session is alive is NOT checked here — the caller
 * (`buildCurrentOutput`) has already answered that question with the CLI tool's
 * own `isRunning()` and returned early, and asking twice would mean a second
 * tmux round-trip on the hot path for an answer it is holding.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getStructuredSessionState(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now()
): StructuredSessionState | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const record = lastAgentEvent.get(key);
  if (!record) return null;

  const generation = generationStartedAt.get(key);
  if (generation !== undefined && record.at < generation) return null;

  if (now - record.at >= STRUCTURED_STATE_MAX_AGE_MS) return null;

  const verdict = agentEventToSessionStatus(record.event, record.detail);
  if (verdict === null) return null;

  return { ...verdict, event: record.event, at: record.at, detail: record.detail };
}

/**
 * Whether this event is a second copy of one already handled, and should be
 * dropped.
 *
 * Only events that name a `sessionId` can be deduplicated, and calling this
 * *claims* the key: a first call answers false and marks it, so the caller must
 * ask once per request and act on the answer. Events with no session id are
 * never suppressed — a caller that omits it (the #1549 relay run without a hook
 * payload, a hand-rolled `curl`) has given us nothing to tell two deliveries of
 * one turn from two genuine turns, and inventing a match there would silently
 * drop real events.
 *
 * @param at - Epoch ms; defaults to now
 */
export function isDuplicateAgentEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  event: AgentEventType,
  sessionId: string | null | undefined,
  at: number = Date.now()
): boolean {
  if (!sessionId) return false;

  const key = [buildCompositeKey(worktreeId, cliToolId, instanceId), event, sessionId].join(' ');
  const seenAt = recentEventKeys.get(key);
  if (seenAt !== undefined && at - seenAt < AGENT_EVENT_DEDUP_WINDOW_MS) {
    return true;
  }

  recentEventKeys.set(key, at);
  pruneRecentEventKeys(at);
  return false;
}

/** Drop keys past the window, then the oldest survivors if still over the cap. */
function pruneRecentEventKeys(now: number): void {
  for (const [key, seenAt] of recentEventKeys) {
    if (now - seenAt >= AGENT_EVENT_DEDUP_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
  // Map iterates in insertion order, so the head is the oldest.
  while (recentEventKeys.size > MAX_RECENT_EVENT_KEYS) {
    const oldest = recentEventKeys.keys().next();
    if (oldest.done) break;
    recentEventKeys.delete(oldest.value);
  }
}

/** How many dedup keys are currently retained. Test seam for the bound above. */
export function getRecentEventKeyCount(): number {
  return recentEventKeys.size;
}

/** Drop every recorded event. Test seam. */
export function clearAgentStopEvents(): void {
  lastStopEventAt.clear();
  lastAgentEvent.clear();
  recentEventKeys.clear();
  generationStartedAt.clear();
}
