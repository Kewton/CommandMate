/**
 * Git typed errors + API error mapping + network-stderr classification.
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 *
 * Leaf module: depends only on next/server + logger. The exec layer
 * (git-exec.ts) and every feature module import their typed errors from here,
 * and `git-utils.ts` re-exports this barrel-style for backward compatibility.
 *
 * Security considerations:
 * - handleGitApiError / classifyNetworkStderr never echo raw git stderr (which
 *   may carry credential-bearing remote URLs or absolute paths) into the HTTP
 *   body or the thrown error message. See the per-class notes below.
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';

const logger = createLogger('git-errors');

/**
 * Custom error class for git command timeout
 * Used by API layer to distinguish 504 (timeout) from 500 (general error)
 */
export class GitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitTimeoutError';
  }
}

/**
 * Custom error class for "not a git repository" errors
 */
export class GitNotRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitNotRepoError';
  }
}

/**
 * Custom error class for "git index locked" errors (Issue #780).
 * Thrown when `.git/index.lock` exists before a write op, or when an in-process
 * write for the same worktree is still running. The API layer maps this to 409.
 */
export class GitIndexLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitIndexLockedError';
  }
}

/**
 * Custom error class for the "nothing to commit" condition (Issue #780).
 * The API layer maps this to 400.
 */
export class GitNothingToCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitNothingToCommitError';
  }
}

// ============================================================================
// Issue #781: branch-operation typed errors
// ============================================================================

/** A branch named in a checkout/delete does not exist (-> 404 branch_not_found). */
export class GitBranchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitBranchNotFoundError';
  }
}

/** `git branch -d` refused because the branch is not fully merged (-> 409 not_merged). */
export class GitBranchNotMergedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitBranchNotMergedError';
  }
}

/**
 * The requested branch is checked out in another worktree (-> 409
 * checked_out_elsewhere). Carries the occupying worktree's path; NOT bypassable
 * with force.
 */
export class GitBranchCheckedOutElsewhereError extends Error {
  /** Absolute path of the worktree that already has the branch checked out. */
  readonly worktreePath: string;
  constructor(message: string, worktreePath: string) {
    super(message);
    this.name = 'GitBranchCheckedOutElsewhereError';
    this.worktreePath = worktreePath;
  }
}

/** A non-force checkout was attempted over a dirty working tree (-> 409 dirty). */
export class GitDirtyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitDirtyError';
  }
}

/** Attempted to delete the currently checked-out branch (-> 409 current_branch). */
export class GitCurrentBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitCurrentBranchError';
  }
}

/** Attempted to delete the default branch (origin/HEAD) (-> 409 default_branch). */
export class GitDefaultBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitDefaultBranchError';
  }
}

// ============================================================================
// Issue #782: stash + reset/revert typed errors
// ============================================================================

/**
 * `git stash push` found no local changes to save (-> 400 nothing_to_stash).
 * Normalized from the "No local changes to save" stderr, mirroring how
 * GitNothingToCommitError normalizes "nothing to commit" (#780).
 */
export class GitNothingToStashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitNothingToStashError';
  }
}

/**
 * A hard reset was refused because the current branch is the default branch
 * (-> 409 default_branch). DELIBERATELY SEPARATE from GitDefaultBranchError
 * (S3-001(b)): the latter's body is the delete-specific "Cannot delete the
 * default branch", which would mislead a reset caller. A dedicated class keeps
 * the #781 delete reason body byte-identical while letting reset return a
 * reset-appropriate message under the same `reason: 'default_branch'`.
 */
export class GitResetDefaultBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitResetDefaultBranchError';
  }
}

// ============================================================================
// Issue #783: network-operation typed errors (push / pull / fetch).
//
// DR4-003: each is constructed with NO stderr/message argument that gets echoed.
// handleGitApiError maps each to a FIXED literal body (it never echoes
// error.message), so raw git stderr — which may contain credential-bearing URLs
// or absolute paths — never reaches the HTTP body. The default Error message is
// a static label only.
// ============================================================================

/** Remote rejected the credentials (-> 401 auth_failed). */
export class GitAuthFailedError extends Error {
  constructor() {
    super('Authentication failed');
    this.name = 'GitAuthFailedError';
  }
}

