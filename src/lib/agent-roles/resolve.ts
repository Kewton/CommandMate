/**
 * Which role applies: instance → repository → system → none (Epic #4112).
 *
 * The one resolver. The CLI and the screen read its answer through the routes and
 * do not copy it. It imports the database by type only; the handle comes from the
 * caller, so nothing here puts `better-sqlite3` into a launcher's import graph.
 *
 * ## Which registered roots a worktree belongs to
 *
 * `worktrees.repository_path` is whichever root scanned last, so with two roots
 * registered for one repository it flips run to run (`git/git-common-dir.ts`).
 * Using it as the answer would change the role with the scan order. So:
 *
 * - A root belongs to a worktree when `repository_path` names it (the only use of
 *   that column), or when `git rev-parse --git-common-dir` says it is the same
 *   repository as the worktree.
 * - If any of those roots is enabled, only the enabled ones count, as in
 *   `duplicateOf` of `GET /api/repositories`: disabling one of a pair is how an
 *   operator resolves it. With none enabled they all still count, so disabling a
 *   lone root changes nothing about what its worktrees resolve to.
 * - All roots agree for the tool: that is the answer. Otherwise it is "ambiguous",
 *   which #4115 turns into not sending, and never a silent pick. A root without a
 *   row holds "inherit", and that disagrees with a root holding a role.
 *
 * ## When git cannot answer
 *
 * `resolveGitCommonDir` answers null for a git that failed or timed out (1 second)
 * as well as for a path that is not a repository. Treating null as "another
 * repository" would let a slow git change the result, so a root that exists on
 * disk, is enabled and cannot be identified counts against the answer if its
 * setting differs: reason `membership-undetermined`. A root whose directory is gone
 * cannot be scanned and a disabled one is not scanned, so neither blocks anything.
 *
 * ## Targets
 *
 * Which tool an instance is comes from `resolveSessionTarget`, the session
 * authority. An ad-hoc id (`send --agent codex --instance codex-3`) has no row and
 * resolves from the defaults of that tool. A contradicted request resolves by the
 * declaration here; refusing it is the job of the route with the side effect.
 *
 * @module lib/agent-roles/resolve
 */
import { existsSync } from 'fs';
import type Database from 'better-sqlite3';
import { getAgentRole, getInstanceRoleState, getRepositoryRoleStates, getSystemRoleDefaults } from '@/lib/db/agent-roles-db';
import { getAllRepositories, getRepositoryById, type Repository } from '@/lib/db/db-repository';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { resolveGitCommonDir } from '@/lib/git/git-common-dir';
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  isAgentRoleCliTool,
  type EffectiveRole,
  type ResolvedRole,
  type RoleAmbiguousRoot,
  type RoleResolution,
  type StoredRoleState,
} from '@/types/agent-roles';

/** A worktree or repository that does not exist. Not the same thing as having no role. */
export class AgentRoleTargetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRoleTargetNotFoundError';
  }
}

export interface RoleResolverDeps {
  resolveCommonDir?: (path: string) => Promise<string | null>;
  pathExists?: (path: string) => boolean;
}

/** The roots behind one worktree or root, ready to be asked about any tool. */
export interface RoleRepositoryMembership {
  /** Sorted by path, so the first does not depend on the scan order. */
  members: Repository[];
  /** Enabled, on disk, and could not be identified: may or may not be members. */
  undetermined: Repository[];
}

const NO_MEMBERSHIP: RoleRepositoryMembership = { members: [], undetermined: [] };

function byPath(a: Repository, b: Repository): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

async function resolveMembership(
  db: Database.Database,
  namedRootPath: string | null,
  identityPaths: readonly string[],
  deps: RoleResolverDeps
): Promise<RoleRepositoryMembership> {
  const roots = getAllRepositories(db);
  if (roots.length === 0) return NO_MEMBERSHIP;

  const resolveCommonDir = deps.resolveCommonDir ?? resolveGitCommonDir;
  const pathExists = deps.pathExists ?? existsSync;

  let identity: string | null = null;
  for (const path of identityPaths) {
    identity = await resolveCommonDir(path);
    if (identity !== null) break;
  }

  const commonDirs = await Promise.all(roots.map((root) => resolveCommonDir(root.path)));

  const candidates: Repository[] = [];
  const undetermined: Repository[] = [];
  roots.forEach((root, index) => {
    const commonDir = commonDirs[index];
    if (root.path === namedRootPath || (identity !== null && commonDir === identity)) {
      candidates.push(root);
    } else if ((identity === null || commonDir === null) && root.enabled && pathExists(root.path)) {
      undetermined.push(root);
    }
  });

  const enabled = candidates.filter((root) => root.enabled);
  const members = enabled.length > 0 ? enabled : candidates;
  return { members: [...members].sort(byPath), undetermined: undetermined.sort(byPath) };
}

