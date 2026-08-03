/**
 * Git worktree management
 * Scans and manages git worktrees
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { deriveWorktreeId, sanitizeIdSegment } from './worktree-id';
import type { Worktree } from '@/types/models';
import type Database from 'better-sqlite3';
import {
  upsertWorktree,
  getWorktreesByRepository,
  deleteWorktreesByIds,
  getRepositories,
  getAllWorktreeIds,
  getAliasedWorktreeIds,
} from '@/lib/db';
import { createLogger } from '@/lib/logger';

const logger = createLogger('worktrees');

/**
 * Result of syncing worktrees to database
 * Issue #526: Returns deletedIds for tmux session cleanup
 */
export interface SyncResult {
  /** IDs of worktrees that were deleted from the database */
  deletedIds: string[];
  /** Number of worktrees that were upserted */
  upsertedCount: number;
}

/**
 * Parsed worktree information from git
 */
interface ParsedWorktree {
  path: string;
  branch: string;
  commit: string;
}

/**
 * ID minting lives in `worktree-id.ts` — a module that imports nothing but
 * `crypto` and `path`. A migration has to mint IDs too (the Phase 4 renumbering
 * in #1645), and importing THIS module from one would close a cycle through
 * `@/lib/db` and inherit every `vi.mock('@/lib/git/worktrees')` in the suite.
 * Re-exported here so existing callers are unaffected.
 */
export { deriveWorktreeId } from './worktree-id';

/**
 * Generate URL-safe ID from repository name and branch name
 *
 * @deprecated Issue #1621/#1644: worktree IDs are no longer derived from the
 * branch. A branch-derived ID changes whenever the branch changes, so checking
 * out a different branch in the *same* directory renamed the worktree's primary
 * key and broke everything keyed on it outside the DB (tmux session names, open
 * tabs, bookmarks, poller/Auto-Yes keys). IDs are now derived from the directory
 * once — see {@link deriveWorktreeId} — and never re-derived.
 *
 * Retained only so an out-of-tree caller keeps compiling; nothing in `src/`
 * calls it any more.
 *
 * @param branchName - Git branch name (e.g., "feature/foo", "main")
 * @param repositoryName - Repository name (e.g., "MyRepo")
 * @returns URL-safe ID (e.g., "myrepo-feature-foo", "myrepo-main")
 *
 * @example
 * ```typescript
 * generateWorktreeId('feature/foo', 'MyRepo') // => 'myrepo-feature-foo'
 * generateWorktreeId('main', 'MyRepo') // => 'myrepo-main'
 * generateWorktreeId('Feature/Foo', 'Repo') // => 'repo-feature-foo'
 * ```
 */
export function generateWorktreeId(branchName: string, repositoryName?: string): string {
  if (!branchName) {
    return '';
  }

  const sanitizedBranch = sanitizeIdSegment(branchName);

  if (repositoryName) {
    const sanitizedRepo = sanitizeIdSegment(repositoryName);
    return `${sanitizedRepo}-${sanitizedBranch}`;
  }

  return sanitizedBranch;
}

/**
 * Parse git worktree list output
 *
 * @param output - Output from `git worktree list`
 * @returns Array of parsed worktree information
 *
 * @example
 * ```typescript
 * const output = `
 * /path/to/main abc123 [main]
 * /path/to/feature def456 [feature/foo]
 * `;
 * parseWorktreeOutput(output);
 * // => [
 * //   { path: '/path/to/main', branch: 'main', commit: 'abc123' },
 * //   { path: '/path/to/feature', branch: 'feature/foo', commit: 'def456' }
 * // ]
 * ```
 */
export function parseWorktreeOutput(output: string): ParsedWorktree[] {
  if (!output || output.trim() === '') {
    return [];
  }

  const lines = output.trim().split('\n');
  const worktrees: ParsedWorktree[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Format: /path/to/worktree commit [branch]
    // or:     /path/to/worktree commit (detached HEAD)
    const match = trimmed.match(/^(.+?)\s+([a-z0-9]+)\s+(?:\[(.+?)\]|\(detached HEAD\))/);

    if (match) {
      const [, pathStr, commit, branch] = match;
      worktrees.push({
        path: pathStr.trim(),
        branch: branch || `detached-${commit}`,
        commit,
      });
    }
  }

  return worktrees;
}