/** Push rejected because it was not a fast-forward (-> 409 non_fast_forward). */
export class GitNonFastForwardError extends Error {
  constructor() {
    super('Non-fast-forward');
    this.name = 'GitNonFastForwardError';
  }
}

/** The branch has no upstream configured (-> 400 no_upstream). */
export class GitNoUpstreamError extends Error {
  constructor() {
    super('No upstream');
    this.name = 'GitNoUpstreamError';
  }
}

/**
 * A force push targeted the default branch (-> 409 protected_branch).
 * DELIBERATELY a SEPARATE reason from `default_branch` (delete/reset): push can
 * target an ARBITRARY branch via the `branch?` arg (delete/reset have fixed
 * "delete-target / current-branch" semantics), so its protection trigger and
 * meaning differ — a distinct reason lets the UI/acceptance criteria diverge
 * (DR1-008).
 */
export class GitProtectedBranchError extends Error {
  constructor() {
    super('Protected branch');
    this.name = 'GitProtectedBranchError';
  }
}

/** `--force-with-lease` refused because the remote moved (-> 409 force_with_lease_stale). */
export class GitForceWithLeaseStaleError extends Error {
  constructor() {
    super('Stale info');
    this.name = 'GitForceWithLeaseStaleError';
  }
}

/** Could not reach / resolve the remote (-> 502 network). */
export class GitNetworkError extends Error {
  constructor() {
    super('Network error');
    this.name = 'GitNetworkError';
  }
}

/**
 * Handle git-related errors in API routes and return appropriate NextResponse.
 * Centralizes the error-to-HTTP-status mapping for GitNotRepoError, GitTimeoutError,
 * and generic errors.
 *
 * @param error - The caught error
 * @param logPrefix - Prefix for the console.error log message
 * @returns NextResponse with the appropriate status code and error message
 */
export function handleGitApiError(error: unknown, logPrefix: string): NextResponse {
  if (error instanceof GitNotRepoError) {
    return NextResponse.json(
      { error: 'Not a git repository' },
      { status: 400 }
    );
  }
  // Issue #780: index.lock held by a concurrent git process -> 409 Conflict
  if (error instanceof GitIndexLockedError) {
    return NextResponse.json(
      { error: 'Git index is locked by another operation' },
      { status: 409 }
    );
  }
  // Issue #780: nothing staged to commit -> 400 (client retry-able)
  if (error instanceof GitNothingToCommitError) {
    return NextResponse.json(
      { error: 'Nothing to commit' },
      { status: 400 }
    );
  }
  // Issue #781: branch-operation failures carry a machine-readable `reason`.
  if (error instanceof GitBranchNotFoundError) {
    return NextResponse.json(
      { error: 'Branch not found', reason: 'branch_not_found' },
      { status: 404 }
    );
  }
  if (error instanceof GitBranchNotMergedError) {
    return NextResponse.json(
      { error: 'Branch is not fully merged', reason: 'not_merged' },
      { status: 409 }
    );
  }
  if (error instanceof GitCurrentBranchError) {
    return NextResponse.json(
      { error: 'Cannot operate on the current branch', reason: 'current_branch' },
      { status: 409 }
    );
  }
  if (error instanceof GitDefaultBranchError) {
    return NextResponse.json(
      { error: 'Cannot delete the default branch', reason: 'default_branch' },
      { status: 409 }
    );
  }
  if (error instanceof GitDirtyError) {
    return NextResponse.json(
      { error: 'Working tree has uncommitted changes', reason: 'dirty' },
      { status: 409 }
    );
  }
  if (error instanceof GitBranchCheckedOutElsewhereError) {
    return NextResponse.json(
      {
        error: 'Branch is checked out in another worktree',
        reason: 'checked_out_elsewhere',
        worktreePath: error.worktreePath,
      },
      { status: 409 }
    );
  }
  // Issue #782 (additive, BEFORE the GitTimeoutError branch so #780/#781 reason
  // bodies above stay byte-identical): danger-zone reasons.
  if (error instanceof GitNothingToStashError) {
    return NextResponse.json(
      { error: 'No local changes to stash', reason: 'nothing_to_stash' },
      { status: 400 }
    );
  }
  if (error instanceof GitResetDefaultBranchError) {
    return NextResponse.json(
      { error: 'Cannot hard-reset the default branch', reason: 'default_branch' },
      { status: 409 }
    );
  }
  // Issue #783 (additive, AFTER all existing branches and BEFORE GitTimeoutError
  // so #780-#782 reason bodies above stay byte-identical — DR2-005 relative-order
  // contract). DR4-003: each returns a FIXED literal body that never echoes
  // error.message, so credential-bearing stderr / absolute paths never leak.
  if (error instanceof GitAuthFailedError) {
    return NextResponse.json(
      { error: 'Authentication failed; configure credentials in the terminal', reason: 'auth_failed' },
      { status: 401 }
    );
  }
  if (error instanceof GitNonFastForwardError) {
    return NextResponse.json(
      { error: 'Push rejected (non-fast-forward); pull/rebase first', reason: 'non_fast_forward' },
      { status: 409 }
    );
  }
  if (error instanceof GitNoUpstreamError) {
    return NextResponse.json(
      { error: 'No upstream branch configured', reason: 'no_upstream' },
      { status: 400 }
    );
  }
  if (error instanceof GitProtectedBranchError) {
    return NextResponse.json(
      { error: 'Force push to the default branch is not allowed', reason: 'protected_branch' },
      { status: 409 }
    );
  }
  if (error instanceof GitForceWithLeaseStaleError) {
    return NextResponse.json(
      { error: 'Stale info; remote has new commits', reason: 'force_with_lease_stale' },
      { status: 409 }
    );
  }
  if (error instanceof GitNetworkError) {
    // First 502 for a git route: the remote was unreachable (not the client's fault).
    return NextResponse.json(
      { error: 'Could not reach the remote', reason: 'network' },
      { status: 502 }
    );
  }
  if (error instanceof GitTimeoutError) {
    return NextResponse.json(
      { error: 'Git command timed out' },
      { status: 504 }
    );
  }
  logger.error('git:api-error', { prefix: logPrefix, error: error instanceof Error ? error.message : String(error) });
  return NextResponse.json(
    { error: 'Failed to execute git command' },
    { status: 500 }
  );
}

