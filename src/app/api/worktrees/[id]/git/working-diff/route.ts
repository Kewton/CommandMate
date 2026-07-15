/**
 * API Route: /api/worktrees/:id/git/working-diff
 * GET: Returns the unified diff for a single working-tree file
 *      (staged / unstaged / untracked), used by the GitPane "Changes" section.
 * Issue #780: stage/unstage/commit operations + per-file diff.
 *
 * This is the working-tree counterpart of the commit-scoped /git/diff route
 * (which is COMMIT_HASH_PATTERN-gated and 400s for working-tree files).
 * Validation / DB / error handling mirror diff/route.ts and staged/route.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId, isPathSafe } from '@/lib/security/path-validator';
import {
  getWorkingTreeDiff,
  handleGitApiError,
  type WorkingTreeDiffMode,
} from '@/lib/git/git-utils';

/** Allowed working-tree diff modes (query param `mode`). */
const VALID_MODES: readonly WorkingTreeDiffMode[] = ['staged', 'unstaged', 'untracked'];

function isValidMode(value: string): value is WorkingTreeDiffMode {
  return (VALID_MODES as readonly string[]).includes(value);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Validate worktree ID format
    const { id } = await params;
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('file');
    // Default to 'unstaged' when omitted; validate strictly otherwise.
    const modeParam = searchParams.get('mode') ?? 'unstaged';

    // Validate file path presence
    if (!filePath) {
      return NextResponse.json(
        { error: 'Invalid file path' },
        { status: 400 }
      );
    }

    // Validate mode (strict allow-list)
    if (!isValidMode(modeParam)) {
      return NextResponse.json(
        { error: 'Invalid mode' },
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

    // Validate file path safety (directory traversal defense)
    if (!isPathSafe(filePath, worktree.path)) {
      return NextResponse.json(
        { error: 'Invalid file path' },
        { status: 400 }
      );
    }

    const diff = await getWorkingTreeDiff(worktree.path, filePath, modeParam);

    // A clean / no-diff file is NOT an error: return an empty diff with 200.
    return NextResponse.json({ diff: diff ?? '' }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'GET /api/worktrees/:id/git/working-diff');
  }
}
