/**
 * Sidebar Type Definitions
 *
 * Types for sidebar components and branch status display
 */

import type { Worktree } from '@/types/models';
import { getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';

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
 * Aggregate per-agent CLI statuses into a single representative BranchStatus
 * for the sidebar's single status indicator (Issue #867).
 *
 * Priority (highest first): waiting > running/generating > ready > idle.
 * The first matching tier wins, so any agent waiting for input dominates the
 * icon, then any active (running/generating) agent, then ready, then idle.
 * An empty or absent map yields 'idle'.
 *
 * NOTE: This priority is intentionally distinct from `STATUS_PRIORITY`
 * (sidebar-utils.ts) which orders the sidebar SORT. Sorting keeps
 * ready above running; the aggregated icon surfaces active work above ready.
 *
 * @param cliStatus - Per-CLI tool status map (e.g. from `SidebarBranchItem`)
 * @returns The single most significant status to display
 */
export function aggregateCliStatus(
  cliStatus?: Partial<Record<CLIToolType, BranchStatus>>
): BranchStatus {
  if (!cliStatus) return 'idle';
  const statuses = Object.values(cliStatus).filter(
    (s): s is BranchStatus => s !== undefined
  );
  if (statuses.length === 0) return 'idle';
  if (statuses.includes('waiting')) return 'waiting';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('generating')) return 'generating';
  if (statuses.includes('ready')) return 'ready';
  return 'idle';
}

/**
 * Format a per-agent status breakdown for tooltips / aria-labels (Issue #867),
 * e.g. "Claude: running, Codex: idle". Lets the single aggregated icon still
 * expose each agent's individual status on hover/focus.
 *
 * @param cliStatus - Per-CLI tool status map
 * @returns Comma-separated "DisplayName: status" string ('' when empty/absent)
 */
export function formatCliStatusBreakdown(
  cliStatus?: Partial<Record<CLIToolType, BranchStatus>>
): string {
  if (!cliStatus) return '';
  return Object.entries(cliStatus)
    .map(
      ([tool, status]) =>
        `${getCliToolDisplayName(tool as CLIToolType)}: ${status ?? 'idle'}`
    )
    .join(', ');
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
  cliStatus?: Partial<Record<CLIToolType, BranchStatus>>;
  /** Absolute path to the worktree directory (Issue #651) */
  worktreePath?: string;
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
  // Issue #608: Derive top-level status from worktree session flags
  const status = deriveCliStatus(
    worktree.isSessionRunning !== undefined
      ? {
          isRunning: worktree.isSessionRunning ?? false,
          isWaitingForResponse: worktree.isWaitingForResponse ?? false,
          isProcessing: worktree.isProcessing ?? false,
        }
      : undefined
  );

  // Use new hasUnread logic based on lastAssistantMessageAt and lastViewedAt
  const hasUnread = calculateHasUnread(worktree);

  // Issue #368: Use selectedAgents to determine which tools to show status for
  // Falls back to DEFAULT_SELECTED_AGENTS when selectedAgents is not set
  const agents = worktree.selectedAgents ?? DEFAULT_SELECTED_AGENTS;
  const cliStatus: Partial<Record<CLIToolType, BranchStatus>> = {};
  for (const agent of agents) {
    cliStatus[agent] = deriveCliStatus(worktree.sessionStatusByCli?.[agent]);
  }

  return {
    id: worktree.id,
    name: worktree.name,
    repositoryName: worktree.repositoryDisplayName ?? worktree.repositoryName,
    status,
    hasUnread,
    lastActivity: worktree.updatedAt,
    description: worktree.description,
    cliStatus,
    worktreePath: worktree.path,
  };
}
