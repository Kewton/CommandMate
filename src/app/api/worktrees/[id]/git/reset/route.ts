/**
 * API Route: /api/worktrees/:id/git/reset
 * POST: Reset the current branch (`git reset --<mode> <target> --`).
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
 *
 * Body: { target: 'HEAD' | commitHash, mode: 'soft' | 'mixed' | 'hard', confirmBranch?: string }
 *
 * Validation (early 400, before the mutating call):
 * - mode must be one of soft/mixed/hard (allow-list).
 * - target must be the literal 'HEAD' OR match COMMIT_HASH_PATTERN
 *   (lowercase 7-40 hex). Branch names / HEAD~N / tags / uppercase are rejected
 *   with 400 invalid_target. The trailing `--` in git-utils is defense in depth.
 * - mode==='hard' REQUIRES confirmBranch and it must match the current branch
 *   (getGitStatus().currentBranch) exactly, else 400 confirmation_mismatch.
 *
 * Safety: a hard reset on the default branch is refused server-side
 * (GitResetDefaultBranchError -> 409 default_branch) by gitReset itself.
 *
 * Error mapping via handleGitApiError (409 default_branch / 409 index lock /
 * 504 timeout / 500 generic).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getInitialBranch } from '@/lib/db';
import { gitReset, getGitStatus, handleGitApiError } from '@/lib/git/git-utils';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { COMMIT_HASH_PATTERN, type GitResetMode } from '@/types/git';

const VALID_MODES: ReadonlySet<GitResetMode> = new Set<GitResetMode>(['soft', 'mixed', 'hard']);

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
    const { target, mode, confirmBranch } = body;

    // mode allow-list.
    if (typeof mode !== 'string' || !VALID_MODES.has(mode as GitResetMode)) {
      return NextResponse.json(
        { error: 'Invalid reset mode', reason: 'invalid_mode' },
        { status: 400 }
      );
    }

    // target must be the literal 'HEAD' OR a lowercase 7-40 hex hash.
    if (typeof target !== 'string' || (target !== 'HEAD' && !COMMIT_HASH_PATTERN.test(target))) {
      return NextResponse.json(
        { error: 'Invalid reset target', reason: 'invalid_target' },
        { status: 400 }
      );
    }

    const initialBranch = getInitialBranch(getDbInstance(), params.id);

    // hard mode: require confirmBranch and match it against the current branch.
    if (mode === 'hard') {
      const preStatus = await getGitStatus(worktree.path, initialBranch);
      if (typeof confirmBranch !== 'string' || confirmBranch !== preStatus.currentBranch) {
        return NextResponse.json(
          { error: 'Branch confirmation does not match', reason: 'confirmation_mismatch' },
          { status: 400 }
        );
      }
    }

    await gitReset(worktree.path, { target, mode: mode as GitResetMode });

    const status = await getGitStatus(worktree.path, initialBranch);

    return NextResponse.json(
      { success: true, currentBranch: status.currentBranch, isDirty: status.isDirty },
      { status: 200 }
    );
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/reset');
  }
}
