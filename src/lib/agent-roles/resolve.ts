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
 * `probeGitCommonDir` tells a path that is not a repository from a git that failed
 * or timed out (1 second). Not a repository is an answer: such a root is the same
 * repository as nothing, so it is no candidate unless `repository_path` names it
 * (Issue #4134). A failure is not. Treating it as "another repository" would let a
 * slow git change the result, so a root that exists on
 * disk, is enabled and cannot be identified counts against the answer if its
 * setting differs, by the same comparison as a member: a root with no row holds
 * "inherit", which differs from a role. Reason `membership-undetermined`. So two
 * settings give the same kind of answer whether or not git answered. A root whose
 * directory is gone cannot be scanned and a disabled one is not scanned, so neither
 * blocks anything.
 *
 * ## Asking git takes time
 *
 * The answers from git arrive across an `await`, and anything can change meanwhile.
 * Everything else happens in one synchronous stretch after the last answer: check
 * that what was asked about still holds, and build the result, with {@link
 * withSettledWorktreeMembership} calling the builder itself. better-sqlite3 is
 * synchronous, so that stretch is one consistent view.
 *
 * The builder is a callback and not something the caller does with a returned
 * membership on purpose: returning from an `async` function yields to the event
 * loop, so anything read after that `await` can pair an old membership with a newer
 * setting, however close together the two lines look.
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
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { GitCommonDirProbe } from '@/lib/git/git-common-dir';
import type { Worktree } from '@/types/models';
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
  /** What git says about a path. Default: `probeGitCommonDir`. */
  probeCommonDir?: (path: string) => Promise<GitCommonDirProbe>;
  /** The common dir alone, where null means git failed. Wins over {@link probeCommonDir}. */
  resolveCommonDir?: (path: string) => Promise<string | null>;
  pathExists?: (path: string) => boolean;
}

/** The roots behind one worktree or root, ready to be asked about any tool. */
export interface RoleRepositoryMembership {
  /** Sorted by path, so the first does not depend on the scan order. */
  members: Repository[];
  /** Enabled, on disk, and could not be identified: may or may not be members. */
  undetermined: Repository[];
  /**
   * Every root judged to be this repository, disabled ones included, sorted by path
   * (Issue #4221: mem reads items across all of them, §9.5). Roles do not read it.
   */
  candidates?: Repository[];
  /** The common dir git gave for the worktree or root asked about; null when it gave none (Issue #4221). */
  identity?: string | null;
}

const NO_MEMBERSHIP: RoleRepositoryMembership = { members: [], undetermined: [], candidates: [], identity: null };

function byPath(a: Repository, b: Repository): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** What was asked of git, and what it said. */
interface MembershipQuestion {
  namedRootPath: string | null;
  identityPaths: readonly string[];
}

interface MembershipAnswers {
  roots: Repository[];
  identity: string | null;
  commonDirs: Array<string | null>;
  /** By the index of `roots`: git said this path is no repository. */
  notRepository: boolean[];
}

async function loadProbe(deps: RoleResolverDeps): Promise<(path: string) => Promise<GitCommonDirProbe>> {
  const { resolveCommonDir, probeCommonDir } = deps;
  if (resolveCommonDir) {
    return async (path) => {
      const commonDir = await resolveCommonDir(path);
      return commonDir === null ? { kind: 'failed' } : { kind: 'repository', commonDir };
    };
  }
  // Loaded here, on the way to git: every driver reaches this module, and suites
  // that mock `child_process` down to what a driver uses have no git to load.
  return probeCommonDir ?? (await import('@/lib/git/git-common-dir')).probeGitCommonDir;
}

const commonDirOf = (probe: GitCommonDirProbe): string | null =>
  probe.kind === 'repository' ? probe.commonDir : null;

/** The only part that waits. Decides nothing. */
async function askGit(
  db: Database.Database,
  question: MembershipQuestion,
  deps: RoleResolverDeps
): Promise<MembershipAnswers> {
  const roots = getAllRepositories(db);
  if (roots.length === 0) return { roots, identity: null, commonDirs: [], notRepository: [] };

  const probe = await loadProbe(deps);
  let identity: string | null = null;
  for (const path of question.identityPaths) {
    identity = commonDirOf(await probe(path));
    if (identity !== null) break;
  }
  const probes = await Promise.all(roots.map((root) => probe(root.path)));
  return {
    roots,
    identity,
    commonDirs: probes.map(commonDirOf),
    notRepository: probes.map((answer) => answer.kind === 'not-repository'),
  };
}

