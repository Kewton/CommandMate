/**
 * Auto-Yes duration definitions (Issue #3913)
 *
 * The one definition of how long an Auto-Yes grant may last: any whole number
 * of hours from 1 to 24. Server (route, state), browser (confirm dialog, new
 * task) and CLI (`--duration`) all read it from here.
 *
 * Dependency-free on purpose: no `@/` alias and no safe-regex2, so the CLI
 * build (tsconfig.cli.json sets `"paths": {}`) can re-export it through a
 * relative path (`src/cli/config/duration-constants.ts`) instead of keeping a
 * copy. `scripts/orchestrate/launch-worker.mjs` cannot import TypeScript and
 * copies only {@link AUTO_YES_DURATION_FLAG_PATTERN}; a unit test keeps the
 * copy equal to this one.
 */

/** Milliseconds per hour */
export const AUTO_YES_MS_PER_HOUR = 3_600_000;

/** Shortest grant, in hours */
export const MIN_AUTO_YES_HOURS = 1;

/** Longest grant, in hours (agreed upper bound, 2026-10-25) */
export const MAX_AUTO_YES_HOURS = 24;

/**
 * Every allowed duration in milliseconds: 1h, 2h, ..., 24h.
 *
 * Written out as literals so {@link AutoYesDuration} stays a literal union —
 * a `number` would let NaN, Infinity and fractions through the type.
 */
export const AUTO_YES_DURATIONS = [
  3_600_000, 7_200_000, 10_800_000, 14_400_000, 18_000_000, 21_600_000,
  25_200_000, 28_800_000, 32_400_000, 36_000_000, 39_600_000, 43_200_000,
  46_800_000, 50_400_000, 54_000_000, 57_600_000, 61_200_000, 64_800_000,
  68_400_000, 72_000_000, 75_600_000, 79_200_000, 82_800_000, 86_400_000,
] as const;

/** Auto-Yes duration type (literal union of the 24 values in AUTO_YES_DURATIONS) */
export type AutoYesDuration = typeof AUTO_YES_DURATIONS[number];

/** The often-used durations offered as one-tap choices (1h / 3h / 8h) */
export const PRESET_AUTO_YES_DURATIONS = [3_600_000, 10_800_000, 28_800_000] as const satisfies readonly AutoYesDuration[];

/** Default Auto-Yes duration (1 hour = 3600000ms) */
export const DEFAULT_AUTO_YES_DURATION: AutoYesDuration = 3_600_000;

/**
 * Type guard: check whether a value is one of the 24 allowed durations.
 * Rejects every non-number, NaN, ±Infinity, fractions of an hour and values
 * outside 1〜24h.
 */
export function isAllowedDuration(value: unknown): value is AutoYesDuration {
  return typeof value === 'number' && (AUTO_YES_DURATIONS as readonly number[]).includes(value);
}

/** Whole hours of an allowed duration (e.g. 18000000 → 5) */
export function autoYesDurationToHours(duration: AutoYesDuration): number {
  return duration / AUTO_YES_MS_PER_HOUR;
}

/** The duration for a whole number of hours, or null outside 1〜24 */
export function hoursToAutoYesDuration(hours: number): AutoYesDuration | null {
  const ms = hours * AUTO_YES_MS_PER_HOUR;
  return isAllowedDuration(ms) ? ms : null;
}

/**
 * The CLI `--duration` format: `1h`〜`24h`, lower-case `h`, no leading zero,
 * sign, whitespace, fraction or other unit.
 */
export const AUTO_YES_DURATION_FLAG_PATTERN = /^(?:[1-9]|1[0-9]|2[0-4])h$/;

/** How the CLI help and errors name the accepted range */
export const AUTO_YES_DURATION_FLAG_RANGE = '1h-24h, whole hours';

/**
 * Parse a CLI `--duration` value (e.g. '5h') to milliseconds.
 * @returns The duration, or null when the value is not `1h`〜`24h`
 */
export function parseAutoYesDurationFlag(flag: string): AutoYesDuration | null {
  if (!AUTO_YES_DURATION_FLAG_PATTERN.test(flag)) return null;
  return hoursToAutoYesDuration(Number(flag.slice(0, -1)));
}
