/**
 * API Route: /api/worktrees/:id/git/branch/delete
 * POST: Deletes a branch (`git branch -d|-D <name> --`).
 * Issue #781: branch list / checkout / create / delete (Phase 3/5)
 *
 * POST + body (NOT DELETE + [name]): branch names contain '/', which a single
 * dynamic segment would break; this also mirrors the create route.
 *
 * Body: { name: string, force?: boolean }
 * - name is validated with validateGitBranchName.
 * - force maps to `git branch -D` (skips the merged check).
 *
 * Error mapping via handleGitApiError: 400 invalid_branch_name / 404
 * branch_not_found / 409 not_merged / 409 current_branch / 409 default_branch /
 * 409 index lock / 504 timeout / 500.
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteBranch, handleGitApiError } from '@/lib/git/git-utils';
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
    const { name, force } = body;

    const validName = validateGitBranchName(name);
    if (validName instanceof NextResponse) {
      return validName;
    }

    await deleteBranch(worktree.path, { name: validName, force: force === true });

    return NextResponse.json({ success: true, deleted: validName }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/branch/delete');
  }
}
