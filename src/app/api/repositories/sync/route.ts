/**
 * API Route: POST /api/repositories/sync
 * Re-scans all configured repositories and syncs worktrees to database
 * Issue #190: Filter excluded repositories before scanning
 * Issue #490: Include DB-registered repositories (e.g. cloned repos) in scan
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRepositoryPaths, scanMultipleRepositories } from '@/lib/git/worktrees';
import { registerAndFilterRepositories, getAllRepositories } from '@/lib/db/db-repository';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories-sync');

export async function POST() {
  try {
    // Get configured repository paths from environment
    const repositoryPaths = getRepositoryPaths();

    const db = getDbInstance();

    // Issue #490: Also include DB-registered repositories (e.g. cloned repos)
    // These are not in WORKTREE_REPOS but were registered via git clone feature
    const dbRepositories = getAllRepositories(db);
    const dbEnabledPaths = dbRepositories
      .filter(r => r.enabled)
      .map(r => r.path);

    // Merge env paths and DB-registered paths (deduplicate)
    const allPaths = [...new Set([...repositoryPaths, ...dbEnabledPaths])];

    if (allPaths.length === 0) {
      return NextResponse.json(
        { error: 'No repositories configured. Please set WORKTREE_REPOS or CM_ROOT_DIR environment variable.' },
        { status: 400 }
      );
    }

    // Issue #190/#202: Register environment variable repositories and filter out excluded ones
    // registerAndFilterRepositories() encapsulates the ordering constraint
    const { filteredPaths } = registerAndFilterRepositories(db, allPaths);

    // Scan filtered repositories (excluded repos are skipped)
    const allWorktrees = await scanMultipleRepositories(filteredPaths);

    // Issue #526: Sync to database and clean up sessions for deleted worktrees
    const { syncResult, cleanupWarnings } = await syncWorktreesAndCleanup(db, allWorktrees);

    // Get unique repository count
    const uniqueRepos = new Set(allWorktrees.map(wt => wt.repositoryPath));

    return NextResponse.json(
      {
        success: true,
        message: `Successfully synced ${allWorktrees.length} worktree(s) from ${uniqueRepos.size} repository/repositories`,
        worktreeCount: allWorktrees.length,
        repositoryCount: uniqueRepos.size,
        repositories: Array.from(uniqueRepos),
        deletedCount: syncResult.deletedIds.length,
        cleanupWarnings,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('repositories:sync-failed', { error: error instanceof Error ? error.message : String(error) });
    const errorMessage = error instanceof Error ? error.message : 'Failed to sync repositories';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
