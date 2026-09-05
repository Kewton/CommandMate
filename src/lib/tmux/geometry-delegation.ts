/**
 * Phase D of Issue #2317, server side: knowing when a human owns the geometry.
 *
 * `commandmate attach --live` hands a session's window from the pinned
 * 200x1000 canvas to the attached terminal (`window-size latest`) so the agent
 * re-lays-out and the transcript is actually readable, then pins it back on
 * detach. While that handover is in force the session carries `@cm_delegated=1`,
 * and the server has to behave differently in exactly two places:
 *
 * 1. **`reconcileSessionGeometry` must not resize.** Every `send` to a live
 *    session reaches `reconcileExistingSession()`, which would snap the window
 *    back to 200x1000 mid-read — the #1623 rejection note assumed this happened
 *    on every send and it does not, but it does happen on a session restart and
 *    on the reuse path, which is enough to break a delegated read.
 * 2. **The poller must not save a scraped reply.** At 44 rows the frame is a
 *    fraction of the turn, and every extraction rule in `response-checker` was
 *    measured against the 1000-row canvas. claude — the only tool `--live`
 *    accepts — writes its History from its own transcript JSONL, so suppressing
 *    the scrape loses nothing and prevents a truncated reply being recorded.
 *
 * ## Why the flag is read from tmux rather than held in memory
 *
 * The delegation is performed by the CLI process (`commandmate attach --live`),
 * which is not the server. The tmux session is the only thing both of them can
 * see, and a user option on it is the cheapest shared channel that survives the
 * CLI exiting, the server restarting, and a `client-detached` hook firing when
 * neither is watching.
 *
 * ## Why the read is cached
 *
 * `checkForResponse` runs about every two seconds per active session. A
 * `show-options` per poll would be one extra tmux round-trip per session per
 * poll for a value that changes twice a day, so reads are memoised for
 * {@link DELEGATION_TTL_MS}. The TTL is short enough that the restore edge is
 * observed within one poll of the detach.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  CM_DELEGATED_OPTION,
  buildListClientsArgs,
  buildShowSessionOptionValueArgs,
  countHumanClients,
} from '../session/tmux-session-surface';

const execFileAsync = promisify(execFile);

/** tmux calls here are interactive-latency, not long-running. */
const TMUX_TIMEOUT = 5000;

/**
 * How long a delegation read is reused.
 *
 * One second, against a ~2s poll: short enough that the poll after a detach sees
 * the restore, long enough that the several readers of one session in one poll
 * (the status helper, the response checker) share a single tmux round-trip.
 */
export const DELEGATION_TTL_MS = 1000;

interface CacheEntry {
  delegated: boolean;
  readAt: number;
}

/**
 * globalThis-backed, for the reason `status-evidence.ts` gives: `npm run dev`
 * re-evaluates this module on every edit, and a forgotten edge would mean the
 * `last_captured_line` reset never runs for a session that was delegated across
 * a hot reload.
 */
declare global {
  // eslint-disable-next-line no-var
  var __cmGeometryDelegationCache: Map<string, CacheEntry> | undefined;
  // eslint-disable-next-line no-var
  var __cmGeometryDelegationEdge: Map<string, boolean> | undefined;
}

const cache =
  globalThis.__cmGeometryDelegationCache ??
  (globalThis.__cmGeometryDelegationCache = new Map<string, CacheEntry>());

const lastObserved =
  globalThis.__cmGeometryDelegationEdge ??
  (globalThis.__cmGeometryDelegationEdge = new Map<string, boolean>());

/**
 * Whether `@cm_delegated` is set to `1` on a session.
 *
 * Never throws: a session that has gone away, or a tmux that is not running, is
 * "not delegated" — the answer that leaves every caller on its normal path.
 *
 * @param sessionName - Target session
 * @param now - Epoch ms, injectable for tests
 */
export async function isGeometryDelegated(
  sessionName: string,
  now: number = Date.now(),
): Promise<boolean> {
  const cached = cache.get(sessionName);
  if (cached && now - cached.readAt < DELEGATION_TTL_MS) return cached.delegated;

  let delegated = false;
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      buildShowSessionOptionValueArgs(sessionName, CM_DELEGATED_OPTION),
      { timeout: TMUX_TIMEOUT },
    );
    delegated = stdout.trim() === '1';
  } catch {
    // THE ORDINARY CASE, not an error path. Measured on tmux 3.5a: asking for a
    // user option a session does not carry exits NON-ZERO with
    // `invalid option: @cm_delegated` — it is not an empty string and it is not
    // exit 0. So "this session has never been delegated" arrives here, and it
    // arrives here on every poll of every session, which is why nothing is
    // logged. A session that is gone, and a tmux that is not running, land in
    // the same place and mean the same thing.
    delegated = false;
  }

  cache.set(sessionName, { delegated, readAt: now });
  return delegated;
}

/** One session's delegation state plus the edge since the last probe. */
export interface DelegationProbe {
  /** Whether a human currently owns the geometry. */
  delegated: boolean;
  /** True on the delegated -> not-delegated edge, exactly once. */
  released: boolean;
}

/**
 * Read the delegation flag and report the release edge.
 *
 * The edge is what the poller needs: on restore the pane goes back to 1000 rows,
 * so a `last_captured_line` recorded against a 44-row frame indexes into
 * nothing. Resetting the cursor at that moment is what closes both the
 * double-save window (a cursor too low re-saves) and the never-save window (a
 * cursor too high suppresses forever).
 *
 * @param sessionName - Target session
 * @param now - Epoch ms, injectable for tests
 */
export async function probeGeometryDelegation(
  sessionName: string,
  now: number = Date.now(),
): Promise<DelegationProbe> {
  const delegated = await isGeometryDelegated(sessionName, now);
  const previous = lastObserved.get(sessionName) ?? false;
  lastObserved.set(sessionName, delegated);
  return { delegated, released: previous && !delegated };
}

/**
 * Whether any NON-control-mode client is attached to the session.
 *
 * Used by `reconcileSessionGeometry` as the second half of its skip condition:
 * `@cm_delegated` says "a `--live` attach is in force", this says "somebody is
 * looking at it right now". A control-mode client — CommandMate's own transport
 * — never counts, which is what keeps the server from treating its own
 * connection as a reason to stop pinning the canvas.
 *
 * Never throws; an unreadable client list is "nobody is attached".
 */
export async function hasHumanClientAttached(sessionName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('tmux', buildListClientsArgs(sessionName), {
      timeout: TMUX_TIMEOUT,
    });
    return countHumanClients(stdout) > 0;
  } catch {
    return false;
  }
}

/** Drop every memo for a session — call when it is known to be gone. */
export function forgetGeometryDelegation(sessionName: string): void {
  cache.delete(sessionName);
  lastObserved.delete(sessionName);
}

/** Test seam: drop every memo, for suites that drive several sessions. */
export function resetGeometryDelegationState(): void {
  cache.clear();
  lastObserved.clear();
}
