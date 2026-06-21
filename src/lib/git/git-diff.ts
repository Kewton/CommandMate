/**
 * Git diff: commit-scoped diff + working-tree diff.
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 */

import { createLogger } from '@/lib/logger';
import { execFileAsync, execGitCommandTyped, GIT_LOG_TIMEOUT_MS } from './git-exec';
import { GitTimeoutError, GitNotRepoError } from './git-errors';

const logger = createLogger('git-diff');

/**
 * Get diff for a specific file in a commit
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param commitHash - Commit hash
 * @param filePath - Path to the file within the repository
 * @returns Unified diff string, or null if not found
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 * @throws {Error} For other git errors
 */
export async function getGitDiff(
  worktreePath: string,
  commitHash: string,
  filePath: string
): Promise<string | null> {
  try {
    const stdout = await execGitCommandTyped(
      ['show', commitHash, '--', filePath],
      worktreePath,
      GIT_LOG_TIMEOUT_MS
    );
    return stdout.trim() || null;
  } catch (error) {
    if (error instanceof GitTimeoutError || error instanceof GitNotRepoError) {
      throw error;
    }
    return null;
  }
}

/**
 * Working-tree diff mode (Issue #780).
 * - `staged`    -> `git diff --cached -- <file>` (index vs HEAD)
 * - `unstaged`  -> `git diff -- <file>`          (working tree vs index)
 * - `untracked` -> `git diff --no-index -- /dev/null <file>` (whole file as additions)
 */
export type WorkingTreeDiffMode = 'staged' | 'unstaged' | 'untracked';

/**
 * Build the git argv for a working-tree diff. The trailing `--` (always present)
 * blocks any pathspec/option injection via the file path. Static, mode-driven
 * flags only (no user-controlled flags), execFile-only (no shell).
 */
function buildWorkingTreeDiffArgs(filePath: string, mode: WorkingTreeDiffMode): string[] {
  switch (mode) {
    case 'staged':
      return ['diff', '--cached', '--', filePath];
    case 'untracked':
      // `--no-index` diffs an arbitrary path against /dev/null so the entire
      // (untracked) file is rendered as additions.
      return ['diff', '--no-index', '--', '/dev/null', filePath];
    case 'unstaged':
    default:
      return ['diff', '--', filePath];
  }
}

/**
 * Get the working-tree diff for a single file (Issue #780).
 *
 * Read-only. Reuses the 3s log/show/diff timeout (GIT_LOG_TIMEOUT_MS); it does
 * NOT use the 1s execGitCommand path. Always passes `--` before the path.
 *
 * IMPORTANT (`untracked` / `--no-index`): `git diff --no-index` exits with code
 * 1 whenever there IS a diff — which is the *normal* case for an untracked file.
 * execFile rejects on a non-zero exit, but the rejection carries the diff on
 * `error.stdout`. We therefore run the diff directly via execFileAsync (rather
 * than execGitCommandTyped, which discards stdout on error) so we can recover
 * that stdout. Genuine failures (timeout / not-a-repo) are still classified and
 * re-thrown as GitTimeoutError / GitNotRepoError so the API layer can map them.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param filePath - Repo-relative file path (caller MUST validate with isPathSafe)
 * @param mode - Which working-tree diff to produce
 * @returns Unified diff string, or null when there is no diff (clean file)
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 */
export async function getWorkingTreeDiff(
  worktreePath: string,
  filePath: string,
  mode: WorkingTreeDiffMode
): Promise<string | null> {
  const args = buildWorkingTreeDiffArgs(filePath, mode);

  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: worktreePath,
      timeout: GIT_LOG_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch (error) {
    const err = error as Error & {
      code?: string | number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };

    // Timeout -> GitTimeoutError (504). Check before the exit-1 recovery so a
    // killed/timed-out process is never mistaken for a "normal" --no-index diff.
    if (err.killed || err.code === 'ERR_CHILD_PROCESS_EXEC_TIMEOUT' || err.code === 'ETIMEDOUT') {
      throw new GitTimeoutError(`Git command timed out after ${GIT_LOG_TIMEOUT_MS}ms`);
    }

    // Not a git repository -> GitNotRepoError (400).
    const stderr = err.stderr || err.message || '';
    if (stderr.includes('not a git repository')) {
      throw new GitNotRepoError('Not a git repository');
    }

    // `git diff --no-index` exits 1 when a diff exists: recover the diff from
    // stdout. (Also covers any diff variant that signals "differences" via a
    // non-zero exit while still emitting the patch on stdout.)
    if (typeof err.stdout === 'string') {
      return err.stdout.trim() || null;
    }

    // Genuine failure with no recoverable diff.
    logger.error('git:working-diff-failed', {
      args: args.join(' '),
      error: err.message,
    });
    throw new Error('Failed to execute git command');
  }
}
