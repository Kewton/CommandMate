/**
 * Global session constants for assistant chat feature
 * Issue #649: Assistant chat with global (non-worktree) sessions
 *
 * These constants define the special worktree ID used for global assistant sessions
 * and polling configuration for the assistant chat panel.
 */

/**
 * Special worktree ID for global assistant sessions.
 * Used as the worktreeId parameter when creating tmux sessions
 * via BaseCLITool.getSessionName('__global__') -> 'mcbd-{tool}-__global__'
 *
 * This value must NOT appear as a real worktree ID in the database.
 */
export const GLOBAL_SESSION_WORKTREE_ID = '__global__' as const;

/**
 * Polling interval for global session output capture (ms).
 * Matches the existing POLLING_INTERVAL in response-poller-core.ts (2 seconds).
 */
export const GLOBAL_POLL_INTERVAL_MS = 2000;

/**
 * Maximum number of polling retries before giving up.
 * 900 retries * 2s interval = 30 minutes (matches MAX_POLLING_DURATION).
 */
export const GLOBAL_POLL_MAX_RETRIES = 900;
