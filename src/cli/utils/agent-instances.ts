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

import { RoleExitCode } from '../types';
import { ApiError, assertResponseShape, type ApiClient } from './api-client';
import { ROSTER_CHANGED_ERROR_CODE } from './api-client-errors';
import { RoleCliError } from './role-failure';
import type { AgentInstance, WorktreeDetailResponse } from '../types/api-responses';
import { MAX_AGENT_INSTANCES, MAX_AGENT_ALIAS_LENGTH, getCliToolDisplayName, type CLIToolType } from '../../lib/cli-tools/types';
import { MIN_AGENT_INSTANCES } from '../../lib/agent-instances-validator';

export { MAX_AGENT_INSTANCES, MAX_AGENT_ALIAS_LENGTH, MIN_AGENT_INSTANCES };

/**
 * Fetch the current agent-instance roster for a worktree.
 */
export async function fetchAgentInstances(client: ApiClient, worktreeId: string): Promise<AgentInstance[]> {
  return (await fetchAgentRoster(client, worktreeId)).instances;
}

/** A roster, and the revision it was read at. An older server gives none. */
export interface AgentRosterSnapshot {
  instances: AgentInstance[];
  revision?: string;
}

/**
 * Fetch the roster with its revision, for a write that replaces it (Issue #4132).
 */
export async function fetchAgentRoster(client: ApiClient, worktreeId: string): Promise<AgentRosterSnapshot> {
  const worktree = await client.get<WorktreeDetailResponse & { rosterRevision?: unknown }>(`/api/worktrees/${worktreeId}`);
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
  const revision = worktree.rosterRevision;
  return {
    instances: validated.agentInstances,
    ...(typeof revision === 'string' ? { revision } : {}),
  };
}

/**
 * Persist a full roster replacement. `order` is re-normalized to array
 * position, matching AgentInstancesPane's persist() behavior.
 *
 * @param expectedRosterRevision - When given, the server refuses a roster that has moved
 *   on (Issue #4132). Omitted, whatever is there is replaced.
 */
export async function saveAgentInstances(
  client: ApiClient,
  worktreeId: string,
  instances: AgentInstance[],
  expectedRosterRevision?: string
): Promise<void> {
  const normalized = instances.map((inst, order) => ({ ...inst, order }));
  await client.patch(`/api/worktrees/${worktreeId}`, {
    agentInstances: normalized,
    ...(expectedRosterRevision !== undefined ? { expectedRosterRevision } : {}),
  });
}

/** How many times a change is built again on a fresh roster before the refusal is reported. */
const MAX_ROSTER_CHANGE_RETRIES = 2;

/**
 * Save a change to the roster, as long as it is the roster the change was built on
 * (Issue #4132). The write replaces the whole list, so an add made elsewhere since the
 * read would be erased. A server that has moved on answers 409, and `build` runs again
 * on what is really there, so it decides again as well (an id is taken, a row has gone).
 *
 * @param first - The roster already read, which the first attempt builds on
 * @param build - The next roster, or null when there is nothing left to do
 * @returns What was saved, or null when `build` said there was nothing to do
 * @throws {RoleCliError} `roster_changed` (exit 31): the roster kept moving through every
 *   attempt, so nothing was saved to it (Issue #4149). What the command did before the save
 *   stands: `remove --kill` has stopped the session. `send --register` has sent the message,
 *   and turns this into a warning for that reason.
 * @throws {ApiError} The server refused for another reason
 */
export async function saveRosterChange(
  client: ApiClient,
  worktreeId: string,
  first: AgentRosterSnapshot,
  build: (base: AgentInstance[]) => AgentInstance[] | null
): Promise<AgentInstance[] | null> {
  let snapshot = first;
  for (let attempt = 0; ; attempt += 1) {
    const next = build(snapshot.instances);
    if (next === null) return null;
    try {
      await saveAgentInstances(client, worktreeId, next, snapshot.revision);
      return next;
    } catch (error) {
      if (!(error instanceof ApiError) || error.apiCode !== ROSTER_CHANGED_ERROR_CODE) throw error;
      if (attempt >= MAX_ROSTER_CHANGE_RETRIES) {
        throw new RoleCliError(
          'roster_changed',
          `The roster kept changing while this command was saving (${attempt + 1} attempts, each on a fresh read), ` +
            'so nothing was saved to it. Something else is still changing it. Run the command again once that has finished.',
          RoleExitCode.CONFLICT,
          {},
          error.statusCode,
          error.payload
        );
      }
    }
    snapshot = await fetchAgentRoster(client, worktreeId);
  }
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