function membershipFrom(
  question: MembershipQuestion,
  { roots, identity, commonDirs, notRepository }: MembershipAnswers,
  deps: RoleResolverDeps
): RoleRepositoryMembership {
  if (roots.length === 0) return { ...NO_MEMBERSHIP, identity };
  const pathExists = deps.pathExists ?? existsSync;

  const candidates: Repository[] = [];
  const undetermined: Repository[] = [];
  roots.forEach((root, index) => {
    const commonDir = commonDirs[index];
    if (root.path === question.namedRootPath || (identity !== null && commonDir === identity)) {
      candidates.push(root);
    } else if (
      !notRepository[index] &&
      (identity === null || commonDir === null) &&
      root.enabled &&
      pathExists(root.path)
    ) {
      undetermined.push(root);
    }
  });

  const enabled = candidates.filter((root) => root.enabled);
  const members = enabled.length > 0 ? enabled : candidates;
  return {
    members: [...members].sort(byPath),
    undetermined: undetermined.sort(byPath),
    candidates: [...candidates].sort(byPath),
    identity,
  };
}

/** How many times to ask again when the answer went stale during the wait. */
const MAX_MEMBERSHIP_ATTEMPTS = 3;

function rootsSignature(db: Database.Database): string {
  return JSON.stringify(getAllRepositories(db).map((root) => [root.id, root.path, root.enabled]));
}

/** How a target of membership is read, and what its membership depends on. */
interface MembershipTarget<T> {
  /** The target as it is now. Throws when it is gone. */
  read: () => T;
  signature: (target: T) => string;
  question: (target: T) => MembershipQuestion;
}

/**
 * Something more to ask git about the target in the same attempt (Issue #4221 §9.3):
 * asked before and after the membership, and the attempt is stale unless both
 * answers are the same and `agrees` holds against the membership's own answers.
 */
export interface MembershipObservation<T, O> {
  observe: (target: T) => Promise<O>;
  /** Equality of two observations; JSON by default. */
  same?: (a: O, b: O) => boolean;
  /** Whether the observation and the membership speak of the same git (the common dir). */
  agrees?: (observation: O, membership: RoleRepositoryMembership) => boolean;
}

/**
 * The synchronous stretch: compare, then build. Nothing here may await, and that is
 * the whole of what makes the result one consistent view.
 *
 * @returns The built result, or `stale` to ask git again
 */
function finishAttempt<T, R>(
  db: Database.Database,
  spec: MembershipTarget<T>,
  asked: string,
  question: MembershipQuestion,
  answers: MembershipAnswers,
  deps: RoleResolverDeps,
  build: (target: T, membership: RoleRepositoryMembership) => R
): { stale: true } | { stale: false; value: R } {
  const current = spec.read();
  if (`${spec.signature(current)}|${rootsSignature(db)}` !== asked) return { stale: true };
  return { stale: false, value: build(current, membershipFrom(question, answers, deps)) };
}

/** Thrown when the registration (or an observation) never held still for one attempt. */
export class MembershipUnsettledError extends Error {
  constructor() {
    super('The repository registration kept changing while it was being read');
    this.name = 'MembershipUnsettledError';
  }
}

async function withSettledMembership<T, R, O = undefined>(
  db: Database.Database,
  spec: MembershipTarget<T>,
  deps: RoleResolverDeps,
  build: (target: T, membership: RoleRepositoryMembership, observation: O) => R,
  observation?: MembershipObservation<T, O>
): Promise<R> {
  const same = observation?.same ?? ((a: O, b: O) => JSON.stringify(a) === JSON.stringify(b));
  for (let attempt = 0; attempt < MAX_MEMBERSHIP_ATTEMPTS; attempt += 1) {
    const target = spec.read();
    const asked = `${spec.signature(target)}|${rootsSignature(db)}`;
    const question = spec.question(target);
    const before = observation ? await observation.observe(target) : (undefined as O);
    const answers = await askGit(db, question, deps);
    const after = observation ? await observation.observe(target) : (undefined as O);
    if (observation && !same(before, after)) continue;
    const outcome = finishAttempt(db, spec, asked, question, answers, deps, (current, membership) => {
      if (observation?.agrees && !observation.agrees(after, membership)) return STALE;
      return build(current, membership, after);
    });
    if (!outcome.stale && outcome.value !== STALE) return outcome.value as R;
  }
  throw new MembershipUnsettledError();
}

