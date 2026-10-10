/**
 * The destinations New task can send to, read off `GET /api/worktrees`
 * (Issue #3511).
 *
 * Pure functions: the dialog fetches the list once when it opens and derives
 * the repository → branch → agent choices, the agent's running state, its
 * armed Auto-Yes and whether a model can be named from that one payload.
 */

import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';
import type { AutoYesInstanceSummary } from '@/types/auto-yes';
import {
  agentInstancesFromSelectedAgents,
  getInstanceLabel,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import type { NewTaskTarget } from './recent-targets';

/** One repository and the branches under it. */
export interface NewTaskRepositoryOption {
  /** `repositoryPath` of its worktrees — the grouping key. */
  path: string;
  name: string;
  worktrees: Worktree[];
}

/**
 * Group the worktrees by repository, repositories and branches by name.
 * A repository's label prefers its display name from the payload's
 * `repositories` list.
 */
export function buildRepositoryOptions(
  worktrees: readonly Worktree[],
  repositories: readonly RepositorySummary[] = [],
): NewTaskRepositoryOption[] {
  const byPath = new Map<string, NewTaskRepositoryOption>();
  for (const worktree of worktrees) {
    let entry = byPath.get(worktree.repositoryPath);
    if (!entry) {
      const summary = repositories.find((repo) => repo.path === worktree.repositoryPath);
      entry = {
        path: worktree.repositoryPath,
        name: summary?.displayName || summary?.name || worktree.repositoryName,
        worktrees: [],
      };
      byPath.set(worktree.repositoryPath, entry);
    }
    entry.worktrees.push(worktree);
  }
  const options = Array.from(byPath.values());
  for (const option of options) {
    option.worktrees.sort((a, b) => a.name.localeCompare(b.name));
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A worktree's agent roster in display order. `GET /api/worktrees` resolves
 * `agentInstances` for every row; `selectedAgents` and the worktree's own tool
 * are the fallbacks for an older payload.
 */
export function resolveWorktreeInstances(worktree: Worktree): AgentInstance[] {
  if (worktree.agentInstances && worktree.agentInstances.length > 0) {
    return worktree.agentInstances.slice().sort((a, b) => a.order - b.order);
  }
  if (worktree.selectedAgents && worktree.selectedAgents.length > 0) {
    return agentInstancesFromSelectedAgents(worktree.selectedAgents);
  }
  return worktree.cliToolId ? agentInstancesFromSelectedAgents([worktree.cliToolId]) : [];
}

/** What the dialog needs to know about the chosen agent. */
export interface NewTaskTargetState {
  instance: AgentInstance;
  /** The alias, or the tool's display name. */
  label: string;
  /** A tmux session exists. */
  running: boolean;
  /** The session is still launching (Issue #3179). */
  starting: boolean;
  /** Armed Auto-Yes, or null when it is off. */
  autoYes: AutoYesInstanceSummary | null;
}

/** Look up a target in the list, or null when either half is gone. */
export function findTarget(
  worktrees: readonly Worktree[],
  target: NewTaskTarget,
): { worktree: Worktree; instance: AgentInstance } | null {
  const worktree = worktrees.find((wt) => wt.id === target.worktreeId);
  if (!worktree) return null;
  const instance = resolveWorktreeInstances(worktree).find((inst) => inst.id === target.instanceId);
  return instance ? { worktree, instance } : null;
}

/** The chosen agent's running state and Auto-Yes, from the list payload. */
export function describeTargetState(worktree: Worktree, instance: AgentInstance): NewTaskTargetState {
  // A primary instance (id === tool) may only be reported per CLI by an older payload.
  const status = worktree.sessionStatusByInstance?.[instance.id]
    ?? (instance.id === instance.cliTool ? worktree.sessionStatusByCli?.[instance.cliTool] : undefined);
  const startingSince = (status as { startingSince?: number } | undefined)?.startingSince;
  const autoYes = worktree.autoYesByInstance?.[instance.id];
  return {
    instance,
    label: getInstanceLabel(instance),
    running: status?.isRunning === true,
    starting: typeof startingSince === 'number',
    autoYes: autoYes?.enabled && typeof autoYes.expiresAt === 'number' ? autoYes : null,
  };
}

/**
 * Where the dialog starts: the first candidate that still exists. A candidate
 * whose worktree exists but whose instance is gone falls back to that
 * worktree's first agent; the last resort is the first agent of the first
 * branch.
 */
export function resolveInitialTarget(
  worktrees: readonly Worktree[],
  candidates: ReadonlyArray<NewTaskTarget | null | undefined>,
  repositories: readonly RepositorySummary[] = [],
): NewTaskTarget | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (findTarget(worktrees, candidate)) return candidate;
    const worktree = worktrees.find((wt) => wt.id === candidate.worktreeId);
    const first = worktree ? resolveWorktreeInstances(worktree)[0] : undefined;
    if (worktree && first) return { worktreeId: worktree.id, instanceId: first.id };
  }
  for (const repo of buildRepositoryOptions(worktrees, repositories)) {
    for (const worktree of repo.worktrees) {
      const first = resolveWorktreeInstances(worktree)[0];
      if (first) return { worktreeId: worktree.id, instanceId: first.id };
    }
  }
  return null;
}

/**
 * Whether a model can be named on this send, and why not.
 *
 * Mirrors `POST /api/worktrees/[id]/send`: only copilot, antigravity and claude
 * take `model`; copilot switches in-session (`/model`), while claude and
 * antigravity take it as a launch flag and answer 400 once a session is up.
 * A launching session already counts as up — `isRunning()` sees its tmux
 * session.
 */
export type ModelAvailability =
  | { selectable: true }
  | { selectable: false; reason: 'unsupported' | 'running' };

export function resolveModelAvailability(
  cliTool: CLIToolType,
  state: Pick<NewTaskTargetState, 'running' | 'starting'>,
): ModelAvailability {
  if (cliTool === 'copilot') return { selectable: true };
  if (cliTool === 'claude' || cliTool === 'antigravity') {
    return state.running || state.starting
      ? { selectable: false, reason: 'running' }
      : { selectable: true };
  }
  return { selectable: false, reason: 'unsupported' };
}

/**
 * Whether an armed Auto-Yes is still in force at `now` — the same test
 * `AutoYesToggle` applies (`expiresAt - Date.now() <= 0` is expired). The
 * server drops an expired state on its next read; the dialog must not keep
 * showing "00:00 left" as on until then.
 */
export function isAutoYesActive(
  autoYes: AutoYesInstanceSummary | null | undefined,
  now: number = Date.now(),
): autoYes is AutoYesInstanceSummary & { expiresAt: number } {
  return !!autoYes && autoYes.enabled && typeof autoYes.expiresAt === 'number' && autoYes.expiresAt - now > 0;
}
