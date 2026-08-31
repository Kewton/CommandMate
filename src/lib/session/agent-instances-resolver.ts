/**
 * Agent-instance roster resolver (Issue #869 / #878).
 *
 * Prefers the explicit `agent_instances` rows; when none exist (legacy
 * worktrees) derives one PRIMARY instance per `selectedAgents` so every API
 * surface returns a non-empty roster. Shared by the single worktree API
 * (`GET /api/worktrees/[id]`) and the list API (`GET /api/worktrees`) so both
 * expose the same roster to the client (Issue #878).
 *
 * Issue #2065 makes the derivation go through `resolveSelectedAgents()`, which
 * is what actually gives a newly discovered worktree the configured tab order:
 * `upsertWorktree` writes no `selected_agents` and scan/sync writes no
 * `agent_instances`, so a worktree found by a sync has NEITHER and lands
 * squarely on this fallback. Worktrees that already have rows are untouched —
 * the early return below is still the first thing that happens, and it is what
 * makes "a worktree with a roster never moves" true of #2066 as well.
 *
 * Issue #2066 (the repository layer) deliberately changed NOTHING here. Every
 * caller hands in `worktree.selectedAgents` from `getWorktreeById` /
 * `getWorktrees`, and those two are where `.commandmate/agents.yaml` enters —
 * including the rule that a worktree which already owns a roster is not offered
 * the declaration at all. Adding a `repositoryPath` argument here would have
 * been a second entry point that no production call site passes, so the layer
 * lives in exactly one place: `src/lib/db/worktree-db.ts`.
 */
import type Database from 'better-sqlite3';
import { getAgentInstances } from '@/lib/db';
import { getDefaultSelectedAgents } from '@/lib/db/app-settings-db';
import { resolveSelectedAgents } from '@/lib/selected-agents-validator';
import {
  agentInstancesFromSelectedAgents,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';

/**
 * Resolve the agent-instance roster for a worktree.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param selectedAgents - Worktree's selected agents, already resolved by
 *   `getWorktrees` / `getWorktreeById` (which is where the repository layer is
 *   applied); `undefined` when the caller has none to offer
 * @returns Stored instances when present, otherwise primaries derived from the
 *   first layer that answers: worktree -> app_settings -> constant
 */
export function resolveAgentInstances(
  db: Database.Database,
  worktreeId: string,
  selectedAgents: CLIToolType[] | undefined,
): AgentInstance[] {
  const stored = getAgentInstances(db, worktreeId);
  if (stored.length > 0) {
    return stored;
  }
  return agentInstancesFromSelectedAgents(
    resolveSelectedAgents({
      worktree: selectedAgents,
      appSettings: getDefaultSelectedAgents(db),
    }),
  );
}
