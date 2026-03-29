/**
 * API Route: PUT /api/repositories/restore
 * Restores an excluded repository and auto-syncs its worktrees
 * Issue #190: Repository exclusion on sync
 *
 * HTTP Method: PUT chosen over PATCH because this operation performs
 * a complete state restoration (enabled flag + worktrees table sync),
 * not just a partial field update. See design policy SF-C03.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  validateRepositoryPath,
  restoreRepository,
} from '@/lib/db/db-repository';
import { scanWorktrees } from '@/lib/git/worktrees';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';
import fs from 'fs';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories-restore');

export async function PUT(request: NextRequest) {
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
    const resolvedPath = validation.resolvedPath!;

    const db = getDbInstance();

    // Restore repository (set enabled=1)
    const restored = restoreRepository(db, repositoryPath);
    if (!restored) {
      return NextResponse.json(
        { success: false, error: 'Repository not found in exclusion list' },
        { status: 404 }
      );
    }

    // Check if the repository path exists on disk
    if (!fs.existsSync(resolvedPath)) {
      return NextResponse.json({
        success: true,
        worktreeCount: 0,
        warning: 'Repository path not found on disk. No worktrees were restored.',
      });
    }

    // Issue #526: Auto-sync with cleanup (SEC-SF-005: TOCTOU risk acknowledged)
    const worktrees = await scanWorktrees(resolvedPath);
    let deletedCount = 0;
    let cleanupWarnings: string[] = [];
    if (worktrees.length > 0) {
      const result = await syncWorktreesAndCleanup(db, worktrees);
      deletedCount = result.syncResult.deletedIds.length;
      cleanupWarnings = result.cleanupWarnings;
    }

    return NextResponse.json({
      success: true,
      worktreeCount: worktrees.length,
      message: `Repository restored with ${worktrees.length} worktree(s)`,
      deletedCount,
      cleanupWarnings,
    });
  } catch (error: unknown) {
    // SEC-SF-003: Fixed error message - do not expose internal details
    logger.error('repository:restore-failed', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { success: false, error: 'Failed to restore repository' },
      { status: 500 }
    );
  }
}
