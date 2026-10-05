/**
 * Global session constants for assistant chat feature
 * Issue #649: Assistant chat with global (non-worktree) sessions
 *
 * Defines the special worktree ID used for global assistant sessions.
 */

/**
 * Special worktree ID for global assistant sessions.
 * Used as the worktreeId parameter when creating tmux sessions
 * via BaseCLITool.getSessionName('__global__') -> 'mcbd-{tool}-__global__'
 *
 * This value must NOT appear as a real worktree ID in the database.
 */
export const GLOBAL_SESSION_WORKTREE_ID = '__global__' as const;
