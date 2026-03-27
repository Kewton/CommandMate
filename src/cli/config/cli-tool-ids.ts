/**
 * CLI Tool IDs for CLI module
 * Issue #518: [DR2-07] Approach B - Subset copy with cross-validation test
 *
 * Source of truth: src/lib/cli-tools/types.ts CLI_TOOL_IDS
 * Cross-validation test: tests/unit/cli/config/cross-validation.test.ts
 */

/** CLI tool IDs available for --agent option */
export const CLI_TOOL_IDS = ['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot'] as const;

export type CLIToolId = typeof CLI_TOOL_IDS[number];

/**
 * Check if a string is a valid CLI tool ID
 * @param value - String to check
 * @returns True if value is a valid CLI tool ID
 */
export function isCliToolId(value: string): value is CLIToolId {
  return (CLI_TOOL_IDS as readonly string[]).includes(value);
}
