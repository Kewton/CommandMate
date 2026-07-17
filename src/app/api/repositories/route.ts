/**
 * API Routes: GET & DELETE /api/repositories
 * - GET: Returns repository list augmented with worktree counts (Issue #644)
 * - DELETE: Deletes a repository and all its worktrees from the database
 *
 * Issue #69: Repository delete feature
 * Issue #190: Repository exclusion on sync (disableRepository before worktree check)
 * Issue #644: Repository list display
 * Issue #1346: No ghost repository record when DELETE answers 404
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getWorktreeIdsByRepository,
  deleteRepositoryWorktrees,
} from '@/lib/db';
import {
  validateRepositoryPath,
  disableRepository,
  disableExistingRepository,
  getAllRepositoriesWithWorktreeCount,
} from '@/lib/db/db-repository';
import { cleanupMultipleWorktrees, killWorktreeSession } from '@/lib/session-cleanup';
import { cleanupRooms, broadcastMessage } from '@/lib/ws-server';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories');

/**
 * GET /api/repositories
 *
 * Response:
 * - 200: { success: true, repositories: RepositoryListItem[] }
 * - 500: { success: false, error: string }
 *
 * Returns ALL repositories (enabled and disabled) so the client can render
 * a "Disabled" badge for rows with enabled=false. Each row includes the
 * number of worktrees currently registered under that repository path.
 *
 * Issue #644
 */
export async function GET() {
  try {
    const db = getDbInstance();
    const repos = getAllRepositoriesWithWorktreeCount(db);

    const repositories = repos.map((r) => ({
      id: r.id,
      name: r.name,
      displayName: r.displayName ?? null,
      path: r.path,
      enabled: r.enabled,
      // Issue #690: Sidebar visibility flag, independent of `enabled`.
      visible: r.visible,
      worktreeCount: r.worktreeCount,
    }));

    return NextResponse.json({ success: true, repositories }, { status: 200 });
  } catch (error: unknown) {
    logger.error('repository:list-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Failed to list repositories' },
      { status: 500 }
    );
  }
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

    // Validate and resolve repository path (DRY: shared validation)
    const validation = validateRepositoryPath(body.repositoryPath);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    // Issue #1347: use the resolved (canonical) path as the single key for every
    // operation below. worktrees.repository_path is stored path.resolve()'d, and
    // disableRepository / disableExistingRepository normalize internally (#1346).
    // A raw client path (trailing slash, relative, ".." segment) fails the worktree
    // WHERE match, so getWorktreeIdsByRepository / deleteRepositoryWorktrees would
    // find nothing and leave the worktrees orphaned. validation.resolvedPath is
    // guaranteed to be set when validation.valid is true.
    const repositoryPath = validation.resolvedPath!;

    const db = getDbInstance();

    // Get all worktree IDs for this repository
    const worktreeIds = getWorktreeIdsByRepository(db, repositoryPath);

    if (worktreeIds.length === 0) {
      // Issue #190 (SF-C01): a repository registered in the repositories table can be
      // resurrected by Sync All even when the worktrees table has no records, so the
      // exclusion must still be registered here.
      // Issue #1346: an unregistered path has nothing to exclude - creating a record for
      // it would leave a ghost "Disabled / 0 worktrees" row behind a 404 response.
      disableExistingRepository(db, repositoryPath);

      return NextResponse.json(
        { success: false, error: 'Repository not found' },
        { status: 404 }
      );
    }

    // Issue #190: Register the exclusion before deleting the worktrees, so a repository
    // with worktrees is never resurrected by a Sync All that races the deletion below.
    disableRepository(db, repositoryPath);

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
        logger.warn('session:kill-errors', { worktreeId: result.worktreeId, errors: result.sessionErrors });
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
      logger.error('repository:db-delete-failed', { repositoryPath, error: error instanceof Error ? error.message : String(error) });
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
    logger.error('repository:delete-failed', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { success: false, error: 'Failed to delete repository' },
      { status: 500 }
    );
  }
}
