/**
 * Default capture line count for session status detection.
 * Used by both worktree-status-helper.ts and current-output/route.ts
 * to ensure consistent status detection across APIs.
 *
 * Issue #604: Previously, worktree-status-helper used 100 lines while
 * current-output used 10000, causing status inconsistency when tmux
 * buffer had 150+ trailing blank lines after a prompt.
 */
export const STATUS_CAPTURE_LINES = 10000;
