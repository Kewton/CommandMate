/**
 * The role of every instance on the server, read at once for a list (Issue #4387).
 *
 * `/sessions` filters by role, so it needs each instance's role beside the list.
 * The per-worktree `GET /api/worktrees/:id/instances/roles` answers that one worktree
 * at a time and reads the user's settings files to compute fingerprints; a list has
 * no use for either. So this:
 *
 * - asks git about each root and each worktree once, for the whole server
 *   (`withSettledServerMemberships`), and not at all when no root holds a setting,
 *   since membership then cannot change any answer;
 * - reads the instance settings and the latest `launched` records in one statement
 *   each, and resolves an inheriting instance once per (tool, roots) it shares with
 *   others, through the same `resolveDefaultsForTool` a launch uses;
 * - never calls `loadComposition`: the list shows a role, not what it would inject.
 *
 * Which answer an instance gets follows `buildInstanceRoleSettings`: a `launched`
 * record counts when its generation is the process this server is running for the
 * instance (`currentGeneration`); otherwise the next start's role (`effectiveNext`).
 *
 * @module lib/agent-roles/role-by-instance
 */
import type Database from 'better-sqlite3';
import {
  getAllInstanceRoleStates,
  getAllLatestLaunchedRoles,
  hasAnyRepositoryRoleDefault,
  instanceRoleKey,
} from '@/lib/db/agent-roles-db';
import { getWorktrees } from '@/lib/db/worktree-db';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import type { InstanceRoleSummary, InstanceRoleSummaryMap, RoleResolution, StoredRoleState } from '@/types/agent-roles';
import {
  resolveDefaultsForTool,
  withSettledServerMemberships,
  type RoleRepositoryMembership,
  type RoleResolverDeps,
} from './resolve';

export interface RoleByInstanceDeps extends RoleResolverDeps {
  /**
   * The generation of the process this server started for the instance, or null when
   * it runs none. Omitted: none, so every instance reads as its setting.
   */
  currentGeneration?: (worktreeId: string, cliToolId: CLIToolType, instanceId: string) => string | null;
}

const NO_ROOTS: RoleRepositoryMembership = { members: [], undetermined: [] };

function fromResolution(resolution: RoleResolution): InstanceRoleSummary {
  if (resolution.kind === 'role') {
    return { kind: 'role', roleId: resolution.role.id, roleName: resolution.role.name, basis: 'setting' };
  }
  return { kind: resolution.kind };
}

function summarize(
  db: Database.Database,
  worktrees: readonly Worktree[],
  membershipOf: (worktreeId: string) => RoleRepositoryMembership,
  deps: RoleByInstanceDeps
): Map<string, InstanceRoleSummaryMap> {
  const stored = getAllInstanceRoleStates(db);
  const launched = getAllLatestLaunchedRoles(db);
  // Inheriting instances of one tool in worktrees of the same roots resolve alike.
  const inherited = new Map<string, InstanceRoleSummary>();

  const result = new Map<string, InstanceRoleSummaryMap>();
  for (const worktree of worktrees) {
    const membership = membershipOf(worktree.id);
    const roles: InstanceRoleSummaryMap = {};
    for (const instance of resolveAgentInstances(db, worktree.id, worktree.selectedAgents)) {
      const key = instanceRoleKey(worktree.id, instance.id);
      const generation = deps.currentGeneration?.(worktree.id, instance.cliTool, instance.id) ?? null;
      const record = launched.get(key);
      if (generation !== null && record !== undefined && record.sessionGeneration === generation) {
        roles[instance.id] =
          record.roleId === null
            ? { kind: 'none' }
            : { kind: 'role', roleId: record.roleId, roleName: record.roleName ?? '', basis: 'launched' };
        continue;
      }
      const state: StoredRoleState = stored.get(key) ?? { state: 'inherit' };
      if (state.state !== 'inherit') {
        roles[instance.id] = fromResolution(resolveDefaultsForTool(db, instance.cliTool, membership, state));
        continue;
      }
      const shared = JSON.stringify([
        instance.cliTool,
        membership.members.map((root) => root.id),
        membership.undetermined.map((root) => root.id),
      ]);
      let summary = inherited.get(shared);
      if (!summary) {
        summary = fromResolution(resolveDefaultsForTool(db, instance.cliTool, membership));
        inherited.set(shared, summary);
      }
      roles[instance.id] = summary;
    }
    result.set(worktree.id, roles);
  }
  return result;
}

/**
 * Worktree id → instance id → its role, for every worktree on the server.
 *
 * @throws Whatever the reads throw, and `MembershipUnsettledError` when the roots kept
 *   changing; a caller that shows a list catches it and shows the list without roles
 */
export async function buildRoleByInstance(
  db: Database.Database,
  deps: RoleByInstanceDeps = {}
): Promise<Map<string, InstanceRoleSummaryMap>> {
  if (!hasAnyRepositoryRoleDefault(db)) {
    // One synchronous stretch: no root setting now, so no membership can matter.
    return summarize(db, getWorktrees(db), () => NO_ROOTS, deps);
  }
  return withSettledServerMemberships(db, deps, (worktrees, membershipOf) => {
    // A root setting may have gone during the wait; with one or without, these answers hold.
    return summarize(db, worktrees, membershipOf, deps);
  });
}
