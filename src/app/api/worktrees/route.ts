/**
 * API Route: GET /api/worktrees
 * Returns all worktrees sorted by updated_at DESC
 * Optionally filter by repository: GET /api/worktrees?repository=/path/to/repo
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktrees, getRepositories } from '@/lib/db';
import { isClaudeRunning } from '@/lib/claude-session';

export async function GET(request: NextRequest) {
  try {
    const db = getDbInstance();

    // Check for repository filter query parameter
    const searchParams = request.nextUrl.searchParams;
    const repositoryFilter = searchParams.get('repository');

    // Get worktrees (with optional filter)
    const worktrees = getWorktrees(db, repositoryFilter || undefined);

    // Check session status for each worktree
    const worktreesWithStatus = await Promise.all(
      worktrees.map(async (worktree) => {
        const isRunning = await isClaudeRunning(worktree.id);
        return {
          ...worktree,
          isSessionRunning: isRunning,
        };
      })
    );

    // Get repository list
    const repositories = getRepositories(db);

    return NextResponse.json(
      {
        worktrees: worktreesWithStatus,
        repositories,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error fetching worktrees:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worktrees' },
      { status: 500 }
    );
  }
}
