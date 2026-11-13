/**
 * The branches the decision screen chooses from (Issue #4355, design
 * `docs/design/mem-decisions-ux-4355.md` §3.1.2・§4.1, PR2): `GET
 * /api/repositories/:id/mem/decisions/branches`. Read only — nothing here writes the
 * database, `gh` or a worktree, and no screen mark is asked.
 *
 * - The set of branches is the union of the repository's worktrees' branches, the
 *   branches that hold a decision not closed, and the branches that hold an unsettled
 *   operation whatever became of its item (closed or purged; the list route's
 *   `listUnresolvedPromoteOperations` set) — a worktree removed or an item closed does not
 *   hide what still waits for a person's reconcile.
 * - Each branch is counted with the one shared count (I6, `decisionCountsUnder` →
 *   `decisionCountsOf`): `ambiguous` answers null counts, never 0.
 * - `?item=<id>&branch=<name>` (§3.1.4): where that item is as seen from this repository and
 *   branch — `here`, `elsewhere` (another branch or repository; nothing of it is returned),
 *   or `gone` (closed, purged, or not a decision).
 *
 * @module lib/promote/decision-branches
 */

import type Database from 'better-sqlite3';
import { getMemRecord } from '@/lib/db/mem-db';
import { getWorktreeById, getWorktreesByRepository } from '@/lib/db/worktree-db';
import type { Repository } from '@/lib/db/db-repository';
import {
  AgentRoleTargetNotFoundError,
  MembershipUnsettledError,
  withSettledRepositoryMembership,
  type RoleRepositoryMembership,
} from '@/lib/agent-roles/resolve';
import type { MemOutcome, MemServiceDeps } from '@/lib/mem/service';
import type { DecisionBranchesBody, DecisionBranchView, DecisionItemWhere } from './decision-counts';
import { decisionCountsUnder } from './decision-summary';
import { promoteError } from './service';

export interface DecisionBranchesQuery {
  /** `?item=`: the item the screen was opened on. */
  item?: string | null;
  /** `?branch=`: the branch the screen shows (with `item`). */
  branch?: string | null;
}

/** Every root judged to be this repository (disabled ones included), as the list reads them. */
const rootsOf = (membership: RoleRepositoryMembership): Repository[] =>
  membership.candidates && membership.candidates.length > 0 ? membership.candidates : membership.members;

/** The branches of the repository's decisions that are not closed (a read of `mem_items` only). */
function decisionBranchesOf(db: Database.Database, repositoryIds: readonly string[]): string[] {
  if (repositoryIds.length === 0) return [];
  const marks = repositoryIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT branch FROM mem_items WHERE repository_id IN (${marks}) AND kind = 'decision' AND state != 'closed' AND branch IS NOT NULL`
    )
    .all(...repositoryIds) as Array<{ branch: string }>;
  return rows.map((row) => row.branch);
}

/**
 * The branches holding an unsettled operation (approved, in flight, unknown, or written with
 * the item's transition pending), whatever became of its item — the same set the list route
 * reads with `listUnresolvedPromoteOperations` (`src/lib/db/mem-promote-db.ts`). A read only.
 */
function unresolvedOperationBranchesOf(db: Database.Database, repositoryIds: readonly string[]): string[] {
  if (repositoryIds.length === 0) return [];
  const marks = repositoryIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT branch FROM mem_promote_operations
        WHERE repository_id IN (${marks}) AND branch IS NOT NULL
          AND (state IN ('approved','in_flight','unknown') OR (state = 'succeeded' AND transition_pending = 1))`
    )
    .all(...repositoryIds) as Array<{ branch: string }>;
  return rows.map((row) => row.branch);
}

/** The worktrees' branches of the member roots (detached worktrees have none). */
function worktreeBranchesOf(db: Database.Database, members: readonly Repository[]): string[] {
  return members.flatMap((root) =>
    getWorktreesByRepository(db, root.path)
      .map((entry) => getWorktreeById(db, entry.id)?.branch ?? null)
      .filter((branch): branch is string => typeof branch === 'string' && branch.length > 0)
  );
}

/** `on` first (a person can approve there), then by name; the order does not depend on the scan. */
function byApprovableThenName(a: DecisionBranchView, b: DecisionBranchView): number {
  if (a.approvable !== b.approvable) return a.approvable ? -1 : 1;
  return a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0;
}

function whereOf(db: Database.Database, roots: readonly Repository[], itemId: string, branch: string | null): DecisionItemWhere {
  const record = getMemRecord(db, itemId);
  if (!record || record.kind !== 'decision' || record.state === 'closed') return 'gone';
  if (!roots.some((root) => root.id === record.owner.repositoryId)) return 'elsewhere';
  return branch !== null && record.owner.branch === branch ? 'here' : 'elsewhere';
}

/** `GET /api/repositories/:id/mem/decisions/branches` — read only (design §4.1). */
export async function listDecisionBranches(
  db: Database.Database,
  repositoryId: string,
  query: DecisionBranchesQuery = {},
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  try {
    return await withSettledRepositoryMembership(db, repositoryId, deps, (_repository, membership): MemOutcome => {
      const roots = rootsOf(membership);
      const rootIds = roots.map((root) => root.id);
      const names = new Set<string>([
        ...worktreeBranchesOf(db, membership.members),
        ...decisionBranchesOf(db, rootIds),
        ...unresolvedOperationBranchesOf(db, rootIds),
      ]);
      const branches: DecisionBranchView[] = [];
      for (const branch of names) {
        const counts = decisionCountsUnder(db, membership, branch);
        if (counts) branches.push({ branch, ...counts });
      }
      branches.sort(byApprovableThenName);
      const body: DecisionBranchesBody = { ok: true, branches };
      if (typeof query.item === 'string' && query.item.length > 0) {
        body.item = { id: query.item, where: whereOf(db, roots, query.item, query.branch ?? null) };
      }
      return { status: 200, body };
    });
  } catch (error) {
    if (error instanceof AgentRoleTargetNotFoundError) return promoteError('not_found', { reason: 'not_found' });
    if (error instanceof MembershipUnsettledError) return promoteError('not_found', { reason: 'ambiguous' });
    throw error;
  }
}