/** The roots a worktree belongs to. Reads only; never registers anything. */
export async function resolveWorktreeMembership(
  db: Database.Database,
  worktree: { path: string; repositoryPath: string },
  deps: RoleResolverDeps = {}
): Promise<RoleRepositoryMembership> {
  const named = worktree.repositoryPath || null;
  return resolveMembership(db, named, named ? [worktree.path, named] : [worktree.path], deps);
}

/** The roots that are the same repository as this one. */
export async function resolveRepositoryMembership(
  db: Database.Database,
  repository: Repository,
  deps: RoleResolverDeps = {}
): Promise<RoleRepositoryMembership> {
  return resolveMembership(db, repository.path, [repository.path], deps);
}

function freezeRole(db: Database.Database, roleId: string): ResolvedRole {
  // Both reads happen before the caller gets control back, on one connection, and
  // the foreign key refuses a delete under a reference.
  const role = getAgentRole(db, roleId);
  if (!role) throw new AgentRoleTargetNotFoundError(`Role not found: ${roleId}`);
  return Object.freeze({
    id: role.id,
    name: role.name,
    bodyVersion: role.bodyVersion,
    body: role.body,
    bodyFingerprint: role.bodyFingerprint,
  });
}

function sameState(a: StoredRoleState, b: StoredRoleState): boolean {
  if (a.state !== b.state) return false;
  return a.state !== 'role' || a.roleId === (b as { roleId: string }).roleId;
}

function stateOf(db: Database.Database, root: Repository, cliToolId: string): StoredRoleState {
  return getRepositoryRoleStates(db, root.id)[cliToolId] ?? { state: 'inherit' };
}

function toAmbiguousRoot(db: Database.Database, root: Repository, cliToolId: string): RoleAmbiguousRoot {
  return { repositoryId: root.id, path: root.path, state: stateOf(db, root, cliToolId) };
}

/**
 * The levels below an instance. Exported so a caller holding one membership can
 * ask about several tools without running git again for each.
 */
export function resolveDefaultsForTool(
  db: Database.Database,
  cliToolId: CLIToolType,
  membership: RoleRepositoryMembership,
  instanceState: StoredRoleState = { state: 'inherit' }
): RoleResolution {
  const repositoryIds = membership.members.map((root) => root.id);
  const base = { cliToolId, repositoryId: repositoryIds[0] ?? null, repositoryIds };

  if (!isAgentRoleCliTool(cliToolId)) {
    return { ...base, kind: 'none', source: 'unsupported', reason: 'unsupported-tool' };
  }

  if (instanceState.state === 'role') {
    return { ...base, kind: 'role', source: 'instance', role: freezeRole(db, instanceState.roleId) };
  }
  if (instanceState.state === 'none') {
    return { ...base, kind: 'none', source: 'instance', reason: 'explicit-none' };
  }

  const memberStates = membership.members.map((root) => stateOf(db, root, cliToolId));
  const first = memberStates[0];
  if (first && memberStates.some((state) => !sameState(state, first))) {
    return {
      ...base,
      kind: 'ambiguous',
      source: 'repository',
      reason: 'root-settings-differ',
      roots: membership.members.map((root) => toAmbiguousRoot(db, root, cliToolId)),
    };
  }

  const agreed: StoredRoleState = first ?? { state: 'inherit' };
  const contesting = membership.undetermined.filter((root) => {
    const state = stateOf(db, root, cliToolId);
    // A root with no row for this tool holds no opinion that could be lost: if it
    // did turn out to be a member, a settings row is what would have to differ.
    return state.state !== 'inherit' && !sameState(state, agreed);
  });
  if (contesting.length > 0) {
    return {
      ...base,
      kind: 'ambiguous',
      source: 'repository',
      reason: 'membership-undetermined',
      roots: [...membership.members, ...contesting].map((root) => toAmbiguousRoot(db, root, cliToolId)),
    };
  }

  if (agreed.state === 'role') {
    return { ...base, kind: 'role', source: 'repository', role: freezeRole(db, agreed.roleId) };
  }
  if (agreed.state === 'none') {
    return { ...base, kind: 'none', source: 'repository', reason: 'explicit-none' };
  }

  const system = getSystemRoleDefaults(db)[cliToolId];
  if (system) return { ...base, kind: 'role', source: 'system', role: freezeRole(db, system.roleId) };
  return { ...base, kind: 'none', source: 'fallback', reason: 'no-default' };
}

