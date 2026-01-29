/**
 * API Route: POST /api/repositories/sync
 * Re-scans all configured repositories and syncs worktrees to database
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getRepositoryPaths, scanMultipleRepositories, syncWorktreesToDB } from '@/lib/worktrees';

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

    // Scan all repositories
    const allWorktrees = await scanMultipleRepositories(repositoryPaths);

    // Sync to database
    const db = getDbInstance();
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
