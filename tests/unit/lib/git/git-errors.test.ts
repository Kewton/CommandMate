/**
 * Tests for git-errors.ts (typed error classes + handleGitApiError mapping +
 * classifyNetworkStderr credential-safe network error classification).
 * Issue #781 / #782 / #783 (originally in git-utils.test.ts).
 * Issue #921: split out of git-utils.test.ts to follow the new module boundary.
 */

import { describe, it, expect, vi } from 'vitest';

// Hoist mock functions so they are available in vi.mock() factories
const { mockExistsSync, mockExecFileAsync, mockLogger } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecFileAsync: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => {
  mockLogger.withContext.mockReturnValue(mockLogger);
  return {
    createLogger: vi.fn(() => mockLogger),
  };
});

vi.mock('fs', () => ({
  default: { existsSync: (...args: unknown[]) => mockExistsSync(...args) },
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}));

import {
  handleGitApiError,
  classifyNetworkStderr,
  GitBranchNotFoundError,
  GitBranchNotMergedError,
  GitCurrentBranchError,
  GitDefaultBranchError,
  GitDirtyError,
  GitBranchCheckedOutElsewhereError,
  GitNothingToStashError,
  GitResetDefaultBranchError,
  GitIndexLockedError,
  GitNothingToCommitError,
  GitTimeoutError,
  GitNotRepoError,
  GitAuthFailedError,
  GitNonFastForwardError,
  GitNoUpstreamError,
  GitProtectedBranchError,
  GitForceWithLeaseStaleError,
  GitNetworkError,
} from '@/lib/git/git-errors';

// ============================================================================
// Issue #781: handleGitApiError reason mapping
// ============================================================================

describe('handleGitApiError branch reasons (Issue #781)', () => {
  async function statusAndReason(error: Error) {
    const res = handleGitApiError(error, 'test');
    const body = (await res.json()) as { reason?: string; worktreePath?: string };
    return { status: res.status, reason: body.reason, worktreePath: body.worktreePath };
  }

  it('maps GitBranchNotFoundError to 404 branch_not_found', async () => {
    expect(await statusAndReason(new GitBranchNotFoundError('x'))).toMatchObject({
      status: 404,
      reason: 'branch_not_found',
    });
  });

  it('maps GitBranchNotMergedError to 409 not_merged', async () => {
    expect(await statusAndReason(new GitBranchNotMergedError('x'))).toMatchObject({
      status: 409,
      reason: 'not_merged',
    });
  });

  it('maps GitCurrentBranchError to 409 current_branch', async () => {
    expect(await statusAndReason(new GitCurrentBranchError('x'))).toMatchObject({
      status: 409,
      reason: 'current_branch',
    });
  });

  it('maps GitDefaultBranchError to 409 default_branch', async () => {
    expect(await statusAndReason(new GitDefaultBranchError('x'))).toMatchObject({
      status: 409,
      reason: 'default_branch',
    });
  });

  it('maps GitDirtyError to 409 dirty', async () => {
    expect(await statusAndReason(new GitDirtyError('x'))).toMatchObject({
      status: 409,
      reason: 'dirty',
    });
  });

  it('maps GitBranchCheckedOutElsewhereError to 409 checked_out_elsewhere with worktreePath', async () => {
    const result = await statusAndReason(new GitBranchCheckedOutElsewhereError('x', '/other/wt'));
    expect(result.status).toBe(409);
    expect(result.reason).toBe('checked_out_elsewhere');
    expect(result.worktreePath).toBe('/other/wt');
  });
});

// ============================================================================
// Issue #782: handleGitApiError new reasons + #780/#781 byte-invariant regression
// ============================================================================

