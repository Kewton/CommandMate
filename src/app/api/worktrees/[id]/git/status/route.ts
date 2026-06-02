/**
 * API Route: /api/worktrees/:id/git/status
 * GET: Returns git status (branch, commit, dirty, branch-mismatch) plus
 *      ahead/behind counts relative to upstream for a worktree.
 * Issue #779: git status API + GitPane Current Status (Phase 1/5)
 *
 * Structural skeleton (validation / DB / error handling) follows git/log/route.ts.
 * The getInitialBranch -> getGitStatus part follows worktrees/[id]/route.ts:50-59.
 * ahead/behind is computed ONLY here (never in getGitStatus / GET /api/worktrees/[id]).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, getInitialBranch } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getGitStatus, getAheadBehind, handleGitApiError } from '@/lib/git/git-utils';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Validate worktree ID format
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);

    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    const initialBranch = getInitialBranch(db, params.id);
    const status = await getGitStatus(worktree.path, initialBranch);
    // null allowed: no upstream / detached HEAD / error -> aheadBehind=null + HTTP 200.
    // The null reason is intentionally not disclosed to the client.
    const aheadBehind = await getAheadBehind(worktree.path);

    return NextResponse.json({ ...status, aheadBehind }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'GET /api/worktrees/:id/git/status');
  }
}
