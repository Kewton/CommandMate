/**
 * Sidebar Type Definitions
 *
 * Types for sidebar components and branch status display
 */

import type { SessionWaitingDetail, Worktree } from '@/types/models';
import {
  getCliToolDisplayName,
  getCliToolDisplayNameSafe,
  getInstanceLabel,
  agentInstancesFromSelectedAgents,
  CLI_TOOL_IDS,
  type AgentInstance,
} from '@/lib/cli-tools/types';
import { getClientDefaultSelectedAgents } from '@/config/default-agents';
import { deriveCliStatus } from '@/lib/session/status-mapping';
import { getNextAction, type NextActionKey } from '@/lib/session/next-action-helper';
import type { SessionStatus } from '@/lib/detection/status-detector';

// Issue #1550: the status-vocabulary conversions now live in
// `@/lib/session/status-mapping`. Re-exported here so existing importers of
// `@/types/sidebar` keep working; that module holds the only definition.
export { deriveCliStatus };

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
 * What kind of wait a branch is in (Issue #1786 taxonomy, consumed by #1787).
 *
 * Declared structurally rather than imported from `@/lib/session/waiting-kind`
 * so that this module — which every sidebar client component pulls in — keeps
 * no edge, not even a type-only one, into the detector's module graph.
 */
export type BranchWaitingKind = 'prompt' | 'menu' | 'unclassified';

/**
 * The `sessionStatusReason` token that means "the pane is there, the agent is
 * not" (Issue #2070).
 *
 * Restated rather than imported from `@/lib/detection/status-reason` for the
 * same reason {@link BranchWaitingKind} is declared structurally: every sidebar
 * client component pulls this module in, and it must keep no edge — not even a
 * type-only one — into the detector's module graph.
 * `tests/unit/detection/tool-liveness-2070.test.ts` pins the two equal, so the
 * restatement cannot drift.
 */
export const EXITED_STATUS_REASON = 'exited';

/**
 * `BranchStatus` → `SessionStatus`, so the sidebar can reuse `getNextAction`
 * (Issue #1787) instead of growing a second next-action table.
 *
 * `generating` folds into `running`: `SessionStatus` has no fifth value, and the
 * next action is identical for both ("it is working, leave it alone").
 * `idle` maps to `null` — `getNextAction` distinguishes "no session" from
 * "session sitting idle" only through null, and both mean "start it".
 */
const BRANCH_STATUS_TO_SESSION_STATUS: Record<BranchStatus, SessionStatus | null> = {
  idle: null,
  ready: 'ready',
  running: 'running',
  generating: 'running',
  waiting: 'waiting',
};

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
 * @param exitedSuffix - Optional annotation for an instance whose session is
 *   still there and whose AGENT is not (Issue #2070). Returning a string
 *   appends it in parentheses — `Codex: idle (exited)` — and returning null
 *   leaves the row exactly as it was. A callback rather than a boolean map
 *   because the word is user-facing and therefore localized, and this module
 *   runs on the server where `t()` cannot be called (the same rule
 *   `NEXT_ACTION_KEYS` follows).
 * @returns Comma-separated "Label: status" string ('' when empty/absent)
 */
export function formatCliStatusBreakdown(
  cliStatus?: Partial<Record<string, BranchStatus>>,
  labels?: Record<string, string>,
  exitedSuffix?: (instanceId: string) => string | null
): string {
  if (!cliStatus) return '';
  return Object.entries(cliStatus)
    .map(([instanceId, status]) => {
      const label = labels?.[instanceId] ?? getCliToolDisplayNameSafe(instanceId, instanceId);
      const suffix = exitedSuffix?.(instanceId);
      return `${label}: ${status ?? 'idle'}${suffix ? ` (${suffix})` : ''}`;
    })
    .join(', ');
}

/**
 * The waiting taxonomy folded to one worktree (Issue #1787).
 *
 * Every field mirrors {@link SessionWaitingDetail}, which is optional on the
 * wire: a server that predates #1786 sends none of them. `waitingKind: null`
 * therefore means "waiting, but this payload cannot say what kind" as well as
 * "not waiting" — consumers must treat null as the STRONG emphasis fallback,
 * never as "nothing to see".
 */
export interface WorktreeWaitingDetail {
  /** Most actionable kind across all instances, or null when unknown/absent. */
  waitingKind: BranchWaitingKind | null;
  /** True when ANY instance reported `idle_prompt` (turn over, awaiting work). */
  awaitingInstruction: boolean;
}

/** Precedence for folding per-instance kinds: answerable-now wins (Issue #1786). */
const WAITING_KIND_PRECEDENCE: readonly BranchWaitingKind[] = [
  'prompt',
  'menu',
  'unclassified',
];

/**
 * Fold every instance's {@link SessionWaitingDetail} into one worktree-level
 * verdict (Issue #1787).
 *
 * Reads `sessionStatusByInstance` when present and falls back to
 * `sessionStatusByCli`, matching how `deriveSidebarCliStatus` picks its source
 * — the two must not disagree about which map is authoritative, or the dot and
 * its emphasis would come from different snapshots.
 *
 * The kind fold uses `prompt > menu > unclassified` (the same precedence the
 * server uses per CLI tool): with two agents waiting, the one the user can
 * answer from the app is the one worth shouting about.
 *
 * @param worktree - Source worktree data (any vintage of the payload)
 * @returns The folded waiting detail; `{ waitingKind: null, awaitingInstruction: false }`
 *   when nothing in the payload carries the #1786 fields
 */
export function deriveWorktreeWaitingDetail(worktree: Worktree): WorktreeWaitingDetail {
  const entries: SessionWaitingDetail[] = Object.values<SessionWaitingDetail | undefined>(
    worktree.sessionStatusByInstance ?? worktree.sessionStatusByCli ?? {}
  ).filter((entry) => entry !== undefined);

  let awaitingInstruction = false;
  const kinds = new Set<BranchWaitingKind>();
  for (const entry of entries) {
    if (entry.awaitingInstruction) awaitingInstruction = true;
    if (entry.waitingKind) kinds.add(entry.waitingKind);
  }

  const waitingKind = WAITING_KIND_PRECEDENCE.find((kind) => kinds.has(kind)) ?? null;
  return { waitingKind, awaitingInstruction };
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
  /**
   * Kind of the aggregated wait, or null/absent when unknown (Issue #1787).
   * Drives the StatusDot emphasis tier; null means the strong tier.
   */
  waitingKind?: BranchWaitingKind | null;
  /**
   * An agent said its turn is over and it is awaiting the next instruction
   * (Issue #1786's `idle_prompt`). Rendered as a green "ready for work" badge —
   * deliberately NOT amber, because "nothing is blocking" and "you are blocking
   * it" must never look alike.
   */
  awaitingInstruction?: boolean;
  /**
   * Dictionary key for what the user should do next (Issue #1787), from
   * `getNextAction`. Resolved with `useTranslations('worktree')` at render.
   */
  nextActionKey?: NextActionKey;
  /**
   * Agent-instance ids whose tmux session is still there and whose AGENT is
   * gone (Issue #2070).
   *
   * The instance's `cliStatus` entry stays `idle` — that IS its status, and a
   * sixth `BranchStatus` would ripple into the colours, the sort order and the
   * dot's emphasis tiers for a distinction that is not about how urgent the row
   * is. What the id buys is the sentence in the breakdown tooltip: `Codex: idle
   * (exited)` tells the operator that something died under them, which plain
   * `idle` — the same word a worktree nobody ever started shows — cannot.
   *
   * Empty for every payload that predates the server change, so a stale client
   * annotates nothing and renders exactly what it rendered before.
   */
  exitedInstanceIds?: string[];
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
  exitedInstanceIds: string[];
} {
  const cliStatus: Partial<Record<string, BranchStatus>> = {};
  const cliStatusLabels: Record<string, string> = {};
  const exitedInstanceIds: string[] = [];

  const byInstance = worktree.sessionStatusByInstance;

  // Legacy fallback: no per-instance data → key by selectedAgents / CLI tool.
  if (!byInstance) {
    const agents = worktree.selectedAgents ?? getClientDefaultSelectedAgents();
    for (const agent of agents) {
      cliStatus[agent] = deriveCliStatus(worktree.sessionStatusByCli?.[agent]);
      cliStatusLabels[agent] = getCliToolDisplayName(agent);
      if (worktree.sessionStatusByCli?.[agent]?.sessionStatusReason === EXITED_STATUS_REASON) {
        exitedInstanceIds.push(agent);
      }
    }
    return { cliStatus, cliStatusLabels, exitedInstanceIds };
  }

  // Configured roster: explicit agentInstances, else primaries per selectedAgents.
  const roster: AgentInstance[] =
    worktree.agentInstances && worktree.agentInstances.length > 0
      ? worktree.agentInstances
      : agentInstancesFromSelectedAgents(
          worktree.selectedAgents ?? getClientDefaultSelectedAgents(),
        );

  const rosterIds = new Set<string>();
  for (const instance of roster) {
    rosterIds.add(instance.id);
    cliStatus[instance.id] = deriveCliStatus(byInstance[instance.id]);
    cliStatusLabels[instance.id] = getInstanceLabel(instance);
    if (byInstance[instance.id]?.sessionStatusReason === EXITED_STATUS_REASON) {
      exitedInstanceIds.push(instance.id);
    }
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

  return { cliStatus, cliStatusLabels, exitedInstanceIds };
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
  const { cliStatus, cliStatusLabels, exitedInstanceIds } = deriveSidebarCliStatus(worktree);

  // Issue #1787: the row's emphasis and its "what do I do next" label both come
  // from the AGGREGATED status, matching the single dot the row renders.
  const aggregated = aggregateCliStatus(cliStatus);
  const { waitingKind, awaitingInstruction } = deriveWorktreeWaitingDetail(worktree);

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
    exitedInstanceIds,
    worktreePath: worktree.path,
    waitingKind,
    awaitingInstruction,
    // `promptType` mirrors what `/api/worktrees` does with the same data
    // (`isWaitingForResponse ? 'approval' : null`) rather than branching on
    // `waitingKind`: the card and the sidebar row show the same worktree, and
    // one saying "Approve / Reject" while the other says "Reply to prompt"
    // would be a bug the user cannot explain. `isStalled` is server-only
    // (`isWorktreeStalled` needs the detector's timers), so the sidebar never
    // claims "Check stalled".
    nextActionKey: getNextAction(
      BRANCH_STATUS_TO_SESSION_STATUS[aggregated],
      aggregated === 'waiting' ? 'approval' : null,
      false
    ),
  };
}