describe('handleGitApiError danger-zone reasons (Issue #782)', () => {
  async function bodyOf(error: Error) {
    const res = handleGitApiError(error, 'test');
    const body = (await res.json()) as { error?: string; reason?: string };
    return { status: res.status, error: body.error, reason: body.reason };
  }

  it('maps GitNothingToStashError to 400 nothing_to_stash', async () => {
    const result = await bodyOf(new GitNothingToStashError('x'));
    expect(result.status).toBe(400);
    expect(result.reason).toBe('nothing_to_stash');
  });

  it('maps GitResetDefaultBranchError to 409 default_branch (reset-specific message)', async () => {
    const result = await bodyOf(new GitResetDefaultBranchError('x'));
    expect(result.status).toBe(409);
    expect(result.reason).toBe('default_branch');
    // Must NOT reuse the delete-specific "Cannot delete the default branch" text.
    expect(result.error).not.toBe('Cannot delete the default branch');
  });

  // S3-001: the #780/#781 reason bodies must be byte-identical after the additive
  // expansion. These assertions lock the EXACT error string + reason + status.
  it('keeps #780/#781 reason bodies byte-identical (regression)', async () => {
    expect(await bodyOf(new GitIndexLockedError('x'))).toEqual({
      status: 409,
      error: 'Git index is locked by another operation',
      reason: undefined,
    });
    expect(await bodyOf(new GitNothingToCommitError('x'))).toEqual({
      status: 400,
      error: 'Nothing to commit',
      reason: undefined,
    });
    expect(await bodyOf(new GitBranchNotFoundError('x'))).toEqual({
      status: 404,
      error: 'Branch not found',
      reason: 'branch_not_found',
    });
    expect(await bodyOf(new GitBranchNotMergedError('x'))).toEqual({
      status: 409,
      error: 'Branch is not fully merged',
      reason: 'not_merged',
    });
    expect(await bodyOf(new GitCurrentBranchError('x'))).toEqual({
      status: 409,
      error: 'Cannot operate on the current branch',
      reason: 'current_branch',
    });
    expect(await bodyOf(new GitDefaultBranchError('x'))).toEqual({
      status: 409,
      error: 'Cannot delete the default branch',
      reason: 'default_branch',
    });
    expect(await bodyOf(new GitDirtyError('x'))).toEqual({
      status: 409,
      error: 'Working tree has uncommitted changes',
      reason: 'dirty',
    });
    expect(await bodyOf(new GitTimeoutError('x'))).toEqual({
      status: 504,
      error: 'Git command timed out',
      reason: undefined,
    });
    expect(await bodyOf(new GitNotRepoError('x'))).toEqual({
      status: 400,
      error: 'Not a git repository',
      reason: undefined,
    });
  });
});

// ============================================================================
// Issue #783: 6 network error classes + handleGitApiError extension (DR4-003)
// Additive NEW it() blocks. The existing byte-identical it (L1595) is UNCHANGED.
// Bodies are FIXED literals that never echo error.message (no token/URL leakage).
// ============================================================================

describe('handleGitApiError network reasons (Issue #783, DR4-003)', () => {
  async function bodyOf(error: Error) {
    const res = handleGitApiError(error, 'test');
    const body = (await res.json()) as { error?: string; reason?: string };
    return { status: res.status, error: body.error, reason: body.reason };
  }

  it('maps GitAuthFailedError to 401 auth_failed (fixed body)', async () => {
    expect(await bodyOf(new GitAuthFailedError())).toEqual({
      status: 401,
      error: 'Authentication failed; configure credentials in the terminal',
      reason: 'auth_failed',
    });
  });

  it('maps GitNonFastForwardError to 409 non_fast_forward (fixed body)', async () => {
    expect(await bodyOf(new GitNonFastForwardError())).toEqual({
      status: 409,
      error: 'Push rejected (non-fast-forward); pull/rebase first',
      reason: 'non_fast_forward',
    });
  });

  it('maps GitNoUpstreamError to 400 no_upstream (fixed body)', async () => {
    expect(await bodyOf(new GitNoUpstreamError())).toEqual({
      status: 400,
      error: 'No upstream branch configured',
      reason: 'no_upstream',
    });
  });

  it('maps GitProtectedBranchError to 409 protected_branch (fixed body)', async () => {
    expect(await bodyOf(new GitProtectedBranchError())).toEqual({
      status: 409,
      error: 'Force push to the default branch is not allowed',
      reason: 'protected_branch',
    });
  });

  it('maps GitForceWithLeaseStaleError to 409 force_with_lease_stale (fixed body)', async () => {
    expect(await bodyOf(new GitForceWithLeaseStaleError())).toEqual({
      status: 409,
      error: 'Stale info; remote has new commits',
      reason: 'force_with_lease_stale',
    });
  });

  it('maps GitNetworkError to 502 network (fixed body)', async () => {
    expect(await bodyOf(new GitNetworkError())).toEqual({
      status: 502,
      error: 'Could not reach the remote',
      reason: 'network',
    });
  });

  it('never echoes a stderr/message into the HTTP body (no token/URL leakage)', async () => {
    // Even if a class were constructed with a sensitive message, the fixed body
    // must not include it. The classes take no message arg, but assert anyway.
    const leak = 'https://ci-bot:glpat-SECRET@gitlab/repo.git';
    const err = Object.assign(new GitNetworkError(), { message: leak });
    const result = await bodyOf(err);
    expect(result.error).toBe('Could not reach the remote');
    expect(JSON.stringify(result)).not.toContain('glpat-SECRET');
    expect(JSON.stringify(result)).not.toContain('ci-bot');
  });

  // DR3-003: an EXTENDED byte-identical it for the 6 NEW classes (separate from
  // the existing L1595 it, which stays byte-unchanged).
  it('locks the 6 #783 network reason bodies byte-identical (extended regression)', async () => {
    expect(await bodyOf(new GitAuthFailedError())).toEqual({
      status: 401,
      error: 'Authentication failed; configure credentials in the terminal',
      reason: 'auth_failed',
    });
    expect(await bodyOf(new GitNonFastForwardError())).toEqual({
      status: 409,
      error: 'Push rejected (non-fast-forward); pull/rebase first',
      reason: 'non_fast_forward',
    });
    expect(await bodyOf(new GitNoUpstreamError())).toEqual({
      status: 400,
      error: 'No upstream branch configured',
      reason: 'no_upstream',
    });
    expect(await bodyOf(new GitProtectedBranchError())).toEqual({
      status: 409,
      error: 'Force push to the default branch is not allowed',
      reason: 'protected_branch',
    });
    expect(await bodyOf(new GitForceWithLeaseStaleError())).toEqual({
      status: 409,
      error: 'Stale info; remote has new commits',
      reason: 'force_with_lease_stale',
    });
    expect(await bodyOf(new GitNetworkError())).toEqual({
      status: 502,
      error: 'Could not reach the remote',
      reason: 'network',
    });
  });
});

