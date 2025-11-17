/**
 * Data models for myCodeBranchDesk
 */

/**
 * Worktree representation
 */
export interface Worktree {
  /** URL-safe ID (e.g., "main", "feature-foo") */
  id: string;
  /** Display name (e.g., "main", "feature/foo") */
  name: string;
  /** Absolute path to worktree directory */
  path: string;
  /** Summary of last message (for list view) */
  lastMessageSummary?: string;
  /** Last updated timestamp */
  updatedAt?: Date;
}

/**
 * Chat message role
 */
export type ChatRole = 'user' | 'claude';

/**
 * Chat message
 */
export interface ChatMessage {
  /** Unique message ID (UUID) */
  id: string;
  /** Associated worktree ID */
  worktreeId: string;
  /** Message author role */
  role: ChatRole;
  /** Message content */
  content: string;
  /** Optional summary */
  summary?: string;
  /** Message timestamp */
  timestamp: Date;
  /** Associated log file name (relative path) */
  logFileName?: string;
  /** Request ID for tracking (future use) */
  requestId?: string;
}

/**
 * Worktree session state for tmux capture
 */
export interface WorktreeSessionState {
  /** Associated worktree ID */
  worktreeId: string;
  /** Last captured line number from tmux */
  lastCapturedLine: number;
}
