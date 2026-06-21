/**
 * Git network operations: fetch / pull / push.
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 *
 * stderr -> typed-error classification lives in git-errors.ts
 * (classifyNetworkStderr) and is applied inside the git-exec network helpers, so
 * no credential-bearing stderr is ever logged or echoed here.
 */

import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_PULL_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
} from '@/config/git-status-config';
import { createLogger } from '@/lib/logger';
import {
  execGitConflictAware,
  execGitNetworkAware,
  runSerializedWrite,
  type ConflictResult,
} from './git-exec';
import { resolveDefaultBranchName } from './git-default-branch';
import { GitProtectedBranchError } from './git-errors';

const logger = createLogger('git-remote');

/** Options for gitFetch (Issue #783). */
export interface FetchOptions {
  remote?: string;
  prune?: boolean;
}

/**
 * Fetch from a remote: `git fetch [--prune] <remote> --` (Issue #783).
 *
 * NOT serialized (§6.1): fetch writes only remote-tracking refs / packed-refs
 * (git locks packed-refs itself) and never touches the index or working tree, so
 * it is exempt from runSerializedWrite. `remote` is validated by the route
 * (validateGitBranchName) and the trailing `--` blocks pathspec injection.
 *
 * @throws {GitAuthFailedError | GitNetworkError | ...} classified network errors
 * @throws {GitTimeoutError | GitNotRepoError} infra errors
 */
export async function gitFetch(worktreePath: string, options: FetchOptions): Promise<void> {
  const { remote = 'origin', prune } = options;
  const args = ['fetch'];
  if (prune) args.push('--prune');
  args.push(remote, '--');
  await execGitNetworkAware(args, worktreePath, GIT_FETCH_TIMEOUT_MS);
}

/** Options for gitPull (Issue #783). */
export interface PullOptions {
  remote?: string;
  branch?: string;
  rebase?: boolean;
  ffOnly?: boolean;
}

/**
 * Pull from a remote: `git pull [--rebase] [--ff-only] <remote> <branch> --`
 * (Issue #783). Serialized per worktree (rewrites HEAD / working tree). A merge
 * or rebase conflict returns `{ conflict: true, conflictFiles }` (200) rather
 * than throwing, via execGitConflictAware with GIT_PULL_TIMEOUT_MS (S3-003).
 *
 * DR4-002: the network-generic failure path classifies the stderr into a typed
 * error WITHOUT logging the raw message (classifyNetwork=true), so a credential-
 * bearing remote URL in git stderr is never logged.
 */
export async function gitPull(
  worktreePath: string,
  options: PullOptions
): Promise<ConflictResult> {
  const { remote = 'origin', branch, rebase, ffOnly } = options;
  return runSerializedWrite(worktreePath, async () => {
    const args = ['pull'];
    if (rebase) args.push('--rebase');
    if (ffOnly) args.push('--ff-only');
    args.push(remote);
    if (branch) args.push(branch);
    args.push('--');
    return execGitConflictAware(args, worktreePath, GIT_PULL_TIMEOUT_MS, true);
  });
}

/** Options for gitPush (Issue #783). */
export interface PushOptions {
  remote?: string;
  branch: string;
  force?: boolean;
  forceWithLease?: boolean;
  setUpstream?: boolean;
}

/**
 * Push to a remote (Issue #783). Serialized per worktree (the remote update is a
 * write; sibling writes queue behind it).
 *
 * DR4-004 (Must Fix): push uses a SERVER-CONSTRUCTED explicit refspec
 * `<branch>:refs/heads/<branch>` so the destination ref is deterministic and
 * does NOT depend on `push.default` / the branch's upstream. The default-branch
 * force-push protection compares THIS destination branch against
 * resolveDefaultBranchName — never the (config-resolved) upstream. A bare
 * `git push --force` (no refspec) is never emitted.
 *
 * Protection is NON-symmetric vs reset (§4.2.1): when the default branch is
 * unresolved (resolveDefaultBranchName === null) the force push is ALLOWED.
 * `--force-with-lease` takes priority when both force flags are set.
 *
 * @throws {GitProtectedBranchError} force push targeting the default branch
 * @throws {GitNonFastForwardError | GitForceWithLeaseStaleError | GitAuthFailedError
 *   | GitNetworkError | GitTimeoutError | GitNotRepoError | GitIndexLockedError}
 */
export async function gitPush(worktreePath: string, options: PushOptions): Promise<void> {
  const { remote = 'origin', branch, force, forceWithLease, setUpstream } = options;

  // DR4-004: force-push protection on the EXPLICIT destination branch.
  if (force || forceWithLease) {
    const defaultName = await resolveDefaultBranchName(worktreePath);
    if (defaultName !== null && defaultName === branch) {
      throw new GitProtectedBranchError();
    }
    // Structured audit log for the (allowed) destructive force push. NO remote
    // URL / credentials — only worktreePath / branch / timestamp (DR4-002).
    logger.warn('git:danger:force-push', {
      operation: 'push',
      worktreePath,
      branch,
      forceWithLease: forceWithLease === true,
      timestamp: new Date().toISOString(),
    });
  }

  await runSerializedWrite(worktreePath, async () => {
    const args = ['push'];
    if (forceWithLease) args.push('--force-with-lease');
    else if (force) args.push('--force');
    if (setUpstream) args.push('-u');
    // Server-constructed explicit refspec: the `:` is built from a validated
    // branch name (the route rejects user-supplied `:` via validateGitBranchName),
    // so this is injection-free and pins the destination ref.
    args.push(remote, `${branch}:refs/heads/${branch}`, '--');
    await execGitNetworkAware(args, worktreePath, GIT_PUSH_TIMEOUT_MS);
  });
}