/**
 * Get repository paths from environment variables
 *
 * WORKTREE_REPOS (comma-separated) is the only source: it enumerates repository
 * roots explicitly, so every entry is a path `git worktree list` can run in.
 *
 * CM_ROOT_DIR is deliberately NOT consulted here (Issue #1328). It denotes the
 * managed scope — the directory that *contains* repositories — and is used as
 * the registration boundary (POST /api/repositories/scan) and the clone
 * destination (CloneManager). Those two treat it as a container; discovery
 * treated it as a single repository and passed it straight to `git worktree
 * list` as cwd, which returns nothing for any container directory. The two
 * readings are mutually exclusive, and the container reading is the one the
 * rest of the app enforces. Repositories under CM_ROOT_DIR are found by
 * registering them (UI scan or clone); callers scan the repositories table.
 *
 * @returns Array of repository root paths (empty when WORKTREE_REPOS is unset)
 *
 * @example
 * ```typescript
 * // WORKTREE_REPOS="/path/to/repo1,/path/to/repo2"
 * getRepositoryPaths(); // => ['/path/to/repo1', '/path/to/repo2']
 * ```
 */
export function getRepositoryPaths(): string[] {
  const worktreeRepos = process.env.WORKTREE_REPOS;
  if (worktreeRepos && worktreeRepos.trim()) {
    return worktreeRepos
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);
  }

  return [];
}

/**
 * Scan git worktrees in a single repository
 *
 * Issue #1621: the `id` on each returned object is a **provisional** suggestion,
 * not the worktree's identity. The scan cannot know which IDs are already taken
 * (it sees one repository, IDs are global) and — more importantly — it must not
 * decide the ID of a directory that is already registered. {@link syncWorktreesToDB}
 * is what confirms an ID: it keeps the existing row's ID when the path is known,
 * and only falls back to this suggestion (or re-derives) for a new path.
 *
 * The field is still populated, rather than dropped from the type, because two
 * callers outside this change's reach — `POST /api/repositories/scan`,
 * `POST /api/repositories/restore` and `syncWorktreesAndCleanup`
 * (`src/lib/session-cleanup.ts`) — are typed on `Worktree[]`.
 *
 * `name` is the **display branch name** and is refreshed on every sync; for a
 * detached HEAD it is `detached-<short sha>` (see {@link parseWorktreeOutput}).
 * Neither `name` nor `branch` participates in the ID any more.
 *
 * @param rootDir - Root directory to scan for worktrees
 * @returns Array of Worktree objects
 *
 * @throws {Error} If git command fails (except for "not a git repository")
 *
 * @example
 * ```typescript
 * const worktrees = await scanWorktrees('/path/to/repo');
 * console.log(worktrees[0].path); // => "/path/to/repo"
 * ```
 */
export async function scanWorktrees(rootDir: string): Promise<Worktree[]> {
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync('git worktree list', {
      cwd: rootDir,
    });

    const parsed = parseWorktreeOutput(stdout);

    // Get repository name from path
    const repositoryPath = path.resolve(rootDir);
    const repositoryName = path.basename(repositoryPath);

    // Filter and validate worktree paths
    return parsed
      .map((wt) => {
        const resolvedPath = path.resolve(wt.path);
        return {
          // Provisional only — syncWorktreesToDB decides the real ID (see above).
          id: deriveWorktreeId(resolvedPath),
          // Display branch name (Issue #1621): re-read from git on every scan.
          name: wt.branch,
          // Issue #1003: persist the real branch (sync-time snapshot) so
          // `ls --branch` can filter on it rather than the derived name/id slug.
          branch: wt.branch,
          path: resolvedPath,
          repositoryPath,
          repositoryName,
        };
      })
      .filter((wt) => {
        // Git worktrees can be outside the repo root, so we use a more lenient validation
        // Only filter out obviously dangerous system paths
        const dangerousPaths = ['/etc', '/root', '/sys', '/proc', '/dev', '/boot', '/bin', '/sbin', '/usr/bin', '/usr/sbin'];
        const isDangerous = dangerousPaths.some(danger => wt.path.startsWith(danger));

        if (isDangerous) {
          logger.warn('worktree:unsafe-path-skipped', { path: wt.path });
          return false;
        }

        // Check for path traversal attempts in the path itself
        if (wt.path.includes('\x00') || wt.path.includes('..')) {
          logger.warn('worktree:malicious-path-skipped', { path: wt.path });
          return false;
        }

        return true;
      });
  } catch (error: unknown) {
    // If not a git repository, return empty array
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: number }).code;
    if (
      errorMessage?.includes('not a git repository') ||
      errorCode === 128
    ) {
      return [];
    }

    // Re-throw other errors
    throw error;
  }
}

/**
 * Scan git worktrees in multiple repositories
 *
 * @param repositoryPaths - Array of repository root paths
 * @returns Array of all Worktree objects from all repositories
 *
 * @example
 * ```typescript
 * const repos = ['/path/to/repo1', '/path/to/repo2'];
 * const worktrees = await scanMultipleRepositories(repos);
 * ```
 */
