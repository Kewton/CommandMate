/**
 * Timer formatting helpers (Issue #945)
 *
 * Shared between TimerPane (list rows + countdown) and TimerEditDialog (the
 * delay <select>). Extracted so the same human-readable delay label is used in
 * both places without duplicating the logic.
 */

/** Format a delay in milliseconds as a compact "Xh Ym" / "Xh" / "Ym" label. */
export function formatDelayLabel(delayMs: number): string {
  const totalMinutes = Math.floor(delayMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${minutes}m`;
}
