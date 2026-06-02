/**
 * API Route: /api/worktrees/:id/git/staged
 * GET: Returns the working-tree status split into staged / unstaged / untracked.
 * Issue #780: stage/unstage/commit operations (Phase 2/5)
 *
 * Structural skeleton (validation / DB / error handling) follows git/status/route.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getStagedStatus, handleGitApiError } from '@/lib/git/git-utils';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
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

    const staged = await getStagedStatus(worktree.path);

    return NextResponse.json(staged, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'GET /api/worktrees/:id/git/staged');
  }
}
