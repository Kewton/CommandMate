/**
 * Schedule Execution Configuration Constants
 * Issue #294: Centralized constants for schedule-related API routes
 *
 * Eliminates duplication of validation constants and UUID validation
 * across schedules/route.ts, schedules/[scheduleId]/route.ts,
 * and execution-logs/[logId]/route.ts.
 *
 * [S4-014] UUID v4 format validation
 */

// =============================================================================
// Validation Constants
// =============================================================================

/** Maximum schedule name length */
export const MAX_SCHEDULE_NAME_LENGTH = 100;

/** Maximum message length for schedule execution */
export const MAX_SCHEDULE_MESSAGE_LENGTH = 10000;

/** Maximum cron expression length */
export const MAX_SCHEDULE_CRON_LENGTH = 100;

// =============================================================================
// Permission Constants
// =============================================================================

/** Allowed permission values for claude CLI (--permission-mode) */
export const CLAUDE_PERMISSIONS = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const;
export type ClaudePermission = (typeof CLAUDE_PERMISSIONS)[number];

/** Allowed sandbox values for codex CLI (--sandbox) */
export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

/** Allowed permission values for gemini CLI (no permission flags) */
export const GEMINI_PERMISSIONS = [] as const;

/** Allowed permission values for vibe-local CLI (no permission flags) */
export const VIBE_LOCAL_PERMISSIONS = [] as const;

/** Default permission per CLI tool */
export const DEFAULT_PERMISSIONS: Record<string, string> = {
  claude: 'acceptEdits',
  codex: 'workspace-write',
  gemini: '',
  'vibe-local': '',
};

// =============================================================================
// UUID Validation
// =============================================================================

/**
 * UUID v4 validation pattern.
 * Matches standard UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
 *
 * [S4-014] Used to validate schedule IDs and execution log IDs
 */
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a valid UUID v4 format.
 *
 * @param id - String to validate
 * @returns true if the string matches UUID v4 format
 */
export function isValidUuidV4(id: string): boolean {
  return UUID_V4_PATTERN.test(id);
}
