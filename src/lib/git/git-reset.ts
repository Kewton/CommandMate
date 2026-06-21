/**
 * Git reset / revert (danger-zone write path).
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 */

import type { GitResetMode } from '@/types/git';
import { GIT_WRITE_TIMEOUT_MS } from '@/config/git-status-config';
import { createLogger } from '@/lib/logger';
import {
  execGitCommand,
  execGitCommandTyped,
  execGitConflictAware,
  runSerializedWrite,
  type ConflictResult,
} from './git-exec';
import { getDefaultBranch } from './git-default-branch';
import { GitResetDefaultBranchError } from './git-errors';

const logger = createLogger('git-reset');

/** Options for gitReset (Issue #782). */
export interface ResetOptions {
  target: string;
  mode: GitResetMode;
}

/**
 * Resolve whether the current branch is the default branch FOR THE PURPOSE OF
 * the hard-reset guard (Issue #782, S3-010).
 *
 * Issue #783 (DR1-001): default detection is consolidated through the shared
 * getDefaultBranch helper. INTENTIONAL ASYMMETRY vs. deleteBranch: when
 * origin/HEAD is unresolved (DEFAULT_BRANCH_UNRESOLVED), deleteBranch offers NO
 * protection, but hard reset conservatively treats `main` / `master` as default
 * and refuses — the destructiveness of a hard reset warrants the stronger
 * fallback. A "resolved-but-non-origin/" value (null) is NOT protected (matches
 * the original behavior; the fallback fires ONLY on true unresolution — DR1-002).
 */
async function isDefaultBranchForReset(worktreePath: string): Promise<boolean> {
  const current = await execGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  if (current === null) return false;
  const currentBranch = current.trim();

  const def = await getDefaultBranch(worktreePath);
  if (typeof def === 'string') return def === currentBranch; // origin/<name> resolved -> strict compare
  if (def === null) return false; // resolved but non-origin/ -> original behavior: NOT protected
  // def === DEFAULT_BRANCH_UNRESOLVED (symbolic-ref null) -> conservative
  // fallback (S3-010, byte-invariant): protect main/master only.
  return currentBranch === 'main' || currentBranch === 'master';
}

/**
 * Reset the current branch: `git reset --<mode> <target> --` (Issue #782, WRITE
 * path). The caller (route) validates `target` is `'HEAD'` or a COMMIT_HASH_PATTERN
 * hash and (for hard) confirms `confirmBranch` matches the current branch.
 *
 * SAFETY: a `hard` reset on the default branch is refused server-side
 * (GitResetDefaultBranchError -> 409 default_branch), independent of the UI
 * branch chip. Serialized per worktree; the trailing `--` blocks injection.
 *
 * @throws {GitResetDefaultBranchError} hard reset on the default branch
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function gitReset(worktreePath: string, options: ResetOptions): Promise<void> {
  const { target, mode } = options;

  // SAFETY guard (before the mutating call): never hard-reset the default branch.
  if (mode === 'hard') {
    const isDefault = await isDefaultBranchForReset(worktreePath);
    if (isDefault) {
      logger.warn('git:danger:hard-reset-blocked', {
        operation: 'reset',
        worktreePath,
        target,
        mode,
        timestamp: new Date().toISOString(),
      });
      throw new GitResetDefaultBranchError('Cannot hard-reset the default branch');
    }
    // Structured audit log for the (allowed) destructive hard reset.
    logger.warn('git:danger:hard-reset', {
      operation: 'reset',
      worktreePath,
      target,
      mode,
      timestamp: new Date().toISOString(),
    });
  }

  await runSerializedWrite(worktreePath, async () => {
    await execGitCommandTyped(
      ['reset', `--${mode}`, target, '--'],
      worktreePath,
      GIT_WRITE_TIMEOUT_MS
    );
  });
}

/** Options for gitRevert (Issue #782). */
export interface RevertOptions {
  commitHash: string;
  noCommit?: boolean;
}

/**
 * Revert a commit: `git revert [--no-commit] <hash> --` (Issue #782, WRITE path).
 * The caller (route) validates `commitHash` against COMMIT_HASH_PATTERN. A
 * conflict returns `{ conflict: true, conflictFiles }` (200) rather than throwing
 * (S3-002). With `noCommit`, the revert is left staged in the index (no commit).
 * Serialized per worktree; the trailing `--` blocks injection.
 */
export async function gitRevert(
  worktreePath: string,
  options: RevertOptions
): Promise<ConflictResult> {
  const { commitHash, noCommit } = options;

  logger.warn('git:danger:revert', {
    operation: 'revert',
    worktreePath,
    commitHash,
    noCommit: noCommit === true,
    timestamp: new Date().toISOString(),
  });

  return runSerializedWrite(worktreePath, async () => {
    const args = ['revert'];
    if (noCommit) args.push('--no-commit');
    args.push(commitHash, '--');
    return execGitConflictAware(args, worktreePath);
  });
}
