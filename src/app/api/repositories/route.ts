/**
 * API Route: DELETE /api/repositories
 * Deletes a repository and all its worktrees from the database
 * Issue #69: Repository delete feature
 * Issue #190: Repository exclusion on sync (disableRepository before worktree check)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import {
  getWorktreeIdsByRepository,
  deleteRepositoryWorktrees,
} from '@/lib/db';
import { validateRepositoryPath, disableRepository } from '@/lib/db-repository';
import { cleanupMultipleWorktrees } from '@/lib/session-cleanup';
import { cleanupRooms, broadcastMessage } from '@/lib/ws-server';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { killSession } from '@/lib/tmux/tmux';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories');



/**
 * Kill a CLI tool session for a worktree
 * Used as the killSessionFn parameter for cleanupMultipleWorktrees
 */
async function killWorktreeSession(
  worktreeId: string,
  cliToolId: CLIToolType
): Promise<boolean> {
  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);
  const isRunning = await cliTool.isRunning(worktreeId);

  if (!isRunning) {
    return false;
  }

  const sessionName = cliTool.getSessionName(worktreeId);
  return killSession(sessionName);
}

/**
 * DELETE /api/repositories
 *
 * Request body:
 * {
 *   repositoryPath: string  // Path of the repository to delete
 * }
 *
 * Response:
 * - 200: Success (with optional warnings)
 * - 400: Missing or invalid repositoryPath
 * - 404: Repository not found (no worktrees exist)
 * - 500: Database deletion failed
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { repositoryPath } = body;

    // Validate and resolve repository path (DRY: shared validation)
    const validation = validateRepositoryPath(repositoryPath);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Issue #190: Disable repository BEFORE worktreeIds check (SF-C01)
    // This ensures exclusion registration even when worktrees table has no records
    disableRepository(db, repositoryPath);

    // Get all worktree IDs for this repository
    const worktreeIds = getWorktreeIdsByRepository(db, repositoryPath);

    if (worktreeIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Repository not found' },
        { status: 404 }
      );
    }

    logger.info('repository:delete-start', { repositoryPath, worktreeCount: worktreeIds.length });

    // 1. Clean up sessions and pollers for all worktrees
    const cleanupResult = await cleanupMultipleWorktrees(
      worktreeIds,
      killWorktreeSession
    );

    // Log cleanup results
    for (const result of cleanupResult.results) {
      if (result.sessionsKilled.length > 0) {
        logger.info('session:killed', { worktreeId: result.worktreeId, sessions: result.sessionsKilled });
      }
      if (result.sessionErrors.length > 0) {
        logger.warn('session-kill-errors-for:');
      }
    }

    // 2. Clean up WebSocket rooms
    cleanupRooms(worktreeIds);

    // 3. Delete from database (CASCADE will delete related data)
    let deletedCount: number;
    try {
      const deleteResult = deleteRepositoryWorktrees(db, repositoryPath);
      deletedCount = deleteResult.deletedCount;
      logger.info('repository:deleted', { repositoryPath, deletedCount });
    } catch (error) {
      logger.error('database-deletion-failed-for:', { error: error instanceof Error ? error.message : String(error) });
      return NextResponse.json(
        { success: false, error: 'Database deletion failed' },
        { status: 500 }
      );
    }

    // 4. Broadcast repository_deleted event
    // Use a special worktree ID for repository-level events
    broadcastMessage('repository_deleted', {
      worktreeId: 'global',
      repositoryPath,
      deletedWorktreeIds: worktreeIds,
    });

    // Build response
    const response: {
      success: true;
      deletedWorktreeCount: number;
      deletedWorktreeIds: string[];
      warnings?: string[];
    } = {
      success: true,
      deletedWorktreeCount: deletedCount,
      deletedWorktreeIds: worktreeIds,
    };

    if (cleanupResult.warnings.length > 0) {
      response.warnings = cleanupResult.warnings;
      logger.info('repository:delete-completed', { repositoryPath, warningCount: cleanupResult.warnings.length });
    } else {
      logger.info('repository:delete-completed', { repositoryPath });
    }

    return NextResponse.json(response, { status: 200 });
  } catch (error: unknown) {
    logger.error('unexpected-error:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { success: false, error: 'Failed to delete repository' },
      { status: 500 }
    );
  }
}
