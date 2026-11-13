/**
 * The counts of one branch's decisions, read from the store (Issue #4355, design §3.1.3・I6).
 * The reader PR2's branch select and #4354's waiting count call; `promoteList` (what
 * `commandmate mem decisions` reads) answers the same numbers through the same
 * {@link decisionCountsOf}. Reads only: nothing here writes the database, `gh` or a worktree.
 *
 * @module lib/promote/decision-summary
 */

import type Database from 'better-sqlite3';
import { listMem } from '@/lib/db/mem-db';
import { AgentRoleTargetNotFoundError, MembershipUnsettledError, withSettledRepositoryMembership } from '@/lib/agent-roles/resolve';
import { decideMemTarget } from '@/lib/mem/target';
import type { MemServiceDeps } from '@/lib/mem/service';
import { decisionCountsOf, type DecisionCounts } from './decision-counts';

/**
 * The counts of `branch`'s decisions in `repositoryId`'s roots, or null when the repository
 * is not there, has no member root, or its membership is not settled (nothing to count).
 */
export async function summarizeDecisionCounts(
  db: Database.Database,
  repositoryId: string,
  branch: string,
  deps: MemServiceDeps = {}
): Promise<DecisionCounts | null> {
  try {
    return await withSettledRepositoryMembership(db, repositoryId, deps, (_repository, membership): DecisionCounts | null => {
      const target = decideMemTarget(db, membership, branch, { via: 'repository', worktree: null, detached: false, head: null });
      if (!target.ok) return target.code === 'ambiguous' && membership.members.length > 0 ? decisionCountsOf('ambiguous', []) : null;
      const items = listMem(db, { storageRepositoryId: target.storageRepositoryId, readRepositoryIds: target.readRepositoryIds, branch, worktreeId: null }, { all: true }).items;
      return decisionCountsOf(target.mode, items);
    });
  } catch (error) {
    if (error instanceof AgentRoleTargetNotFoundError || error instanceof MembershipUnsettledError) return null;
    throw error;
  }
}
