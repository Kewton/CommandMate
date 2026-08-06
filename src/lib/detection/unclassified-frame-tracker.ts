/**
 * Dwell tracking for interactive frames the detection layer could not classify
 * (Issue #1708).
 *
 * `isUnclassifiedActive` is a per-poll observation: the frame looked interactive
 * and nothing parsed it. A single true reading proves nothing — a capture taken
 * mid-repaint produces one routinely — so the signal only becomes actionable
 * once it has held for a while. This module owns that "for a while", and owns
 * the once-per-run guard that keeps a stalled session from writing a history row
 * on every poll.
 *
 * Deliberately free of I/O: the caller decides what to do with the verdict. The
 * state is in-memory and per-process, matching the Auto-Yes prompt dedup it sits
 * beside — a server restart re-arms the tracker, which costs at most one
 * duplicate record and never a missed one.
 */

/**
 * globalThis pattern for hot reload persistence — Issue #153, as used by
 * auto-yes-state.ts and auto-yes-poller.ts.
 *
 * Without it, `npm run dev` discards every run whenever this module is
 * re-evaluated, so a 60s dwell restarts from zero on each hot reload and the
 * record is never written — the failure is invisible because the flag itself
 * still looks correct in the payload.
 *
 * Unlike the auto-yes Maps, this one is NOT registered with
 * cleanupOrphanedMapEntries() in resource-cleanup.ts, and does not need to be:
 * every entry is deleted the moment its session reports a classified frame, and
 * {@link pruneExpiredRuns} drops runs whose session simply stopped being polled.
 * Those two together bound it without a DB round trip. If it ever grows state
 * that outlives a run, register it there like the others.
 */
declare global {
  // eslint-disable-next-line no-var
  var __unclassifiedFrameRuns: Map<string, UnclassifiedRun> | undefined;
}

/**
 * How long a frame must stay unclassified before it is worth recording.
 *
 * Matches UNCLASSIFIED_DWELL_MS in src/cli/commands/wait.ts on purpose: the row
 * this produces is the audit trail for exactly the state `wait` reports as
 * exit 10, and two different thresholds would leave one of them explaining a
 * stall the other never saw.
 */
export const UNCLASSIFIED_RECORD_DWELL_MS = 60_000;

interface UnclassifiedRun {
  /** Epoch ms of the first observation in this unbroken run. */
  since: number;
  /** Epoch ms of the most recent observation in this run. */
  lastSeen: number;
  /** Whether this run has already produced a record. */
  recorded: boolean;
}

const runs = globalThis.__unclassifiedFrameRuns ??
  (globalThis.__unclassifiedFrameRuns = new Map<string, UnclassifiedRun>());

/**
 * How long an unobserved run survives before it is dropped.
 *
 * A run normally ends when its session reports a classified frame. It can also
 * end by nobody ever asking again — the worktree was removed, the session was
 * killed, the browser tab was closed. Nothing calls back to say so, so entries
 * are aged out instead. Generous on purpose: it only has to be longer than any
 * real polling gap, and an entry that is dropped early merely restarts the dwell
 * for a session nobody is watching.
 */
const RUN_IDLE_TTL_MS = 60 * 60 * 1000;

/** Drop runs nothing has reported on for {@link RUN_IDLE_TTL_MS}. */
function pruneExpiredRuns(now: number): void {
  for (const [key, run] of runs) {
    if (now - run.lastSeen > RUN_IDLE_TTL_MS) runs.delete(key);
  }
}

export interface UnclassifiedFrameVerdict {
  /** How long the current unbroken run has lasted, in ms. 0 when not in one. */
  dwellMs: number;
  /**
   * True exactly once per unbroken run — on the first observation at or past
   * the threshold. This is the dedup: while the same stalled frame sits there
   * being re-polled, every later observation answers false.
   */
  shouldRecord: boolean;
}

/**
 * Fold one poll's `isUnclassifiedActive` reading into the run for `key`.
 *
 * @param key - Session identity; use the same composite key the pollers use
 *   (worktree:cliTool:instance) so instances of one agent track separately
 * @param isUnclassifiedActive - This poll's reading
 * @param now - Epoch ms, injectable for tests
 */
export function observeUnclassifiedFrame(
  key: string,
  isUnclassifiedActive: boolean,
  now: number = Date.now(),
): UnclassifiedFrameVerdict {
  pruneExpiredRuns(now);

  if (!isUnclassifiedActive) {
    runs.delete(key);
    return { dwellMs: 0, shouldRecord: false };
  }

  const run = runs.get(key);
  if (!run) {
    runs.set(key, { since: now, lastSeen: now, recorded: false });
    return { dwellMs: 0, shouldRecord: false };
  }
  run.lastSeen = now;

  // A clock that went backwards (NTP step) must not park the run at a dwell it
  // can never work off; treat it as a fresh start instead.
  const dwellMs = Math.max(0, now - run.since);
  if (run.recorded || dwellMs < UNCLASSIFIED_RECORD_DWELL_MS) {
    return { dwellMs, shouldRecord: false };
  }

  run.recorded = true;
  return { dwellMs, shouldRecord: true };
}

/**
 * Forget tracking state.
 *
 * @param key - Session to forget; omit to clear every session (tests)
 */
export function resetUnclassifiedFrameTracking(key?: string): void {
  if (key === undefined) {
    runs.clear();
    return;
  }
  runs.delete(key);
}

/** Number of sessions currently being tracked. Test-only. @internal */
export function unclassifiedFrameRunCount(): number {
  return runs.size;
}
