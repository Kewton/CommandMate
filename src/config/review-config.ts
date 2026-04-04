/**
 * Review screen and report template configuration constants
 *
 * Issue #600: UX refresh - Review screen stalled detection and polling
 * Issue #618: Report template system
 */

/**
 * Threshold in milliseconds for considering a worktree as "stalled".
 * If no auto-yes server response has been received for this duration,
 * the worktree is considered stalled.
 *
 * Default: 5 minutes (300,000 ms)
 */
export const STALLED_THRESHOLD_MS = 300_000;

/**
 * Polling interval in milliseconds for the Review screen.
 * Used to periodically refresh worktree review statuses.
 *
 * Default: 7 seconds (7,000 ms)
 */
export const REVIEW_POLL_INTERVAL_MS = 7_000;

/**
 * Timeout in milliseconds for AI summary generation.
 * Issue #607: Daily summary feature
 *
 * Default: 60 seconds (60,000 ms)
 */
export const SUMMARY_GENERATION_TIMEOUT_MS = 60_000;

/**
 * Allowed CLI tools for AI summary generation.
 * Issue #607: Only claude, codex, copilot support non-interactive execution.
 */
export const SUMMARY_ALLOWED_TOOLS = ['claude', 'codex', 'copilot'] as const;
export type SummaryAllowedTool = typeof SUMMARY_ALLOWED_TOOLS[number];

/**
 * Maximum character length for user instruction in summary generation.
 * Issue #612: Report UI improvements
 */
export const MAX_USER_INSTRUCTION_LENGTH = 1000;

/**
 * Maximum number of report templates.
 * Issue #618: Report template system
 */
export const MAX_TEMPLATES = 5;

/**
 * Maximum character length for template name.
 * Issue #618: Report template system
 */
export const MAX_TEMPLATE_NAME_LENGTH = 100;

/**
 * Maximum character length for template content.
 * Issue #618: Report template system
 */
export const MAX_TEMPLATE_CONTENT_LENGTH = 1000;
