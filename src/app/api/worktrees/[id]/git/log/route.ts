/**
 * API Route: /api/worktrees/:id/git/log
 * GET: Returns commit history for a worktree
 * Issue #447: Git tab feature
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getGitLog, handleGitApiError } from '@/lib/git/git-utils';

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

    // Parse and validate query parameters
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get('limit');
    const offsetParam = searchParams.get('offset');

    let limit = 50;
    let offset = 0;

    if (limitParam !== null) {
      limit = parseInt(limitParam, 10);
      if (isNaN(limit) || limit < 1 || limit > 100) {
        return NextResponse.json(
          { error: 'Invalid limit parameter' },
          { status: 400 }
        );
      }
    }

    if (offsetParam !== null) {
      offset = parseInt(offsetParam, 10);
      if (isNaN(offset) || offset < 0) {
        return NextResponse.json(
          { error: 'Invalid offset parameter' },
          { status: 400 }
        );
      }
    }

    const commits = await getGitLog(worktree.path, limit, offset);

    return NextResponse.json({ commits }, { status: 200 });
  } catch (error) {
    return handleGitApiError(error, 'GET /api/worktrees/:id/git/log');
  }
}
