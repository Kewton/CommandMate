/**
 * API Route: /api/worktrees/:id/git/stash/apply
 * POST: Apply a stash without dropping it (`git stash apply -- stash@{N}`).
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
 *
 * Body: { index?: number } (default 0), validated with validateStashIndex.
 * A conflict is a SUCCESS (HTTP 200) carrying `{ conflict: true, conflictFiles }`
 * — NOT a 409. Other errors map via handleGitApiError (400 invalid_stash_index /
 * 409 index lock / 504 timeout / 500 generic).
 */

import { NextRequest, NextResponse } from 'next/server';
import { stashApply, handleGitApiError } from '@/lib/git/git-utils';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { validateStashIndex } from '@/lib/git/git-route-helpers';

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
    const rawIndex = body.index ?? 0;
    const index = validateStashIndex(rawIndex);
    if (index instanceof NextResponse) {
      return index;
    }

    const result = await stashApply(worktree.path, index);

    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/stash/apply');
  }
}
