/**
 * API Route: /api/worktrees/:id/git/stash/:index
 * DELETE: Drop a stash (`git stash drop -- stash@{N}`).
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
 *
 * The dynamic `[index]` segment is the 2nd dynamic segment in the git routes
 * (after `/git/show/[commitHash]`). A stash index is a plain integer with no
 * '/', so a dynamic segment is appropriate here (unlike the #781 branch delete
 * which used POST + body because branch names contain '/').
 *
 * The `index` route param is received as a STRING (`rawIndex`) and validated with validateStashIndex
 * (digits-only, <= MAX_STASH_INDEX) before being embedded as a number. Errors
 * map via handleGitApiError (400 invalid_stash_index / 409 index lock / 504
 * timeout / 500 generic).
 */

import { NextRequest, NextResponse } from 'next/server';
import { stashDrop, handleGitApiError } from '@/lib/git/git-utils';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { validateStashIndex } from '@/lib/git/git-route-helpers';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; index: string }> }
) {
  try {
    const { id, index: rawIndex } = await params;
    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) {
      return worktree;
    }

    const index = validateStashIndex(rawIndex);
    if (index instanceof NextResponse) {
      return index;
    }

    await stashDrop(worktree.path, index);

    return NextResponse.json({ success: true, dropped: index }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'DELETE /api/worktrees/:id/git/stash/:index');
  }
}
