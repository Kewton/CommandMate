/**
 * Sidebar Type Definitions
 *
 * Types for sidebar components and branch status display
 */

import type { Worktree } from '@/types/models';

/**
 * Branch status in sidebar
 * - idle: Session not running
 * - running: Session running, processing
 * - waiting: Waiting for user input (prompt)
 * - generating: AI is generating response
 */
export type BranchStatus = 'idle' | 'running' | 'waiting' | 'generating';

/**
 * Branch item for sidebar display
 * Derived from Worktree with sidebar-specific fields
 */
export interface SidebarBranchItem {
  /** Unique identifier (matches Worktree.id) */
  id: string;
  /** Display name (branch name) */
  name: string;
  /** Repository display name */
  repositoryName: string;
  /** Current branch status */
  status: BranchStatus;
  /** Whether there are unread messages/updates */
  hasUnread: boolean;
  /** Last activity timestamp */
  lastActivity?: Date;
  /** User memo for this branch */
  memo?: string;
}

/**
 * Determine branch status from Worktree data
 */
function determineBranchStatus(worktree: Worktree): BranchStatus {
  // Check CLI-specific status first
  const claudeStatus = worktree.sessionStatusByCli?.claude;
  if (claudeStatus) {
    if (claudeStatus.isWaitingForResponse) {
      return 'waiting';
    }
    if (claudeStatus.isRunning) {
      return 'running';
    }
  }

  // Fall back to legacy status fields
  if (worktree.isWaitingForResponse) {
    return 'waiting';
  }
  if (worktree.isSessionRunning) {
    return 'running';
  }

  return 'idle';
}

/**
 * Convert Worktree to SidebarBranchItem for display
 *
 * @param worktree - Source worktree data
 * @returns SidebarBranchItem for sidebar display
 */
export function toBranchItem(worktree: Worktree): SidebarBranchItem {
  const status = determineBranchStatus(worktree);

  // Determine hasUnread based on recent activity
  // For now, we consider it based on lastUserMessageAt presence
  const hasUnread = Boolean(worktree.lastUserMessageAt);

  return {
    id: worktree.id,
    name: worktree.name,
    repositoryName: worktree.repositoryName,
    status,
    hasUnread,
    lastActivity: worktree.updatedAt,
    memo: worktree.memo,
  };
}
