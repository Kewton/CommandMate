/**
 * API Route: POST /api/repositories/sync
 * Re-scans all configured repositories and syncs worktrees to database
 * Issue #190: Filter excluded repositories before scanning
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getRepositoryPaths, scanMultipleRepositories, syncWorktreesToDB } from '@/lib/worktrees';
import { registerAndFilterRepositories, resolveRepositoryPath } from '@/lib/db-repository';
import { getWorktreeIdsByRepository, deleteWorktreesByIds } from '@/lib/db';

export async function POST() {
  try {
    // Get configured repository paths from environment
    const repositoryPaths = getRepositoryPaths();

    if (repositoryPaths.length === 0) {
      return NextResponse.json(
        { error: 'No repositories configured. Please set WORKTREE_REPOS or CM_ROOT_DIR environment variable.' },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Issue #190/#202: Register environment variable repositories and filter out excluded ones
    // registerAndFilterRepositories() encapsulates the ordering constraint
    const { filteredPaths, excludedPaths } = registerAndFilterRepositories(db, repositoryPaths);

    // Issue #202: Remove worktrees of excluded repositories from DB
    // Without this, worktree records remain in DB and appear in the UI
    for (const excludedPath of excludedPaths) {
      const resolvedPath = resolveRepositoryPath(excludedPath);
      const worktreeIds = getWorktreeIdsByRepository(db, resolvedPath);
      if (worktreeIds.length > 0) {
        deleteWorktreesByIds(db, worktreeIds);
      }
    }

    // Scan filtered repositories (excluded repos are skipped)
    const allWorktrees = await scanMultipleRepositories(filteredPaths);

    // Sync to database
    syncWorktreesToDB(db, allWorktrees);

    // Get unique repository count
    const uniqueRepos = new Set(allWorktrees.map(wt => wt.repositoryPath));

    return NextResponse.json(
      {
        success: true,
        message: `Successfully synced ${allWorktrees.length} worktree(s) from ${uniqueRepos.size} repository/repositories`,
        worktreeCount: allWorktrees.length,
        repositoryCount: uniqueRepos.size,
        repositories: Array.from(uniqueRepos),
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error('Error syncing repositories:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to sync repositories';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
