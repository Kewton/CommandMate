/**
 * Sidebar Type Definitions
 *
 * Types for sidebar components and branch status display
 */

import type { Worktree } from '@/types/models';
import {
  getCliToolDisplayName,
  getCliToolDisplayNameSafe,
  getInstanceLabel,
  agentInstancesFromSelectedAgents,
  CLI_TOOL_IDS,
  type AgentInstance,
} from '@/lib/cli-tools/types';
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
 * @param cliStatus - Per-instance status map (e.g. from `SidebarBranchItem`),
 *   keyed by agent-instance id (Issue #878)
 * @returns The single most significant status to display
 */
export function aggregateCliStatus(
  cliStatus?: Partial<Record<string, BranchStatus>>
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
 * Format a per-instance status breakdown for tooltips / aria-labels
 * (Issue #867, per-instance keys since #878), e.g.
 * "Claude: running, Claude 2: idle". Lets the single aggregated icon still
 * expose each instance's individual status on hover/focus.
 *
 * @param cliStatus - Per-instance status map, keyed by agent-instance id
 * @param labels - Optional instance-id → display-label map (Issue #878). When a
 *   key is absent, falls back to the CLI tool display name for that id.
 * @returns Comma-separated "Label: status" string ('' when empty/absent)
 */
export function formatCliStatusBreakdown(
  cliStatus?: Partial<Record<string, BranchStatus>>,
  labels?: Record<string, string>
): string {
  if (!cliStatus) return '';
  return Object.entries(cliStatus)
    .map(
      ([instanceId, status]) =>
        `${labels?.[instanceId] ?? getCliToolDisplayNameSafe(instanceId, instanceId)}: ${status ?? 'idle'}`
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
  /** Per-instance status for sidebar display, keyed by agent-instance id (Issue #878) */
  cliStatus?: Partial<Record<string, BranchStatus>>;
  /** Instance-id → display-label map for the status breakdown tooltip (Issue #878) */
  cliStatusLabels?: Record<string, string>;
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
 * Resolve a human-readable label for an agent-instance id that is NOT part of
 * the configured roster (Issue #878) — e.g. an alias instance (`claude-2`) that
 * is running but was not persisted to `agentInstances`. Primary instance ids are
 * valid CLI tool ids; alias ids carry a `{cliTool}-{suffix}` shape, so we
 * recover the backing tool from the prefix and append the suffix.
 */
function labelForUnknownInstance(instanceId: string): string {
  const cliTool = CLI_TOOL_IDS.find((id) => instanceId.startsWith(`${id}-`));
  if (cliTool) {
    const suffix = instanceId.slice(cliTool.length + 1);
    return `${getCliToolDisplayName(cliTool)} ${suffix}`;
  }
  return getCliToolDisplayNameSafe(instanceId, instanceId);
}

/**
 * Derive the sidebar's per-instance status map (Issue #878).
 *
 * The aggregated sidebar icon must reflect ANY running agent instance — even
 * ones absent from `selectedAgents` (e.g. an ad-hoc `claude` session) or alias
 * instances (`claude-2`). We therefore key the map by INSTANCE ID and read each
 * status from `sessionStatusByInstance` (the un-aggregated, per-instance source
 * from #875), unioning:
 *   1. the configured roster (`agentInstances`, or one primary per
 *      `selectedAgents` for legacy worktrees) so the breakdown stays stable; and
 *   2. any instance currently running but absent from that roster.
 *
 * Falls back to the legacy `selectedAgents` + `sessionStatusByCli` path when
 * `sessionStatusByInstance` is absent (older API payloads / unit fixtures), so
 * existing behaviour is preserved byte-for-byte.
 */
function deriveSidebarCliStatus(worktree: Worktree): {
  cliStatus: Partial<Record<string, BranchStatus>>;
  cliStatusLabels: Record<string, string>;
} {
  const cliStatus: Partial<Record<string, BranchStatus>> = {};
  const cliStatusLabels: Record<string, string> = {};

  const byInstance = worktree.sessionStatusByInstance;

  // Legacy fallback: no per-instance data → key by selectedAgents / CLI tool.
  if (!byInstance) {
    const agents = worktree.selectedAgents ?? DEFAULT_SELECTED_AGENTS;
    for (const agent of agents) {
      cliStatus[agent] = deriveCliStatus(worktree.sessionStatusByCli?.[agent]);
      cliStatusLabels[agent] = getCliToolDisplayName(agent);
    }
    return { cliStatus, cliStatusLabels };
  }

  // Configured roster: explicit agentInstances, else primaries per selectedAgents.
  const roster: AgentInstance[] =
    worktree.agentInstances && worktree.agentInstances.length > 0
      ? worktree.agentInstances
      : agentInstancesFromSelectedAgents(worktree.selectedAgents ?? DEFAULT_SELECTED_AGENTS);

  const rosterIds = new Set<string>();
  for (const instance of roster) {
    rosterIds.add(instance.id);
    cliStatus[instance.id] = deriveCliStatus(byInstance[instance.id]);
    cliStatusLabels[instance.id] = getInstanceLabel(instance);
  }

  // Surface any RUNNING instance missing from the roster (e.g. a `claude`
  // session started even though claude is not in selectedAgents) so the
  // aggregated icon reflects it.
  for (const [instanceId, status] of Object.entries(byInstance)) {
    if (rosterIds.has(instanceId)) continue;
    const derived = deriveCliStatus(status);
    if (derived === 'idle') continue;
    cliStatus[instanceId] = derived;
    cliStatusLabels[instanceId] = labelForUnknownInstance(instanceId);
  }

  return { cliStatus, cliStatusLabels };
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

  // Issue #878: aggregate per-instance status (from sessionStatusByInstance /
  // agentInstances) so instances outside selectedAgents and alias instances are
  // reflected. Falls back to the legacy selectedAgents path when no per-instance
  // data is present.
  const { cliStatus, cliStatusLabels } = deriveSidebarCliStatus(worktree);

  return {
    id: worktree.id,
    name: worktree.name,
    repositoryName: worktree.repositoryDisplayName ?? worktree.repositoryName,
    status,
    hasUnread,
    lastActivity: worktree.updatedAt,
    description: worktree.description,
    cliStatus,
    cliStatusLabels,
    worktreePath: worktree.path,
  };
}
