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
  /** Whether this run has already produced a record. */
  recorded: boolean;
}

const runs = new Map<string, UnclassifiedRun>();

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
  if (!isUnclassifiedActive) {
    runs.delete(key);
    return { dwellMs: 0, shouldRecord: false };
  }

  const run = runs.get(key);
  if (!run) {
    runs.set(key, { since: now, recorded: false });
    return { dwellMs: 0, shouldRecord: false };
  }

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
