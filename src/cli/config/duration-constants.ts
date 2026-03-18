/**
 * Duration Constants for CLI
 * Issue #518: CLI-side duration mapping (safe-regex2 dependency avoidance)
 *
 * [DR1-09] Cross-validation test ensures these values match server-side
 * ALLOWED_DURATIONS in src/config/auto-yes-config.ts
 */

/** Allowed duration values and their millisecond equivalents */
export const DURATION_MAP: Record<string, number> = {
  '1h': 3_600_000,
  '3h': 10_800_000,
  '8h': 28_800_000,
};

/** List of allowed duration strings */
export const ALLOWED_DURATIONS = Object.keys(DURATION_MAP);

/**
 * Parse a duration string to milliseconds.
 * @param duration - Duration string (e.g., '1h', '3h', '8h')
 * @returns Milliseconds or null if invalid
 */
export function parseDurationToMs(duration: string): number | null {
  return DURATION_MAP[duration] ?? null;
}
