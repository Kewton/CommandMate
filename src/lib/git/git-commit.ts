/**
 * Git stage / unstage / commit (write path).
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 *
 * All ops are serialized per worktree (runSerializedWrite) and `--`-terminated.
 */

import { GIT_WRITE_TIMEOUT_MS } from '@/config/git-status-config';
import { execGitCommandTyped, runSerializedWrite } from './git-exec';
import { GitNothingToCommitError } from './git-errors';

/**
 * Stage files: `git add -- <files>` (Issue #780).
 * Serialized per worktree; throws GitIndexLockedError if the index is locked.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param files - Relative file paths to stage (caller MUST validate with isPathSafe)
 * @throws {GitIndexLockedError} When `.git/index.lock` exists
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 */
export async function stageFiles(worktreePath: string, files: string[]): Promise<void> {
  await runSerializedWrite(worktreePath, async () => {
    await execGitCommandTyped(
      ['add', '--', ...files],
      worktreePath,
      GIT_WRITE_TIMEOUT_MS
    );
  });
}

/**
 * Unstage files: `git restore --staged -- <files>` (Issue #780).
 * Serialized per worktree; throws GitIndexLockedError if the index is locked.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param files - Relative file paths to unstage (caller MUST validate with isPathSafe)
 * @throws {GitIndexLockedError} When `.git/index.lock` exists
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 */
export async function unstageFiles(worktreePath: string, files: string[]): Promise<void> {
  await runSerializedWrite(worktreePath, async () => {
    await execGitCommandTyped(
      ['restore', '--staged', '--', ...files],
      worktreePath,
      GIT_WRITE_TIMEOUT_MS
    );
  });
}

/**
 * Create a commit: `git commit -m <message> [--amend] --` (Issue #780).
 * Serialized per worktree; throws GitIndexLockedError if the index is locked.
 * The trailing `--` blocks any pathspec / option injection. The message is
 * passed as a single argv element so embedded newlines are preserved verbatim.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param message - Commit message (caller MUST validate length / control chars)
 * @param amend - When true, amends the previous commit
 * @throws {GitNothingToCommitError} When git reports nothing to commit
 * @throws {GitIndexLockedError} When `.git/index.lock` exists
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 */
export async function gitCommit(
  worktreePath: string,
  message: string,
  amend: boolean
): Promise<void> {
  await runSerializedWrite(worktreePath, async () => {
    const args = ['commit', '-m', message];
    if (amend) {
      args.push('--amend');
    }
    args.push('--');
    try {
      await execGitCommandTyped(args, worktreePath, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
      // Normalize "nothing to commit" into a typed 400-mappable error.
      const msg = error instanceof Error ? error.message : '';
      if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(msg)) {
        throw new GitNothingToCommitError('Nothing to commit');
      }
      throw error;
    }
  });
}