/** Returned by a build that found its observation disagreeing with the membership. */
const STALE: unique symbol = Symbol('stale');

/**
 * Build a result from a worktree, as it is now, and the roots it belongs to. Reads
 * only; never registers anything.
 *
 * @param build - Runs in the same synchronous stretch as the final check. Everything
 *   that goes with the membership (roster, tool, settings) is read here, and it must
 *   return plain data rather than a promise.
 * @throws {AgentRoleTargetNotFoundError} The worktree does not exist
 * @throws Error The registration never held still; better no answer than a stale one
 */
function worktreeTarget(db: Database.Database, worktreeId: string): MembershipTarget<Worktree> {
  return {
    read: () => {
      const worktree = getWorktreeById(db, worktreeId);
      if (!worktree) throw new AgentRoleTargetNotFoundError(`Worktree not found: ${worktreeId}`);
      return worktree;
    },
    signature: (worktree) => JSON.stringify([worktree.path, worktree.repositoryPath]),
    question: (worktree) => {
      const named = worktree.repositoryPath || null;
      return { namedRootPath: named, identityPaths: named ? [worktree.path, named] : [worktree.path] };
    },
  };
}

export function withSettledWorktreeMembership<R>(
  db: Database.Database,
  worktreeId: string,
  deps: RoleResolverDeps,
  build: (worktree: Worktree, membership: RoleRepositoryMembership) => R
): Promise<R> {
  return withSettledMembership(db, worktreeTarget(db, worktreeId), deps, build);
}

/**
 * {@link withSettledWorktreeMembership} with one more question asked of git in the
 * same attempt (Issue #4221 §9.3: the branch, HEAD and common dir of the worktree).
 * The build sees the observation taken after the membership, which equals the one
 * taken before it.
 *
 * @throws {MembershipUnsettledError} The worktree, the roots or the observation never held still
 */
export function withSettledObservedWorktreeMembership<R, O>(
  db: Database.Database,
  worktreeId: string,
  deps: RoleResolverDeps,
  observation: MembershipObservation<Worktree, O>,
  build: (worktree: Worktree, membership: RoleRepositoryMembership, observed: O) => R
): Promise<R> {
  return withSettledMembership(db, worktreeTarget(db, worktreeId), deps, build, observation);
}

/**
 * Build a result from a root, as it is now, and the roots of the same repository.
 * Same contract as {@link withSettledWorktreeMembership}.
 *
 * @throws {AgentRoleTargetNotFoundError} The repository does not exist
 */
export function withSettledRepositoryMembership<R>(
  db: Database.Database,
  repositoryId: string,
  deps: RoleResolverDeps,
  build: (repository: Repository, membership: RoleRepositoryMembership) => R
): Promise<R> {
  return withSettledMembership(
    db,
    {
      read: () => {
        const repository = getRepositoryById(db, repositoryId);
        if (!repository) throw new AgentRoleTargetNotFoundError(`Repository not found: ${repositoryId}`);
        return repository;
      },
      signature: (repository) => repository.path,
      question: (repository) => ({ namedRootPath: repository.path, identityPaths: [repository.path] }),
    },
    deps,
    build
  );
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
    return !sameState(stateOf(db, root, cliToolId), agreed);
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
  return withSettledWorktreeMembership(db, input.worktreeId, deps, (_worktree, membership) => {
    const target = resolveSessionTarget(db, input.worktreeId, {
      instanceId: input.instanceId,
      requestedCliTool: input.requestedCliTool,
    });
    return resolveDefaultsForTool(
      db,
      target.cliToolId,
      membership,
      getInstanceRoleState(db, input.worktreeId, target.instanceId)
    );
  });
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
  return withSettledWorktreeMembership(db, input.worktreeId, deps, (_worktree, membership) =>
    resolveDefaultsForTool(db, input.cliToolId, membership)
  );
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
  return withSettledRepositoryMembership(db, input.repositoryId, deps, (repository, membership) =>
    attributeToRepository(resolveDefaultsForTool(db, input.cliToolId, membership), repository.id)
  );
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