/**
 * Classify a git network-operation stderr into one of the 6 typed network errors
 * (Issue #783, DR2-001 / DR4-003). Single source of truth for fetch/pull/push.
 *
 * Issue #921: relocated from git-utils.ts into git-errors.ts (alongside the
 * network error classes it constructs) so the exec layer (execGitConflictAware /
 * execGitNetworkAware) can import it without a git-exec <-> git-remote cycle.
 * Behavior is unchanged; `@/lib/git/git-utils` still re-exports it.
 *
 * CRITICAL (DR4-003): every error is constructed with NO stderr/message argument,
 * so the raw stderr — which can contain a credential-bearing remote URL
 * (`scheme://user:pass@host`) or absolute filesystem paths — is NEVER retained on
 * the thrown error. The stderr is read ONLY for regex matching, then discarded.
 *
 * Order matters: `stale info` (force-with-lease miss) is checked BEFORE
 * non-fast-forward because git prints both for a `--force-with-lease` rejection.
 * Unknown stderr maps to the generic, fixed-message Error (no raw stderr) that
 * matches handleGitApiError's 500 fallback.
 */
export function classifyNetworkStderr(stderr: string): Error {
  const s = stderr || '';
  if (/Authentication failed|could not read Username|could not read Password/i.test(s)) {
    return new GitAuthFailedError();
  }
  if (/stale info/i.test(s)) {
    return new GitForceWithLeaseStaleError();
  }
  if (/has no upstream branch|no upstream/i.test(s)) {
    return new GitNoUpstreamError();
  }
  if (/\[rejected\][\s\S]*\(fetch first\)|non-fast-forward/i.test(s)) {
    return new GitNonFastForwardError();
  }
  if (
    /Could not resolve host|unable to access|Could not read from remote|Connection (?:refused|timed out)|network is unreachable|Could not connect/i.test(
      s
    )
  ) {
    return new GitNetworkError();
  }
  return new Error('Failed to execute git command');
}
