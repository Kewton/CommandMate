/**
 * API Route: /api/worktrees/:id/git/push
 * POST: Push to a remote.
 * Issue #783: push / pull / fetch (Phase 5/5)
 *
 * Body: { remote?: string, branch?: string, force?: boolean,
 *         forceWithLease?: boolean, setUpstream?: boolean }
 * - remote defaults to 'origin'; branch defaults to the current branch.
 * - remote / branch (when supplied) are validated with validateGitBranchName
 *   (DR4-001 / DR4-005). The current-branch default is git-derived (trusted).
 * - DR4-004: git-utils builds a SERVER-CONSTRUCTED explicit refspec
 *   `<branch>:refs/heads/<branch>` and the default-branch force-push protection
 *   compares THAT destination ref (never the push.default-resolved upstream).
 * - --force-with-lease is preferred over --force when both are set.
 *
 * Error mapping via handleGitApiError: 400 invalid_branch_name / 401 auth_failed
 * / 409 non_fast_forward / 409 protected_branch / 409 force_with_lease_stale /
 * 400 no_upstream / 502 network / 409 index lock / 504 timeout / 500.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getInitialBranch } from '@/lib/db';
import { gitPush, getGitStatus, handleGitApiError } from '@/lib/git/git-utils';
import { validateGitBranchName } from '@/lib/git/git-route-helpers';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const worktree = resolveWorktreeOr404(params.id);
    if (worktree instanceof NextResponse) {
      return worktree;
    }

    const body = await request.json().catch(() => ({}));
    const { remote, branch, force, forceWithLease, setUpstream } = body;

    // remote defaults to 'origin'; validate any user-supplied value (DR4-001).
    let validRemote = 'origin';
    if (remote !== undefined) {
      const remoteResult = validateGitBranchName(remote);
      if (remoteResult instanceof NextResponse) {
        return remoteResult;
      }
      validRemote = remoteResult;
    }

    // branch defaults to the current branch (git-derived, trusted); validate any
    // user-supplied value.
    const initialBranch = getInitialBranch(getDbInstance(), params.id);
    let validBranch: string;
    if (branch !== undefined) {
      const branchResult = validateGitBranchName(branch);
      if (branchResult instanceof NextResponse) {
        return branchResult;
      }
      validBranch = branchResult;
    } else {
      const preStatus = await getGitStatus(worktree.path, initialBranch);
      validBranch = preStatus.currentBranch;
    }

    await gitPush(worktree.path, {
      remote: validRemote,
      branch: validBranch,
      force: force === true,
      forceWithLease: forceWithLease === true,
      setUpstream: setUpstream === true,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/push');
  }
}
