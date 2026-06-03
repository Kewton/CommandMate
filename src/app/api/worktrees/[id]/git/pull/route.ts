/**
 * API Route: /api/worktrees/:id/git/pull
 * POST: Pull from a remote (`git pull [--rebase] [--ff-only] <remote> <branch> --`).
 * Issue #783: push / pull / fetch (Phase 5/5)
 *
 * Body: { remote?: string, branch?: string, rebase?: boolean, ffOnly?: boolean }
 * - remote defaults to 'origin'; branch defaults to the current branch.
 * - remote / branch (when supplied) are validated with validateGitBranchName
 *   (DR4-001 / DR4-005). The current-branch default is git-derived (trusted).
 * - rebase=true AND ffOnly=true is contradictory -> 400 invalid_options
 *   (route-local reason, like reset's invalid_mode; NOT in GitNetworkErrorReason).
 * - serialized per worktree; a merge/rebase conflict returns 200
 *   { success: true, conflict: true, conflictFiles } (a UI quasi-error).
 *
 * Error mapping via handleGitApiError: 400 invalid_branch_name / 401 auth_failed
 * / 409 non_fast_forward / 400 no_upstream / 502 network / 409 index lock /
 * 504 timeout / 500.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getInitialBranch } from '@/lib/db';
import { gitPull, getGitStatus, handleGitApiError } from '@/lib/git/git-utils';
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
    const { remote, branch, rebase, ffOnly } = body;

    // rebase + ff-only is contradictory.
    if (rebase === true && ffOnly === true) {
      return NextResponse.json(
        { error: 'rebase and ffOnly are mutually exclusive', reason: 'invalid_options' },
        { status: 400 }
      );
    }

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

    const result = await gitPull(worktree.path, {
      remote: validRemote,
      branch: validBranch,
      rebase: rebase === true,
      ffOnly: ffOnly === true,
    });

    if (result.conflict) {
      return NextResponse.json(
        { success: true, conflict: true, conflictFiles: result.conflictFiles ?? [] },
        { status: 200 }
      );
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/pull');
  }
}
