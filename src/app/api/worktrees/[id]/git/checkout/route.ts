/**
 * API Route: /api/worktrees/:id/git/checkout
 * POST: Switches / creates and switches to a branch.
 * Issue #781: branch list / checkout / create / delete (Phase 3/5)
 *
 * Body: { branch: string, createIfMissing?: boolean, from?: string, force?: boolean }
 * - branch / from are validated with validateGitBranchName (rejects leading '-',
 *   '..', '@{', etc.; all git args are also '--'-terminated in git-utils).
 * - force discards a dirty working tree; it does NOT bypass checked_out_elsewhere.
 * - remote branches are checked out as local tracking branches (no detached HEAD).
 *
 * Error mapping via handleGitApiError: 400 invalid_branch_name / 404
 * branch_not_found / 409 dirty / 409 checked_out_elsewhere (+worktreePath) /
 * 409 index lock / 504 timeout / 500.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getInitialBranch } from '@/lib/db';
import { checkoutBranch, getGitStatus, handleGitApiError } from '@/lib/git/git-utils';
import { validateGitBranchName } from '@/lib/git/git-route-helpers';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) {
      return worktree;
    }

    const body = await request.json().catch(() => ({}));
    const { branch, createIfMissing, from, force } = body;

    const validBranch = validateGitBranchName(branch);
    if (validBranch instanceof NextResponse) {
      return validBranch;
    }

    // `from` is optional; when present it must also be a valid ref name.
    let validFrom: string | undefined;
    if (from !== undefined) {
      const fromResult = validateGitBranchName(from);
      if (fromResult instanceof NextResponse) {
        return fromResult;
      }
      validFrom = fromResult;
    }

    await checkoutBranch(worktree.path, {
      branch: validBranch,
      createIfMissing: createIfMissing === true,
      from: validFrom,
      force: force === true,
    });

    // Report the resulting branch / dirty state (best-effort, checkout succeeded).
    const initialBranch = getInitialBranch(getDbInstance(), id);
    const status = await getGitStatus(worktree.path, initialBranch);

    return NextResponse.json(
      { success: true, currentBranch: status.currentBranch, isDirty: status.isDirty },
      { status: 200 }
    );
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/checkout');
  }
}
