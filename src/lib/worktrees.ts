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

/**
 * Parsed worktree information from git
 */
interface ParsedWorktree {
  path: string;
  branch: string;
  commit: string;
}

/**
 * Generate URL-safe ID from branch name
 *
 * @param branchName - Git branch name (e.g., "feature/foo", "main")
 * @returns URL-safe ID (e.g., "feature-foo", "main")
 *
 * @example
 * ```typescript
 * generateWorktreeId('feature/foo') // => 'feature-foo'
 * generateWorktreeId('main') // => 'main'
 * generateWorktreeId('Feature/Foo') // => 'feature-foo'
 * ```
 */
export function generateWorktreeId(branchName: string): string {
  if (!branchName) {
    return '';
  }

  return branchName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-') // Replace non-alphanumeric (except hyphen) with hyphen
    .replace(/-+/g, '-') // Replace consecutive hyphens with single hyphen
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
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
 * Scan git worktrees in the root directory
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

    return parsed.map((wt) => ({
      id: generateWorktreeId(wt.branch),
      name: wt.branch,
      path: path.resolve(wt.path),
    }));
  } catch (error: any) {
    // If not a git repository, return empty array
    if (
      error.message?.includes('not a git repository') ||
      error.code === 128
    ) {
      return [];
    }

    // Re-throw other errors
    throw error;
  }
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