// ============================================================================
// Issue #783: classifyNetworkStderr maps raw (credential-redacted) network
// stderr -> the 6 typed network errors (DR2-001 / DR4-003). CRITICAL: the typed
// errors are constructed WITHOUT a stderr/message arg, so raw stderr (which may
// contain a token-bearing URL) never reaches the thrown error.
// ============================================================================

describe('classifyNetworkStderr (Issue #783, DR2-001/DR4-003)', () => {
  it('maps "Authentication failed" to GitAuthFailedError', () => {
    expect(classifyNetworkStderr('fatal: Authentication failed for https://x')).toBeInstanceOf(
      GitAuthFailedError
    );
  });

  it('maps "could not read Username" to GitAuthFailedError', () => {
    expect(classifyNetworkStderr('fatal: could not read Username for https://x')).toBeInstanceOf(
      GitAuthFailedError
    );
  });

  it('maps "! [rejected] ... (fetch first)" to GitNonFastForwardError', () => {
    expect(
      classifyNetworkStderr(' ! [rejected]        main -> main (fetch first)')
    ).toBeInstanceOf(GitNonFastForwardError);
  });

  it('maps "non-fast-forward" to GitNonFastForwardError', () => {
    expect(classifyNetworkStderr('error: failed to push some refs (non-fast-forward)')).toBeInstanceOf(
      GitNonFastForwardError
    );
  });

  it('maps "has no upstream branch" to GitNoUpstreamError', () => {
    expect(
      classifyNetworkStderr('fatal: The current branch feature has no upstream branch.')
    ).toBeInstanceOf(GitNoUpstreamError);
  });

  it('maps "no upstream" to GitNoUpstreamError', () => {
    expect(classifyNetworkStderr('fatal: no upstream configured')).toBeInstanceOf(
      GitNoUpstreamError
    );
  });

  it('maps "stale info" to GitForceWithLeaseStaleError', () => {
    expect(
      classifyNetworkStderr('! [rejected] main -> main (stale info)')
    ).toBeInstanceOf(GitForceWithLeaseStaleError);
  });

  it('maps "Could not resolve host" to GitNetworkError', () => {
    expect(classifyNetworkStderr('fatal: unable to access ...: Could not resolve host: github.com')).toBeInstanceOf(
      GitNetworkError
    );
  });

  it('maps "unable to access" to GitNetworkError', () => {
    expect(classifyNetworkStderr("fatal: unable to access 'https://host/repo'")).toBeInstanceOf(
      GitNetworkError
    );
  });

  it('falls back to a generic Error for unknown stderr', () => {
    const e = classifyNetworkStderr('some completely unknown failure');
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(GitAuthFailedError);
    expect(e).not.toBeInstanceOf(GitNetworkError);
    expect(e.message).toBe('Failed to execute git command');
  });

  it('prioritizes stale info (force-with-lease) over non-fast-forward when both appear', () => {
    // git prints "stale info" alongside "[rejected]" for a force-with-lease miss.
    expect(
      classifyNetworkStderr('! [rejected] main -> main (stale info)\n(non-fast-forward)')
    ).toBeInstanceOf(GitForceWithLeaseStaleError);
  });

  it('NEVER places raw stderr / a token-bearing URL on the thrown error message', () => {
    const leak = "fatal: unable to access 'https://ci-bot:glpat-SECRET@gitlab/repo.git'";
    const e = classifyNetworkStderr(leak);
    expect(e).toBeInstanceOf(GitNetworkError);
    expect(e.message).not.toContain('glpat-SECRET');
    expect(e.message).not.toContain('ci-bot');
    expect(e.message).not.toContain('https://');
  });

  it('NEVER places a token-bearing URL on an auth-failed error message', () => {
    const leak =
      "fatal: Authentication failed for 'https://ci-bot:glpat-SECRET@gitlab/repo.git'";
    const e = classifyNetworkStderr(leak);
    expect(e).toBeInstanceOf(GitAuthFailedError);
    expect(e.message).not.toContain('glpat-SECRET');
    expect(e.message).not.toContain('ci-bot');
  });
});
