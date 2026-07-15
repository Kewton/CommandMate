/**
 * API Route: /api/worktrees/:id/git/branch/create
 * POST: Creates a branch WITHOUT checking it out (`git branch <name> [from] --`).
 * Issue #781: branch list / checkout / create / delete (Phase 3/5)
 *
 * Body: { name: string, from?: string }
 * - name / from are validated with validateGitBranchName.
 *
 * Error mapping via handleGitApiError: 400 invalid_branch_name / 404
 * branch_not_found (bad `from`) / 409 index lock / 504 timeout / 500.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createBranch, handleGitApiError } from '@/lib/git/git-utils';
import { validateGitBranchName } from '@/lib/git/git-route-helpers';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import type { BranchInfo } from '@/types/git';

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
    const { name, from } = body;

    const validName = validateGitBranchName(name);
    if (validName instanceof NextResponse) {
      return validName;
    }

    let validFrom: string | undefined;
    if (from !== undefined) {
      const fromResult = validateGitBranchName(from);
      if (fromResult instanceof NextResponse) {
        return fromResult;
      }
      validFrom = fromResult;
    }

    await createBranch(worktree.path, { name: validName, from: validFrom });

    // The new branch is not checked out and has no upstream yet.
    const branch: BranchInfo = {
      name: validName,
      isCurrent: false,
      isRemote: false,
      isDefault: false,
      upstream: null,
      aheadBehind: null,
      checkedOutWorktreePath: null,
    };

    return NextResponse.json({ success: true, branch }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/branch/create');
  }
}
