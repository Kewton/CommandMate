/**
 * API Route: /api/worktrees/:id/git/stash/pop
 * POST: Pop a stash (`git stash pop -- stash@{N}`).
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
 *
 * Body: { index?: number } (default 0). The index is validated with
 * validateStashIndex (non-negative integer <= MAX_STASH_INDEX), then embedded
 * as a pure number into `stash@{N}` (injection-free).
 *
 * A conflict is a SUCCESS (HTTP 200) carrying `{ conflict: true, conflictFiles,
 * stashRetained: true }` — NOT a 409. Other errors map via handleGitApiError
 * (400 invalid_stash_index / 409 index lock / 504 timeout / 500 generic).
 */

import { NextRequest, NextResponse } from 'next/server';
import { stashPop, handleGitApiError } from '@/lib/git/git-utils';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { validateStashIndex } from '@/lib/git/git-route-helpers';

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
    const rawIndex = body.index ?? 0;
    const index = validateStashIndex(rawIndex);
    if (index instanceof NextResponse) {
      return index;
    }

    const result = await stashPop(worktree.path, index);

    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/stash/pop');
  }
}
