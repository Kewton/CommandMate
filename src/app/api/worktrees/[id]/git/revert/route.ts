/**
 * API Route: /api/worktrees/:id/git/revert
 * POST: Revert a commit (`git revert [--no-commit] <hash> --`).
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
 *
 * Body: { commitHash: string, noCommit?: boolean }
 * - commitHash must match COMMIT_HASH_PATTERN (lowercase 7-40 hex), else 400
 *   invalid_target. The trailing `--` in git-utils is defense in depth.
 * - noCommit maps to `git revert --no-commit` (leaves the change staged).
 *
 * A conflict is a SUCCESS (HTTP 200) carrying `{ conflict: true, conflictFiles }`
 * — NOT a 409. Other errors map via handleGitApiError (409 index lock / 504
 * timeout / 500 generic).
 */

import { NextRequest, NextResponse } from 'next/server';
import { gitRevert, handleGitApiError } from '@/lib/git/git-utils';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { COMMIT_HASH_PATTERN } from '@/types/git';

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
    const { commitHash, noCommit } = body;

    if (typeof commitHash !== 'string' || !COMMIT_HASH_PATTERN.test(commitHash)) {
      return NextResponse.json(
        { error: 'Invalid commit hash', reason: 'invalid_target' },
        { status: 400 }
      );
    }

    const result = await gitRevert(worktree.path, {
      commitHash,
      noCommit: noCommit === true,
    });

    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/revert');
  }
}
