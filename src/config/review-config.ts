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

/**
 * Maximum character length for commit log section in summary prompt.
 * Issue #627: Commit log in report
 */
export const MAX_COMMIT_LOG_LENGTH = 3000;

/**
 * Total timeout in milliseconds for collecting commit logs from all repositories.
 * Issue #627: Commit log in report
 */
export const GIT_LOG_TOTAL_TIMEOUT_MS = 15_000;

/**
 * Maximum total character length for the summary prompt.
 * Issue #634: Section-based prompt length management
 */
export const MAX_PROMPT_LENGTH = 15000;

/**
 * Maximum character length for user_data section in summary prompt.
 * Issue #634: Section-based prompt length management
 */
export const MAX_USER_DATA_LENGTH = 6000;

/**
 * Maximum character length for issue_context section in summary prompt.
 * Issue #634: Section-based prompt length management
 */
export const MAX_ISSUE_CONTEXT_LENGTH = 3000;

/**
 * Maximum character length for issue body summary in prompt.
 * Issue #630: Issue context in report
 */
export const MAX_ISSUE_BODY_LENGTH = 500;

/**
 * Maximum number of issues to fetch per report generation.
 * Issue #630: Issue context in report
 */
export const MAX_ISSUES_PER_REPORT = 20;

/**
 * Timeout in milliseconds for fetching a single GitHub Issue.
 * Issue #630: Issue context in report
 */
export const ISSUE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Total timeout in milliseconds for fetching all GitHub Issues.
 * Issue #630: Issue context in report
 */
export const ISSUE_FETCH_TOTAL_TIMEOUT_MS = 15_000;
