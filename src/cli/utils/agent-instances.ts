/**
 * Agent-instance roster helpers (Issue #1000).
 *
 * Shared by the `instances` command (add/remove/alias/kill/list) and the
 * `send --instance ... --register` option. All roster mutations go through
 * PATCH /api/worktrees/[id] (`agentInstances`), the same endpoint the
 * AgentInstancesPane UI uses, so CLI-created instances show up in the UI and
 * vice versa.
 *
 * Uses a RELATIVE path (not `@/`) to import server-side constants: CLI builds
 * via tsconfig.cli.json set `"paths": {}`. Mirrors the existing pattern in
 * ../config/cli-tool-ids.ts.
 */

import { assertResponseShape, type ApiClient } from './api-client';
import type { AgentInstance, WorktreeDetailResponse } from '../types/api-responses';
import { MAX_AGENT_INSTANCES, MAX_AGENT_ALIAS_LENGTH, getCliToolDisplayName, type CLIToolType } from '../../lib/cli-tools/types';
import { MIN_AGENT_INSTANCES } from '../../lib/agent-instances-validator';

export { MAX_AGENT_INSTANCES, MAX_AGENT_ALIAS_LENGTH, MIN_AGENT_INSTANCES };

/**
 * Fetch the current agent-instance roster for a worktree.
 */
export async function fetchAgentInstances(client: ApiClient, worktreeId: string): Promise<AgentInstance[]> {
  const worktree = await client.get<WorktreeDetailResponse>(`/api/worktrees/${worktreeId}`);
  // Issue #1357: a current daemon always includes agentInstances (an empty array
  // when the worktree has no instances). Its absence means the running daemon
  // predates the roster API, so silently returning [] here would look to the user
  // like "no instances" and mask the real cause. Validate the field's presence so
  // a stale daemon surfaces as an actionable version-skew error instead.
  const validated = assertResponseShape<WorktreeDetailResponse>(
    worktree,
    ['agentInstances'],
    'GET /api/worktrees/:id (agent-instance roster)'
  );
  return validated.agentInstances;
}

/**
 * Persist a full roster replacement. `order` is re-normalized to array
 * position, matching AgentInstancesPane's persist() behavior.
 */
export async function saveAgentInstances(
  client: ApiClient,
  worktreeId: string,
  instances: AgentInstance[]
): Promise<void> {
  const normalized = instances.map((inst, order) => ({ ...inst, order }));
  await client.patch(`/api/worktrees/${worktreeId}`, { agentInstances: normalized });
}

/**
 * Generate a unique instance id for `cliTool`. Mirrors
 * AgentInstancesPane.tsx's nextInstanceId(): claims the primary id
 * (`id === cliTool`) when free, otherwise the smallest free `{cliTool}-{n}`
 * suffix (n >= 2).
 */
export function nextInstanceId(cliTool: string, existing: ReadonlyArray<{ id: string }>): string {
  const ids = new Set(existing.map((inst) => inst.id));
  if (!ids.has(cliTool)) return cliTool;
  let n = 2;
  while (ids.has(`${cliTool}-${n}`)) n++;
  return `${cliTool}-${n}`;
}

/**
 * Default alias for a freshly-added instance (tool display name, suffixed
 * for non-primary instances). Mirrors AgentInstancesPane.tsx's defaultAlias().
 *
 * @param cliTool - Caller must have already validated this via isCliToolId().
 */
export function defaultAlias(cliTool: string, id: string): string {
  const name = getCliToolDisplayName(cliTool as CLIToolType);
  if (id === cliTool) return name;
  const suffix = id.slice(cliTool.length + 1);
  return suffix ? `${name} ${suffix}` : name;
}
