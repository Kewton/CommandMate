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

/** Per-CLI tool status input shape */
interface CLIToolStatusInput {
  isRunning: boolean;
  isWaitingForResponse: boolean;
  isProcessing: boolean;
}

/**
 * Derive BranchStatus from per-CLI tool session status flags.
 * Shared by sidebar (toBranchItem) and WorktreeDetailRefactored tab dots.
 */
export function deriveCliStatus(
  toolStatus?: CLIToolStatusInput
): BranchStatus {
  if (!toolStatus) return 'idle';
  if (toolStatus.isWaitingForResponse) return 'waiting';
  if (toolStatus.isProcessing) return 'running';
  if (toolStatus.isRunning) return 'ready';
  return 'idle';
}

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
  /** Per-CLI tool status for sidebar display */
  cliStatus?: {
    claude: BranchStatus;
    codex: BranchStatus;
  };
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
  // Issue #4: Sidebar no longer shows per-CLI session status.
  // Status is always 'idle' since detailed status is shown in WorktreeDetail.
  const status: BranchStatus = 'idle';

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
    cliStatus: {
      claude: deriveCliStatus(worktree.sessionStatusByCli?.claude),
      codex: deriveCliStatus(worktree.sessionStatusByCli?.codex),
    },
  };
}
