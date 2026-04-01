/**
 * API Route: GET /api/worktrees
 * Returns all worktrees sorted by updated_at DESC
 * Optionally filter by repository: GET /api/worktrees?repository=/path/to/repo
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering - this route uses searchParams and database access
export const dynamic = 'force-dynamic';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktrees, getRepositories, getMessages, markPendingPromptsAsAnswered } from '@/lib/db';
import { listSessions } from '@/lib/tmux/tmux';
import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { parseIncludeParam } from '@/lib/api/worktrees-include-parser';
import { isWorktreeStalled } from '@/lib/detection/stalled-detector';
import { getNextAction, getReviewStatus } from '@/lib/session/next-action-helper';
import { createLogger } from '@/lib/logger';
import type { SessionStatus } from '@/lib/detection/status-detector';
import type { PromptType } from '@/types/models';

const logger = createLogger('api/worktrees');

/**
 * Derive SessionStatus from worktree status helper result.
 */
function deriveSessionStatus(status: {
  isSessionRunning: boolean;
  isWaitingForResponse: boolean;
  isProcessing: boolean;
}): SessionStatus | null {
  if (!status.isSessionRunning) return null;
  if (status.isWaitingForResponse) return 'waiting';
  if (status.isProcessing) return 'running';
  return 'ready';
}

export async function GET(request: NextRequest) {
  try {
    const db = getDbInstance();

    // Check for query parameters
    const searchParams = request.nextUrl?.searchParams;
    const repositoryFilter = searchParams?.get('repository');
    const includes = parseIncludeParam(searchParams?.get('include') ?? null);
    const includeReview = includes.has('review');

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

        const base = {
          ...worktree,
          ...status,
        };

        // Issue #600: Add review fields when ?include=review
        if (includeReview) {
          const cliToolId = worktree.cliToolId ?? 'claude';
          const sessionStatus = deriveSessionStatus(status);
          const stalled = isWorktreeStalled(worktree.id, cliToolId);
          // Derive promptType from status helper - approximate from isWaitingForResponse
          const promptType: PromptType | null = status.isWaitingForResponse ? 'approval' : null;
          const nextAction = getNextAction(sessionStatus, promptType, stalled);
          const reviewStatus = getReviewStatus(
            worktree.status ?? null,
            sessionStatus,
            promptType,
            stalled
          );

          return {
            ...base,
            isStalled: stalled,
            nextAction,
            reviewStatus,
          };
        }

        return base;
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
