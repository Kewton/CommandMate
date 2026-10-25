/**
 * Duration Constants for CLI
 *
 * Issue #3913: Single source of truth. Re-exports the Auto-Yes duration
 * definitions from the dependency-free `src/config/auto-yes-duration.ts`
 * instead of copying them (same shape as `cli-tool-ids.ts`).
 *
 * - Uses a RELATIVE path, NOT the `@/` alias: tsconfig.cli.json sets `"paths": {}`,
 *   so `@/config/...` does not resolve in the CLI build (`npm run build:cli`).
 *   `src/config/auto-yes-config.ts` itself stays out of reach (it imports
 *   safe-regex2 and `@/`), which is why the definitions sit in their own module.
 *
 * Previously (Issue #518 [DR1-09]): a `'1h'|'3h'|'8h'` → ms copy guarded by a
 * cross-validation test. The cross-validation test
 * (tests/unit/cli/config/cross-validation.test.ts) now checks all 24 values and
 * the shared reference.
 */

export {
  AUTO_YES_DURATIONS,
  AUTO_YES_DURATION_FLAG_PATTERN,
  AUTO_YES_DURATION_FLAG_RANGE,
  parseAutoYesDurationFlag as parseDurationToMs,
} from '../../config/auto-yes-duration';

/** The `--duration` used when the flag is omitted */
export const DEFAULT_DURATION_FLAG = '1h';
