/**
 * API Route: GET /api/worktrees
 * Returns all worktrees sorted by updated_at DESC
 * Optionally filter by repository: GET /api/worktrees?repository=/path/to/repo
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering - this route uses searchParams and database access
export const dynamic = 'force-dynamic';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktrees, getRepositories, getMessages, markPendingPromptsAsAnswered } from '@/lib/db';
import { listSessions } from '@/lib/tmux';
import { detectWorktreeSessionStatus } from '@/lib/worktree-status-helper';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/worktrees');

export async function GET(request: NextRequest) {
  try {
    const db = getDbInstance();

    // Check for repository filter query parameter
    const searchParams = request.nextUrl?.searchParams;
    const repositoryFilter = searchParams?.get('repository');

    // Parallel: DB query and tmux session list are independent
    const worktrees = getWorktrees(db, repositoryFilter || undefined);
    // Issue #405: Batch query all tmux sessions once (N+1 elimination)
    const tmuxSessions = await listSessions();
    const sessionNameSet = new Set(tmuxSessions.map(s => s.name));

    const worktreesWithStatus = await Promise.all(
      worktrees.map(async (worktree) => {
        const status = await detectWorktreeSessionStatus(
          worktree.id,
          sessionNameSet,
          db,
          getMessages,
          markPendingPromptsAsAnswered,
        );

        return {
          ...worktree,
          ...status,
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
    logger.error('error-fetching-worktrees:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to fetch worktrees' },
      { status: 500 }
    );
  }
}
