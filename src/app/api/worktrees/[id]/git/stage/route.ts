/**
 * API Route: /api/worktrees/:id/git/stage
 * POST: Stages the given files (`git add -- <files>`).
 * Issue #780: stage/unstage/commit operations (Phase 2/5)
 *
 * Body: { files: string[] } — non-empty array of relative paths, each validated
 * with isPathSafe against the worktree root. The trailing `--` in git-utils
 * blocks option injection.
 *
 * Structure follows git/status/route.ts; error mapping via handleGitApiError
 * (409 for index lock, 504 for timeout, 500 generic).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { stageFiles, handleGitApiError } from '@/lib/git/git-utils';
import { validateFilesBody } from '@/lib/git/git-route-helpers';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);

    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const result = validateFilesBody(body.files, worktree.path);
    if (result instanceof NextResponse) {
      return result;
    }

    await stageFiles(worktree.path, result);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'POST /api/worktrees/:id/git/stage');
  }
}
