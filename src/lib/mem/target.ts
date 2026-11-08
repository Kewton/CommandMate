/**
 * Which repository and branch a mem request is about, and its mode (Issue #4221,
 * design §4・§9). The one judgement: the CLI's routes, the #2427 note route and
 * later #4222〜#4226 read its answer and do not copy it.
 *
 * Two ways in (§9.2): from a worktree (its HEAD, observed in the same attempt as the
 * membership, §9.3), or a repository plus a named branch (no HEAD; reads only).
 * Either way the mode is that of the branch the request names.
 *
 * The caller's `build` runs in the synchronous stretch that settled the membership,
 * so a write in it never pairs an old membership with a newer mode (§5.3).
 *
 * @module lib/mem/target
 */

import type Database from 'better-sqlite3';
import {
  AgentRoleTargetNotFoundError,
  MembershipUnsettledError,
  withSettledObservedWorktreeMembership,
  withSettledRepositoryMembership,
  type RoleRepositoryMembership,
  type RoleResolverDeps,
} from '@/lib/agent-roles/resolve';
import type { Repository } from '@/lib/db/db-repository';
import { decideRootMode, type MemRootDecision } from '@/lib/db/mem-db';
import type { MemFeatures, MemMode, MemModeSource } from '@/types/mem';
import type { Worktree } from '@/types/models';
import type { WorktreeHeadObservation } from './git-observe';

export type MemTargetSpec =
  | { via: 'worktree'; worktreeId: string; branch?: string }
  | { via: 'repository'; repositoryId: string; branch: string };

export interface MemTargetDeps extends RoleResolverDeps {
  observe?: (worktreePath: string) => Promise<WorktreeHeadObservation>;
}

export interface MemTargetResolved {
  ok: true;
  via: 'worktree' | 'repository';
  worktree: Worktree | null;
  /** null with `detached`. */
  branch: string | null;
  detached: boolean;
  head: string | null;
  mode: MemMode;
  features: MemFeatures;
  source: MemModeSource;
  members: Repository[];
  /** Where a new item goes: the first member by path (§9.5). */
  storageRepositoryId: string;
  /** Every root judged to be this repository, disabled ones included (§9.5). */
  readRepositoryIds: string[];
}

export interface MemTargetFailure {
  ok: false;
  code: 'not_registered' | 'ambiguous' | 'branch_unresolved' | 'not_found';
  reason?: 'root-settings-differ' | 'membership-undetermined' | 'registration_changed';
  roots?: Array<{ repositoryId: string; name: string }>;
}

export type MemTarget = MemTargetResolved | MemTargetFailure;

const decisionKey = (decision: MemRootDecision): string => JSON.stringify([decision.mode, decision.features]);
const rootOf = (root: Repository) => ({ repositoryId: root.id, name: root.displayName || root.name });

/** The answer for a branch from a settled membership (§9.4). Synchronous. */
export function decideMemTarget(
  db: Database.Database,
  membership: RoleRepositoryMembership,
  branch: string | null,
  base: { via: 'worktree' | 'repository'; worktree: Worktree | null; detached: boolean; head: string | null }
): MemTarget {
  if (membership.members.length === 0) return { ok: false, code: 'not_registered' };
  const decisions = membership.members.map((root) => decideRootMode(db, root.id, branch));
  const first = decisions[0];
  if (decisions.some((decision) => decisionKey(decision) !== decisionKey(first))) {
    return { ok: false, code: 'ambiguous', reason: 'root-settings-differ', roots: membership.members.map(rootOf) };
  }
  const contesting = membership.undetermined.filter(
    (root) => decisionKey(decideRootMode(db, root.id, branch)) !== decisionKey(first)
  );
  if (contesting.length > 0) {
    return {
      ok: false,
      code: 'ambiguous',
      reason: 'membership-undetermined',
      roots: [...membership.members, ...contesting].map(rootOf),
    };
  }
  const candidates = membership.candidates && membership.candidates.length > 0 ? membership.candidates : membership.members;
  return {
    ok: true,
    ...base,
    branch,
    mode: first.mode,
    features: first.features,
    source: first.source,
    members: membership.members,
    storageRepositoryId: membership.members[0].id,
    readRepositoryIds: candidates.map((root) => root.id),
  };
}

async function defaultObserve(path: string): Promise<WorktreeHeadObservation> {
  return (await import('./git-observe')).observeWorktreeHead(path);
}

/**
 * Resolve the target and hand it to `build` in the same synchronous stretch.
 * A failure (unknown, unregistered, ambiguous, unsettled) reaches `build` too, so
 * the caller answers every outcome in one place.
 */
export async function withMemTarget<R>(
  db: Database.Database,
  spec: MemTargetSpec,
  deps: MemTargetDeps,
  build: (target: MemTarget) => R
): Promise<R> {
  try {
    if (spec.via === 'repository') {
      return await withSettledRepositoryMembership(db, spec.repositoryId, deps, (_repository, membership) =>
        build(decideMemTarget(db, membership, spec.branch, { via: 'repository', worktree: null, detached: false, head: null }))
      );
    }
    const observe = deps.observe ?? defaultObserve;
    return await withSettledObservedWorktreeMembership(
      db,
      spec.worktreeId,
      deps,
      {
        observe: (worktree) => observe(worktree.path),
        // 2nd review 4: the observed git must be the git the membership was judged by.
        agrees: (observed, membership) =>
          !observed.known || observed.commonDir === null || membership.identity === undefined || membership.identity === null
            ? true
            : observed.commonDir === membership.identity,
      },
      (worktree, membership, observed) => {
        if (spec.branch !== undefined) {
          return build(decideMemTarget(db, membership, spec.branch, { via: 'worktree', worktree, detached: false, head: null }));
        }
        if (!observed.known) return build({ ok: false, code: 'branch_unresolved' });
        return build(
          decideMemTarget(db, membership, observed.detached ? null : observed.branch, {
            via: 'worktree',
            worktree,
            detached: observed.detached,
            head: observed.head,
          })
        );
      }
    );
  } catch (error) {
    if (error instanceof AgentRoleTargetNotFoundError) return build({ ok: false, code: 'not_found' });
    if (error instanceof MembershipUnsettledError) {
      return build({ ok: false, code: 'ambiguous', reason: 'registration_changed' });
    }
    throw error;
  }
}
