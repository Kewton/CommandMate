/**
 * API Route: POST /api/repositories/scan
 * Scans a repository path for worktrees and adds them to the database
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import type Database from 'better-sqlite3';
import { getDbInstance } from '@/lib/db/db-instance';
import { scanWorktrees } from '@/lib/git/worktrees';
import type { Worktree } from '@/types/models';
import { getRepositoryByPath, createRepository } from '@/lib/db/db-repository';
import { isPathSafe } from '@/lib/security/path-validator';
import { getEnv } from '@/lib/env';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories-scan');

/**
 * Issue #1348: Register a `repositories` row for each repository discovered by
 * the scan.
 *
 * Historically the scan path only synced the `worktrees` table
 * (scanWorktrees -> syncWorktreesAndCleanup) and never created a `repositories`
 * row. As a result scan-registered repositories showed up in the sidebar
 * (worktrees-driven) but were invisible in the management screen
 * (repositories-driven), could not be disabled / hidden / used for Home ToDo,
 * and were excluded from the next sync's target set.
 *
 * This mirrors the clone path (`CloneManager.onCloneSuccess` ->
 * `createRepository`) so all three registration routes (clone / env / scan)
 * leave a `repositories` row behind. Existing rows are left untouched so a
 * user's enabled/visible/disabled choices are preserved (matching the
 * idempotent behavior of `ensureEnvRepositoriesRegistered`).
 */
function registerScannedRepositories(
  db: Database.Database,
  worktrees: Worktree[]
): void {
  const registered = new Set<string>();

  for (const worktree of worktrees) {
    const repositoryPath = worktree.repositoryPath;
    if (!repositoryPath || registered.has(repositoryPath)) {
      continue;
    }
    registered.add(repositoryPath);

    // Preserve any existing row (and the user's enabled/visible state).
    if (getRepositoryByPath(db, repositoryPath)) {
      continue;
    }

    createRepository(db, {
      name: worktree.repositoryName || path.basename(repositoryPath),
      path: repositoryPath,
      cloneSource: 'local',
      enabled: true,
      visible: true,
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { repositoryPath } = body;

    // Validate input
    if (!repositoryPath || typeof repositoryPath !== 'string') {
      return NextResponse.json(
        { error: 'Repository path is required' },
        { status: 400 }
      );
    }

    const { CM_ROOT_DIR } = getEnv();

    // Security: Validate path safety relative to configured root
    if (!isPathSafe(repositoryPath, CM_ROOT_DIR)) {
      return NextResponse.json(
        { error: 'Invalid or unsafe repository path' },
        { status: 400 }
      );
    }

    const normalizedPath = path.resolve(CM_ROOT_DIR, repositoryPath);

    // Scan for worktrees
    const worktrees = await scanWorktrees(normalizedPath);

    if (worktrees.length === 0) {
      return NextResponse.json(
        { error: 'No worktrees found in the specified path. Make sure it is a valid git repository.' },
        { status: 404 }
      );
    }

    const db = getDbInstance();

    // Issue #1348: Register a `repositories` row for each discovered repository
    // (aligns scan with the clone/env registration routes) so it appears in the
    // management screen and is included in subsequent sync runs.
    registerScannedRepositories(db, worktrees);

    // Issue #526: Sync to database and clean up sessions for deleted worktrees
    const { syncResult, cleanupWarnings } = await syncWorktreesAndCleanup(db, worktrees);

    return NextResponse.json(
      {
        success: true,
        message: `Successfully scanned and added ${worktrees.length} worktree(s)`,
        worktreeCount: worktrees.length,
        repositoryPath: worktrees[0].repositoryPath,
        repositoryName: worktrees[0].repositoryName,
        deletedCount: syncResult.deletedIds.length,
        cleanupWarnings,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('repository:scan-failed', { error: error instanceof Error ? error.message : String(error) });
    const errorMessage = error instanceof Error ? error.message : 'Failed to scan repository';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
