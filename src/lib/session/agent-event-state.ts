/**
 * In-memory record of the last structured "the agent stopped" event (#1549).
 *
 * The agent CLI telling us it stopped is a different kind of fact from the
 * screen-scraped status: it is exact, but it only exists when someone wired a
 * hook up. So this is kept beside the detector's output rather than folded into
 * it — `buildCurrentOutput` exposes the timestamp, and nothing in the completion
 * decision reads it yet. Phase 3-2 is deliberately observation only; swapping
 * the wait/poller verdict from string matching to hook events before there is
 * field data on how often hooks actually fire would trade a known failure mode
 * for an unknown one.
 *
 * In-memory and not in SQLite for the same reason `auto-yes-state` is: the value
 * describes a live tmux session, and a session does not survive a server restart
 * for the timestamp to still be about.
 *
 * @module lib/session/agent-event-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** compositeKey -> epoch ms of the most recent stop event. */
const lastStopEventAt = new Map<string, number>();

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

/** Drop every recorded event. Test seam. */
export function clearAgentStopEvents(): void {
  lastStopEventAt.clear();
}
