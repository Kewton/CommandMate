/**
 * CLI Tool IDs for CLI module
 *
 * Issue #757: Single source of truth.
 * Re-exports CLI_TOOL_IDS / type / type guard from the server-side source of truth
 * (src/lib/cli-tools/types.ts) instead of copying the literal array.
 *
 * - Uses a RELATIVE path, NOT the `@/` alias: tsconfig.cli.json sets `"paths": {}`,
 *   so `@/lib/...` does not resolve in the CLI build (`npm run build:cli`). The CLI
 *   module already imports server code via relative paths (e.g. `../../lib/errors`,
 *   `../../lib/security/auth`).
 * - Aliases bridge the historical naming difference between the CLI side
 *   (`isCliToolId` / `CLIToolId`) and the server side (`isCliToolType` / `CLIToolType`),
 *   keeping the CLI public API backward compatible.
 *
 * Previously (Issue #518 [DR2-07]): Approach B - subset copy guarded by a
 * cross-validation test. That copy is now eliminated; the cross-validation test
 * (tests/unit/cli/config/cross-validation.test.ts) additionally asserts reference
 * identity to lock in the single-source contract.
 */

export { CLI_TOOL_IDS, isCliToolType as isCliToolId } from '../../lib/cli-tools/types';
export type { CLIToolType as CLIToolId } from '../../lib/cli-tools/types';
