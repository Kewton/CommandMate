/**
 * API Route: /api/worktrees/:id/git/show/:commitHash
 * GET: Returns commit details and changed files
 * Issue #447: Git tab feature
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getGitShow, handleGitApiError } from '@/lib/git/git-utils';
import { COMMIT_HASH_PATTERN } from '@/types/git';

export async function GET(
  _request: Request,
  { params }: { params: { id: string; commitHash: string } }
) {
  try {
    // Validate worktree ID format
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    // Validate commit hash format
    if (!COMMIT_HASH_PATTERN.test(params.commitHash)) {
      return NextResponse.json(
        { error: 'Invalid commit hash format' },
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

    const result = await getGitShow(worktree.path, params.commitHash);

    if (!result) {
      return NextResponse.json(
        { error: 'Commit not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'GET /api/worktrees/:id/git/show/:hash');
  }
}
