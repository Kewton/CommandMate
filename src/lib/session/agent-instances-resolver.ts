/**
 * Agent-instance roster resolver (Issue #869 / #878).
 *
 * Prefers the explicit `agent_instances` rows; when none exist (legacy
 * worktrees) derives one PRIMARY instance per `selectedAgents` so every API
 * surface returns a non-empty roster. Shared by the single worktree API
 * (`GET /api/worktrees/[id]`) and the list API (`GET /api/worktrees`) so both
 * expose the same roster to the client (Issue #878).
 */
import type Database from 'better-sqlite3';
import { getAgentInstances } from '@/lib/db';
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
 * @param selectedAgents - Worktree's selected agents (fallback source)
 * @returns Stored instances when present, otherwise primaries derived from
 *   `selectedAgents` (empty array when neither is available)
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
  return agentInstancesFromSelectedAgents(selectedAgents ?? []);
}
