/**
 * Git status polling configuration
 * Issue #779: git status API + GitPane Current Status (Phase 1/5)
 *
 * Semantic separation from file-polling-config: GitPane's Current Status
 * section polls `GET /api/worktrees/[id]/git/status` on its own cadence.
 */

/**
 * Polling interval (ms) for GitPane's Current Status section.
 * Issue #779: drives `useFilePolling` in GitPane (visibilitychange-aware).
 */
export const GIT_STATUS_POLL_INTERVAL_MS = 5000;

// =============================================================================
// Issue #780: stage / unstage / commit operations
// =============================================================================

/**
 * Timeout (ms) for git WRITE operations (add / restore --staged / commit) and
 * for the staged-status read used by those flows. Deliberately larger than the
 * 1s `GIT_COMMAND_TIMEOUT_MS` used by getGitStatus (#779) because write ops can
 * run pre-commit hooks and stage large numbers of files.
 */
export const GIT_WRITE_TIMEOUT_MS = 30000;

/**
 * Maximum number of file paths accepted in a single stage / unstage request.
 * Requests exceeding this are rejected with HTTP 400 to bound argv size and
 * per-request work.
 */
export const MAX_GIT_FILES = 1000;

/**
 * Maximum length (characters) of a commit message. Messages exceeding this are
 * rejected with HTTP 400.
 */
export const MAX_COMMIT_MESSAGE_LENGTH = 10000;
