/**
 * Git worktree management
 * Scans and manages git worktrees
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { Worktree } from '@/types/models';
import type Database from 'better-sqlite3';
import { upsertWorktree } from './db';
import { getEnvByKey } from './env';

/**
 * Parsed worktree information from git
 */
interface ParsedWorktree {
  path: string;
  branch: string;
  commit: string;
}

/**
 * Generate URL-safe ID from repository name and branch name
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

  const sanitize = (str: string) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-') // Replace non-alphanumeric (except hyphen) with hyphen
      .replace(/-+/g, '-') // Replace consecutive hyphens with single hyphen
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

  const sanitizedBranch = sanitize(branchName);

  if (repositoryName) {
    const sanitizedRepo = sanitize(repositoryName);
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
 * Supports both WORKTREE_REPOS (comma-separated) and CM_ROOT_DIR (single path)
 *
 * @returns Array of repository root paths
 *
 * @example
 * ```typescript
 * // WORKTREE_REPOS="/path/to/repo1,/path/to/repo2"
 * getRepositoryPaths(); // => ['/path/to/repo1', '/path/to/repo2']
 *
 * // CM_ROOT_DIR="/path/to/repo"
 * getRepositoryPaths(); // => ['/path/to/repo']
 * ```
 */
export function getRepositoryPaths(): string[] {
  // Try WORKTREE_REPOS first (supports multiple repos)
  const worktreeRepos = process.env.WORKTREE_REPOS;
  if (worktreeRepos && worktreeRepos.trim()) {
    return worktreeRepos
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);
  }

  // Fallback to CM_ROOT_DIR / MCBD_ROOT_DIR (Issue #76: env fallback support)
  const rootDir = getEnvByKey('CM_ROOT_DIR');
  if (rootDir && rootDir.trim()) {
    return [rootDir.trim()];
  }

  return [];
}

/**
 * Scan git worktrees in a single repository
 *
 * @param rootDir - Root directory to scan for worktrees
 * @returns Array of Worktree objects
 *
 * @throws {Error} If git command fails (except for "not a git repository")
 *
 * @example
 * ```typescript
 * const worktrees = await scanWorktrees('/path/to/repo');
 * console.log(worktrees[0].id); // => "main"
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
      .map((wt) => ({
        id: generateWorktreeId(wt.branch, repositoryName),
        name: wt.branch,
        path: path.resolve(wt.path),
        repositoryPath,
        repositoryName,
      }))
      .filter((wt) => {
        // Git worktrees can be outside the repo root, so we use a more lenient validation
        // Only filter out obviously dangerous system paths
        const dangerousPaths = ['/etc', '/root', '/sys', '/proc', '/dev', '/boot', '/bin', '/sbin', '/usr/bin', '/usr/sbin'];
        const isDangerous = dangerousPaths.some(danger => wt.path.startsWith(danger));

        if (isDangerous) {
          console.warn(`Skipping potentially unsafe worktree path: ${wt.path}`);
          return false;
        }

        // Check for path traversal attempts in the path itself
        if (wt.path.includes('\x00') || wt.path.includes('..')) {
          console.warn(`Skipping path with potentially malicious characters: ${wt.path}`);
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
  const allWorktrees: Worktree[] = [];

  for (const repoPath of repositoryPaths) {
    try {
      console.log(`Scanning repository: ${repoPath}`);
      const worktrees = await scanWorktrees(repoPath);
      allWorktrees.push(...worktrees);
      console.log(`  Found ${worktrees.length} worktree(s)`);
    } catch (_error) {
      console.error(`Error scanning repository ${repoPath}:`, _error);
      // Continue with other repositories even if one fails
    }
  }

  return allWorktrees;
}

/**
 * Sync scanned worktrees to database
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
  worktrees: Worktree[]
): void {
  for (const worktree of worktrees) {
    upsertWorktree(db, worktree);
  }
}
