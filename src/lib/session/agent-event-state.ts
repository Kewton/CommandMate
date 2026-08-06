/**
 * In-memory record of the structured lifecycle events an agent has reported
 * (#1549, extended in #1722).
 *
 * The agent CLI telling us what it did is a different kind of fact from the
 * screen-scraped status: it is exact, but until #1722 it only existed when
 * someone wired a hook up by hand. So this is kept beside the detector's output
 * rather than folded into it — `buildCurrentOutput` exposes it, and nothing in
 * the completion decision reads it. #1722 remains observation only; swapping the
 * wait/poller verdict from string matching to hook events before there is field
 * data on how often hooks actually fire would trade a known failure mode for an
 * unknown one. That swap is #1723.
 *
 * In-memory and not in SQLite for the same reason `auto-yes-state` is: the value
 * describes a live tmux session, and a session does not survive a server restart
 * for the timestamp to still be about.
 *
 * @module lib/session/agent-event-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';

/** compositeKey -> epoch ms of the most recent stop event. */
const lastStopEventAt = new Map<string, number>();

/** compositeKey -> the most recent event of any kind. */
const lastAgentEvent = new Map<string, AgentEventRecord>();

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
  lastAgentEvent.set(buildCompositeKey(worktreeId, cliToolId, instanceId), record);
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
}
