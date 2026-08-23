/**
 * Counters for the D1 idle-evidence rollout (Issue #1927, §11 / DR3-016).
 *
 * §11's live row makes the rollout condition measurable rather than a matter of
 * opinion: 「倒す前後で `unclassified_frames` の記録件数が有意に増えない」, and
 * 「観測だけを先に走らせて件数を採る」. That needs a run in which each tool's
 * rule is evaluated but not applied, and a place for the tally to accumulate.
 *
 * This is that place. It is deliberately the same shape as
 * `unclassified-frame-tracker`: in-memory, per-process, `globalThis`-backed so
 * `npm run dev` does not zero it on every hot reload, and free of I/O — the
 * detector stays a pure function of the frame and the caller decides what to do
 * with the tally.
 *
 * Read it from `capture --json`'s unclassified-frame record (see
 * `current-output-builder`), or from a REPL against a running server.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { IdleEvidenceMode } from '@/config/detection-evidence-config';
import type { StatusEvidence } from '@/lib/session/status-evidence';

/** One tool's tally since the process started (or the last reset). */
export interface IdleEvidenceObservation {
  /** Mode the most recent observation ran under. */
  mode: IdleEvidenceMode;
  /** Frames whose idle rule vouched for the composer. */
  positive: number;
  /**
   * Frames whose idle rule declined.
   *
   * In `observe` mode this is the number of frames that WOULD have gained
   * `isUnclassifiedActive: true` had the rule been enforced — i.e. the increase
   * §11 asks to bound before the flip.
   */
  none: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __idleEvidenceObservations: Map<string, IdleEvidenceObservation> | undefined;
}

const observations =
  globalThis.__idleEvidenceObservations ??
  (globalThis.__idleEvidenceObservations = new Map<string, IdleEvidenceObservation>());

/**
 * Fold one frame's idle-evidence verdict into the tally for `tool`.
 *
 * Called for every frame that reaches the generic composer check, in every
 * mode — including `legacy`, where the rule is not run and nothing is recorded.
 *
 * @param tool - CLI tool the frame belongs to
 * @param mode - Rollout mode the verdict was produced under
 * @param evidence - What the tool's rule answered
 */
export function recordIdleEvidenceObservation(
  tool: CLIToolType,
  mode: IdleEvidenceMode,
  evidence: StatusEvidence,
): void {
  const entry = observations.get(tool) ?? { mode, positive: 0, none: 0 };
  entry.mode = mode;
  if (evidence === 'positive') entry.positive += 1;
  else entry.none += 1;
  observations.set(tool, entry);
}

/** The tally so far, as a plain object safe to put on a JSON payload. */
export function getIdleEvidenceObservations(): Record<string, IdleEvidenceObservation> {
  return Object.fromEntries([...observations].map(([tool, entry]) => [tool, { ...entry }]));
}

/** Drop every tally. Test seam, and the "start measuring now" reset. */
export function resetIdleEvidenceObservations(): void {
  observations.clear();
}
