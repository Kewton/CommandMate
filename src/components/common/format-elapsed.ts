/**
 * Stopwatch-style elapsed time (`12s`, `3m 05s`).
 *
 * Lifted out of `worktree/VerificationPane` by Issue #3179 so the session
 * starting notice spells a wait the same way the verification run does. That
 * module re-exports it under the same name.
 *
 * @module components/common/format-elapsed
 */

/**
 * Elapsed wall-clock for something a human is waiting on.
 *
 * Not `formatGateDuration`: that formats a *gate's* measured duration and
 * rounds anything over ten seconds to whole seconds, so a five-minute run reads
 * `312s`. A wait is spelled the way a stopwatch does.
 *
 * @param ms - Elapsed milliseconds (negative clamps to 0)
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}
