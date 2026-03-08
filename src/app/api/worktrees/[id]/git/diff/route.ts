/**
 * API Route: /api/worktrees/:id/git/diff
 * GET: Returns unified diff for a specific file in a commit
 * Issue #447: Git tab feature
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/auto-yes-manager';
import { isPathSafe } from '@/lib/path-validator';
import { getGitDiff, GitTimeoutError, GitNotRepoError } from '@/lib/git-utils';

/** Commit hash validation pattern: 7-40 hex characters */
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/;

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

    const { searchParams } = new URL(request.url);
    const commitHash = searchParams.get('commit');
    const filePath = searchParams.get('file');

    // Validate commit hash
    if (!commitHash || !COMMIT_HASH_PATTERN.test(commitHash)) {
      return NextResponse.json(
        { error: 'Invalid commit hash format' },
        { status: 400 }
      );
    }

    // Validate file path
    if (!filePath) {
      return NextResponse.json(
        { error: 'Invalid file path' },
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

    // Validate file path safety
    if (!isPathSafe(filePath, worktree.path)) {
      return NextResponse.json(
        { error: 'Invalid file path' },
        { status: 400 }
      );
    }

    const diff = await getGitDiff(worktree.path, commitHash, filePath);

    if (diff === null) {
      return NextResponse.json(
        { error: 'Commit not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ diff }, { status: 200 });
  } catch (error) {
    if (error instanceof GitNotRepoError) {
      return NextResponse.json(
        { error: 'Not a git repository' },
        { status: 400 }
      );
    }
    if (error instanceof GitTimeoutError) {
      return NextResponse.json(
        { error: 'Git command timed out' },
        { status: 504 }
      );
    }
    console.error('[GET /api/worktrees/:id/git/diff] Error:', error);
    return NextResponse.json(
      { error: 'Failed to execute git command' },
      { status: 500 }
    );
  }
}
