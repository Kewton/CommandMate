/**
 * API Route: POST /api/repositories/sync
 * Re-scans all configured repositories and syncs worktrees to database
 * Issue #190: Filter excluded repositories before scanning
 * Issue #490: Include DB-registered repositories (e.g. cloned repos) in scan
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRepositoryPaths, scanMultipleRepositories, pruneStaleRepositoryWorktrees } from '@/lib/git/worktrees';
import { registerAndFilterRepositories, getAllRepositories } from '@/lib/db/db-repository';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories-sync');

/**
 * 400 body when nothing is registered yet (Issue #3093).
 *
 * The old wording told the reader to set `CM_ROOT_DIR`, which
 * `getRepositoryPaths()` never reads — a first-time user who had it set was
 * sent to fix something that was already right. Repositories come from the
 * DB (Web UI) or `WORKTREE_REPOS`, so name exactly those two.
 */
const NO_REPOSITORIES_MESSAGE =
  'No repositories are registered yet. Add one in the Web UI (Repositories → Add Repository), ' +
  'or list repository paths in WORKTREE_REPOS (comma-separated) and restart the server. ' +
  'Then run `commandmate sync` again.';

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
        { error: NO_REPOSITORIES_MESSAGE },
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

    // Issue #1349: a deleted / de-gitified repository scans to [] (git exit 128),
    // so its worktree rows never reach syncWorktreesToDB's per-repo prune and
    // linger as ghost rows in the sidebar. Reconcile them here — on the global
    // sync, which is the only caller with authority over every repository —
    // deleting rows only for repositories whose directory is genuinely gone.
    const staleDeletedIds = pruneStaleRepositoryWorktrees(db, allWorktrees);

    // Get unique repository count
    const uniqueRepos = new Set(allWorktrees.map(wt => wt.repositoryPath));

    return NextResponse.json(
      {
        success: true,
        message: `Successfully synced ${allWorktrees.length} worktree(s) from ${uniqueRepos.size} repository/repositories`,
        worktreeCount: allWorktrees.length,
        repositoryCount: uniqueRepos.size,
        repositories: Array.from(uniqueRepos),
        deletedCount: syncResult.deletedIds.length + staleDeletedIds.length,
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
