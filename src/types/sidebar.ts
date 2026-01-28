/**
 * Sidebar Type Definitions
 *
 * Types for sidebar components and branch status display
 */

import type { Worktree } from '@/types/models';

/**
 * Branch status in sidebar
 * - idle: Session not running
 * - ready: Session running, waiting for user's new message (green dot)
 * - running: Session running, processing user's request (spinner)
 * - waiting: Waiting for user input on yes/no prompt (green dot)
 * - generating: AI is generating response
 */
export type BranchStatus = 'idle' | 'ready' | 'running' | 'waiting' | 'generating';

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
  /** Last activity timestamp (Date object or ISO string from API) */
  lastActivity?: Date | string;
  /** User description for this branch */
  description?: string;
}

/**
 * Determine branch status from Worktree data
 *
 * Status priority:
 * - waiting: Claude asked a yes/no prompt, waiting for user's answer (green dot)
 * - running: Claude is actively processing user's request (spinner)
 * - ready: Session running, waiting for user's new message (green dot)
 * - idle: Session not running (gray dot)
 */
function determineBranchStatus(worktree: Worktree): BranchStatus {
  // Check CLI-specific status first
  const claudeStatus = worktree.sessionStatusByCli?.claude;
  if (claudeStatus) {
    if (claudeStatus.isWaitingForResponse) {
      return 'waiting';
    }
    if (claudeStatus.isProcessing) {
      return 'running';
    }
    // Session running but not processing = ready (waiting for user to type new message)
    if (claudeStatus.isRunning) {
      return 'ready';
    }
  }

  // Fall back to legacy status fields
  if (worktree.isWaitingForResponse) {
    return 'waiting';
  }
  if (worktree.isProcessing) {
    return 'running';
  }
  // Session running but not processing = ready
  if (worktree.isSessionRunning) {
    return 'ready';
  }

  return 'idle';
}

/**
 * Calculate whether a worktree has unread messages
 *
 * hasUnread is true when:
 * - There is at least one assistant message (lastAssistantMessageAt exists)
 * - AND the user has never viewed this worktree (lastViewedAt is null)
 *   OR the last assistant message is newer than the last view
 *
 * @param worktree - Source worktree data
 * @returns true if there are unread messages
 */
export function calculateHasUnread(worktree: Worktree): boolean {
  // No assistant messages = no unread
  if (!worktree.lastAssistantMessageAt) {
    return false;
  }

  // Never viewed but has assistant message = unread
  if (!worktree.lastViewedAt) {
    return true;
  }

  // Compare timestamps: unread if assistant message is newer than last view
  return new Date(worktree.lastAssistantMessageAt) > new Date(worktree.lastViewedAt);
}

/**
 * Convert Worktree to SidebarBranchItem for display
 *
 * @param worktree - Source worktree data
 * @returns SidebarBranchItem for sidebar display
 */
export function toBranchItem(worktree: Worktree): SidebarBranchItem {
  const status = determineBranchStatus(worktree);

  // Use new hasUnread logic based on lastAssistantMessageAt and lastViewedAt
  const hasUnread = calculateHasUnread(worktree);

  return {
    id: worktree.id,
    name: worktree.name,
    repositoryName: worktree.repositoryName,
    status,
    hasUnread,
    lastActivity: worktree.updatedAt,
    description: worktree.description,
  };
}