export async function scanMultipleRepositories(
  repositoryPaths: string[]
): Promise<Worktree[]> {
  // Issue #711: Parallelize per-repository scans. Each `git worktree list`
  // spawns an independent child process, so there is no contention between
  // repositories. allSettled preserves the prior "one failure does not abort
  // the rest" semantics.
  const results = await Promise.allSettled(
    repositoryPaths.map(async (repoPath) => {
      logger.info('repository:scan-start', { repoPath });
      const worktrees = await scanWorktrees(repoPath);
      logger.info('repository:scan-complete', { repoPath, worktreeCount: worktrees.length });
      return worktrees;
    })
  );

  const allWorktrees: Worktree[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allWorktrees.push(...result.value);
    } else {
      logger.error('repository:scan-failed', {
        repoPath: repositoryPaths[i],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  return allWorktrees;
}

/**
 * A worktree as observed by a scan: identical to {@link Worktree} except that
 * `id` is optional and, when present, only a *suggestion*.
 *
 * Issue #1621: the path is the identity. `syncWorktreesToDB` resolves the ID in
 * this order, and the first rule is the whole point of the change:
 *
 * 1. the ID already stored for this **path** — keeps a registered worktree's ID
 *    frozen no matter what its branch (or the derivation rule) does;
 * 2. the caller's suggested `id`, when nothing else holds it;
 * 3. {@link deriveWorktreeId} against the live set of taken IDs.
 */
export type ScannedWorktree = Omit<Worktree, 'id'> & { id?: string };

/**
 * Sync scanned worktrees to database
 *
 * This function performs a true sync:
 * 1. Groups worktrees by repository
 * 2. For each repository, removes worktrees that no longer exist
 * 3. Resolves each worktree's ID (existing row by path wins — Issue #1621)
 * 4. Upserts all current worktrees, refreshing the display branch name
 *
 * @param db - Database instance
 * @param worktrees - Array of worktrees to sync
 *
 * @example
 * ```typescript
 * const worktrees = await scanWorktrees('/path/to/repo');
 * syncWorktreesToDB(db, worktrees);
 * ```
 */
export function syncWorktreesToDB(
  db: Database.Database,
  worktrees: ScannedWorktree[]
): SyncResult {
  // If no worktrees provided, do nothing (avoid accidentally deleting all data)
  // SF-C01: Return empty SyncResult instead of void
  if (worktrees.length === 0) {
    return { deletedIds: [], upsertedCount: 0 };
  }

  const allDeletedIds: string[] = [];
  let upsertedCount = 0;

  // Group worktrees by repository path
  const worktreesByRepo = new Map<string, ScannedWorktree[]>();
  for (const worktree of worktrees) {
    const repoPath = worktree.repositoryPath || '';
    if (!worktreesByRepo.has(repoPath)) {
      worktreesByRepo.set(repoPath, []);
    }
    worktreesByRepo.get(repoPath)!.push(worktree);
  }

  // IDs are a GLOBAL primary key, so collision detection has to look at every
  // repository, not just the one being synced. `takenIds` also absorbs the IDs
  // handed out earlier in this same run, so two directories that share a
  // basename across repositories cannot both claim it (which would violate the
  // UNIQUE(path) constraint on the second upsert).
  //
  // Historical IDs count as taken too (Issue #1621, Phase 2): an alias still
  // answers requests, so minting a live worktree with an ID some alias redirects
  // elsewhere would shadow that redirect and silently send old bookmarks to the
  // wrong worktree.
  const takenIds = new Set([...getAllWorktreeIds(db), ...getAliasedWorktreeIds(db)]);

  // Process each repository
  for (const [repoPath, repoWorktrees] of worktreesByRepo) {
    if (!repoPath) continue;

    // Get current worktree rows (id + path) in DB for this repository
    const existingRows = getWorktreesByRepository(db, repoPath);

    // Issue #1151: prune by on-disk PATH, not by ID — only a worktree whose
    // PATH is gone from the scan was genuinely removed. Issue #1621 makes the
    // same principle the rule for *identity* as well, not just for pruning.
    const newPaths = new Set(repoWorktrees.map(wt => path.resolve(wt.path)));

    // Find worktrees that no longer exist on disk (genuinely deleted)
    const deletedIds = existingRows
      .filter(row => !newPaths.has(path.resolve(row.path)))
      .map(row => row.id);

    // Delete removed worktrees from DB
    if (deletedIds.length > 0) {
      const result = deleteWorktreesByIds(db, deletedIds);
      allDeletedIds.push(...deletedIds);
      // Their IDs are free again (and their alias rows went with them).
      for (const deletedId of deletedIds) takenIds.delete(deletedId);
      logger.info('worktree:cleanup', { deletedCount: result.deletedCount });
    }

    // Issue #1621: the ID a path already owns is the ID it keeps.
    const idByPath = new Map(
      existingRows
        .filter(row => newPaths.has(path.resolve(row.path)))
        .map(row => [path.resolve(row.path), row.id] as const)
    );

    // Upsert current worktrees
    for (const worktree of repoWorktrees) {
      const resolvedPath = path.resolve(worktree.path);
      const existingId = idByPath.get(resolvedPath);
      const suggestedId = worktree.id;
      const id =
        existingId ??
        (suggestedId && !takenIds.has(suggestedId)
          ? suggestedId
          : deriveWorktreeId(resolvedPath, takenIds));
      takenIds.add(id);

      upsertWorktree(db, {
        ...worktree,
        id,
        // Issue #1621: `name` is the display branch name. The branch no longer
        // feeds the ID, so this is the only place it surfaces — refresh it from
        // the scan every time (a checkout must move the label, not the key).
        name: worktree.branch ?? worktree.name,
      });
      upsertedCount++;
    }
  }

  return { deletedIds: allDeletedIds, upsertedCount };
}

/**
 * Whether a repository still exists on disk as a git working tree.
 *
 * Returns `false` only when the directory itself is gone OR its `.git` entry is
 * missing (a de-gitified directory). Every other state — including a present
 * directory whose `.git` is intact — is reported as "still there", so a
 * transient git failure (a locked index, a momentarily-unavailable network
 * drive whose mount point is still present, …) never satisfies the prune
 * condition. Issue #1349: fall on the side of NOT pruning whenever the on-disk
 * state is inconclusive.
 *
 * @param repoPath - Canonical repository path (as stored in
 *   `worktrees.repository_path`, i.e. already `path.resolve()`d by
 *   {@link scanWorktrees}; see #1347)
 * @returns `true` if the repository still looks present on disk
 */
export function repositoryExistsOnDisk(repoPath: string): boolean {
  if (!repoPath) return false;
  try {
    return fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));
  } catch {
    // Inconclusive filesystem read (e.g. EACCES): be conservative and keep rows.
    return true;
  }
}

/**
 * Prune DB worktree rows for repositories that have vanished from disk.
 *
 * Issue #1349: when a repository directory is deleted or de-gitified,
 * {@link scanWorktrees} returns `[]` (git exit 128), so the repository silently
 * drops out of the scan and {@link syncWorktreesToDB} never reaches its per-repo
 * prune for it — the rows linger as ghost entries in the sidebar. The global
 * early-return in `syncWorktreesToDB` only fires when *every* repository is
 * empty, so a single vanished repository among healthy ones is never cleaned up.
 *
 * This runs as the global-sync reconciliation step: it enumerates every
 * `repository_path` that still owns worktree rows and, for those that produced
 * no worktrees in the current scan, deletes the rows **only when the repository
 * directory (or its `.git`) is genuinely gone** (see
 * {@link repositoryExistsOnDisk}). A repository that still exists but merely
 * errored in git is left untouched, so a transient failure — a network drive
 * blip, a locked repo — never destroys history.
 *
 * Intended for the full-scan endpoint (`POST /api/repositories/sync`) only.
 * Single-repository callers (scan/restore) must NOT run this: they hold no
 * authority over repositories outside their own scan, and running it there would
 * prune repositories that merely weren't part of that request.
 *
 * Row keys stay consistent with #1347: {@link getRepositories} returns the
 * stored (already `path.resolve()`d) `repository_path`, and every subsequent DB
 * and filesystem lookup uses that same canonical value.
 *
 * @param db - Database instance
 * @param liveWorktrees - Worktrees produced by the current scan; their
 *   repositories are known-present and therefore skipped
 * @returns IDs of worktrees deleted for vanished repositories
 */
export function pruneStaleRepositoryWorktrees(
  db: Database.Database,
  liveWorktrees: Worktree[]
): string[] {
  // Repositories that produced at least one worktree this scan are alive by
  // definition (git listed them), so they are never candidates for pruning.
  const liveRepoPaths = new Set(
    liveWorktrees
      .map(wt => wt.repositoryPath)
      .filter((p): p is string => !!p)
  );

  const deletedIds: string[] = [];

  for (const repo of getRepositories(db)) {
    const repoPath = repo.path;
    if (!repoPath) continue;
    if (liveRepoPaths.has(repoPath)) continue;
    // Conservative guard: keep rows unless the directory/.git is truly gone.
    if (repositoryExistsOnDisk(repoPath)) continue;

    const ids = getWorktreesByRepository(db, repoPath).map(row => row.id);
    if (ids.length === 0) continue;

    const result = deleteWorktreesByIds(db, ids);
    deletedIds.push(...ids);
    logger.info('worktree:stale-repo-pruned', {
      repoPath,
      deletedCount: result.deletedCount,
    });
  }

  return deletedIds;
}