export interface ResolveInstanceRoleInput {
  worktreeId: string;
  /** Omitted: the primary of the tool the session authority answers. */
  instanceId?: string;
  /** A tool named by the caller, for an ad-hoc instance the roster does not know. */
  requestedCliTool?: CLIToolType;
}

/**
 * The role of one instance. Call once per launch, and pass the `ResolvedRole` on
 * rather than asking again.
 *
 * @throws {AgentRoleTargetNotFoundError} The worktree does not exist
 */
export async function resolveInstanceRole(
  db: Database.Database,
  input: ResolveInstanceRoleInput,
  deps: RoleResolverDeps = {}
): Promise<RoleResolution> {
  const worktree = getWorktreeById(db, input.worktreeId);
  if (!worktree) throw new AgentRoleTargetNotFoundError(`Worktree not found: ${input.worktreeId}`);
  const target = resolveSessionTarget(db, input.worktreeId, {
    instanceId: input.instanceId,
    requestedCliTool: input.requestedCliTool,
  });
  const membership = await resolveWorktreeMembership(db, worktree, deps);
  return resolveDefaultsForTool(
    db,
    target.cliToolId,
    membership,
    getInstanceRoleState(db, input.worktreeId, target.instanceId)
  );
}

/**
 * The role from the defaults only, for what runs with no instance (Schedule).
 *
 * @throws {AgentRoleTargetNotFoundError} The worktree does not exist
 */
export async function resolveWorktreeToolRole(
  db: Database.Database,
  input: { worktreeId: string; cliToolId: CLIToolType },
  deps: RoleResolverDeps = {}
): Promise<RoleResolution> {
  const worktree = getWorktreeById(db, input.worktreeId);
  if (!worktree) throw new AgentRoleTargetNotFoundError(`Worktree not found: ${input.worktreeId}`);
  return resolveDefaultsForTool(db, input.cliToolId, await resolveWorktreeMembership(db, worktree, deps));
}

/**
 * The role a worktree of this root would get from the defaults.
 *
 * @throws {AgentRoleTargetNotFoundError} The repository does not exist
 */
export async function resolveRepositoryToolRole(
  db: Database.Database,
  input: { repositoryId: string; cliToolId: CLIToolType },
  deps: RoleResolverDeps = {}
): Promise<RoleResolution> {
  const repository = getRepositoryById(db, input.repositoryId);
  if (!repository) throw new AgentRoleTargetNotFoundError(`Repository not found: ${input.repositoryId}`);
  const resolution = resolveDefaultsForTool(
    db,
    input.cliToolId,
    await resolveRepositoryMembership(db, repository, deps)
  );
  return attributeToRepository(resolution, repository.id);
}

/** From a root's own screen, the answer speaks for that root when it is a member. */
export function attributeToRepository(resolution: RoleResolution, repositoryId: string): RoleResolution {
  return resolution.repositoryIds.includes(repositoryId) ? { ...resolution, repositoryId } : resolution;
}

/** Leave the body out, for an API response. */
export function toEffectiveRole(resolution: RoleResolution): EffectiveRole {
  if (resolution.kind !== 'role') return resolution;
  const { role, ...rest } = resolution;
  return {
    ...rest,
    role: {
      id: role.id,
      name: role.name,
      bodyVersion: role.bodyVersion,
      bodyFingerprint: role.bodyFingerprint,
    },
  };
}
