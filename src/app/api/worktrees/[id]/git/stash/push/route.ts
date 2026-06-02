/**
 * API Route: /api/worktrees/:id/git/stash/push
 * POST: Stash the working tree (`git stash push [--include-untracked] [-m msg] --`).
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
 *
 * Body: { message?: string, includeUntracked?: boolean }
 * - A clean working tree ("No local changes to save") is normalized by
 *   stashPush to GitNothingToStashError -> 400 nothing_to_stash.
 *
 * Structure follows git/stage/route.ts; error mapping via handleGitApiError
 * (400 nothing_to_stash / 409 index lock / 504 timeout / 500 generic).
 */

import { NextRequest, NextResponse } from 'next/server';
import { stashPush, handleGitApiError } from '@/lib/git/git-utils';
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
    const message = typeof body.message === 'string' ? body.message : undefined;
    const includeUntracked = body.includeUntracked === true;

    await stashPush(worktree.path, { message, includeUntracked });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/stash/push');
  }
}
