/**
 * Shared formatting helpers for the Schedules UI (Issue #826).
 *
 * Centralizes timestamp / duration formatting so that the Schedules pane and
 * the Execution Logs view present "last run" / "next run" / log times in one
 * consistent format.
 */

/** Format a unix-millis timestamp using the user's locale. */
export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Format the duration between two timestamps in human-readable form. */
export function formatDuration(startedAt: number, completedAt: number | null): string | null {
  if (completedAt === null) return null;
  const durationMs = completedAt - startedAt;
  if (durationMs < 0) return null;

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
