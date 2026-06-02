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
