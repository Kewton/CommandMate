/**
 * Git utility functions
 * Issue #111: Branch visualization feature
 *
 * Security considerations:
 * - Uses execFile (not exec) to prevent command injection
 * - worktreePath must be from DB only (trusted source)
 * - Error details are logged server-side, not exposed to client
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import type { GitStatus, AheadBehind } from '@/types/models';
import type {
  CommitInfo,
  ChangedFile,
  CommitLogEntry,
  RepositoryCommitLogs,
  GitStagedResponse,
  BranchInfo,
  BranchInclude,
  StashInfo,
  GitResetMode,
} from '@/types/git';
import { GIT_WRITE_TIMEOUT_MS } from '@/config/git-status-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('git-utils');

const execFileAsync = promisify(execFile);

/** Timeout for git commands in milliseconds */
const GIT_COMMAND_TIMEOUT_MS = 1000;

/** Timeout for git log/show/diff commands in milliseconds (Issue #447) */
export const GIT_LOG_TIMEOUT_MS = 3000;

/**
 * Execute a git command with timeout
 *
 * @param args - Git command arguments
 * @param cwd - Working directory (must be from DB, trusted source)
 * @returns Command output or null on error
 */
async function execGitCommand(
  args: string[],
  cwd: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (error) {
    // Log error server-side only (no client exposure)
    logger.error('git:command-failed', {
      args: args.join(' '),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * Get git status for a worktree
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param initialBranch - Branch name at session start (null if not recorded)
 * @returns GitStatus object with current branch info
 *
 * @remarks
 * - Uses execFile for security (no shell interpretation)
 * - 1 second timeout to prevent UI blocking
 * - Returns (unknown) on error without exposing details to client
 */
export async function getGitStatus(
  worktreePath: string,
  initialBranch: string | null
): Promise<GitStatus> {
  // Parallel: all 3 git commands are independent
  const [branchOutput, commitOutput, statusOutput] = await Promise.all([
    execGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath),
    execGitCommand(['rev-parse', '--short', 'HEAD'], worktreePath),
    execGitCommand(['status', '--porcelain'], worktreePath),
  ]);

  // Handle detached HEAD or error
  let currentBranch: string;
  if (branchOutput === null) {
    currentBranch = '(unknown)';
  } else if (branchOutput === 'HEAD') {
    currentBranch = '(detached HEAD)';
  } else {
    currentBranch = branchOutput;
  }

  const commitHash = commitOutput ?? '(unknown)';
  const isDirty = statusOutput !== null && statusOutput.length > 0;

  // Determine branch mismatch
  // No mismatch if:
  // - initialBranch is null (not recorded yet)
  // - currentBranch is (unknown) or (detached HEAD)
  // - branches match
  const isBranchMismatch =
    initialBranch !== null &&
    currentBranch !== '(unknown)' &&
    currentBranch !== '(detached HEAD)' &&
    currentBranch !== initialBranch;

  return {
    currentBranch,
    initialBranch,
    isBranchMismatch,
    commitHash,
    isDirty,
  };
}

// ============================================================================
// Issue #779: ahead/behind relative to upstream
// ============================================================================

/**
 * Get ahead/behind commit counts relative to the upstream branch.
 * Issue #779: git status API + GitPane Current Status (Phase 1/5).
 *
 * Runs `git rev-list --left-right --count @{upstream}...HEAD` which prints
 * `<left>\t<right>` where (for `@{upstream}...HEAD`) left = commits only on
 * upstream = behind, and right = commits only on HEAD = ahead.
 * (Verified empirically: local ahead2/behind1 -> '1\t2'.)
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @returns AheadBehind counts, or null when there is no upstream / detached HEAD /
 *          remote ref missing / timeout / parse failure. NEVER throws.
 *
 * @remarks
 * - Static arg-array (no string concatenation, no @{upstream} substitution) for
 *   command-injection safety (execFile, trusted path only).
 * - Reuses the existing non-throwing execGitCommand (1s timeout); all failures -> null.
 * - The strict parse below (tab-count check + Number.isInteger guard) collapses every
 *   malformed/empty/corrupt output to null, never disclosing the failure reason.
 */
export async function getAheadBehind(
  worktreePath: string
): Promise<AheadBehind | null> {
  const output = await execGitCommand(
    ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
    worktreePath
  );

  if (output === null) {
    return null;
  }

  const parts = output.split('\t');
  if (parts.length !== 2) {
    return null;
  }

  const behind = parseInt(parts[0], 10);
  const ahead = parseInt(parts[1], 10);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
    return null;
  }

  return { ahead, behind };
}

// ============================================================================
// Issue #447: Git tab - commit history & diff display
// ============================================================================

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
 * Execute a git command with timeout, distinguishing error types
 * Unlike execGitCommand, this throws typed errors for API-level error handling.
 *
 * @param args - Git command arguments
 * @param cwd - Working directory (must be from DB, trusted source)
 * @param timeout - Timeout in milliseconds
 * @returns Command stdout
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 * @throws {Error} For other git errors
 */
async function execGitCommandTyped(
  args: string[],
  cwd: string,
  timeout: number
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout,
    });
    return stdout;
  } catch (error) {
    const err = error as Error & { code?: string; killed?: boolean; stderr?: string };
    // Check for timeout
    if (err.killed || err.code === 'ERR_CHILD_PROCESS_EXEC_TIMEOUT' || err.code === 'ETIMEDOUT') {
      throw new GitTimeoutError(`Git command timed out after ${timeout}ms`);
    }
    // Check for "not a git repository"
    const stderr = err.stderr || err.message || '';
    if (stderr.includes('not a git repository')) {
      throw new GitNotRepoError('Not a git repository');
    }
    // Check for "unknown revision" / "bad object" (commit not found)
    const combinedMsg = `${err.stderr || ''} ${err.message || ''}`;
    if (combinedMsg.includes('unknown revision') || combinedMsg.includes('bad object')) {
      throw new Error(combinedMsg.trim());
    }
    // Issue #780: preserve "nothing to commit" so gitCommit can normalize it to
    // GitNothingToCommitError (400). Does not affect getGitStatus (execGitCommand).
    if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(combinedMsg)) {
      throw new Error(combinedMsg.trim());
    }
    // Issue #782: preserve "No local changes to save" so stashPush can normalize
    // it to GitNothingToStashError (400). Same approach as nothing-to-commit.
    if (/No local changes to save|No local changes/i.test(combinedMsg)) {
      throw new Error(combinedMsg.trim());
    }
    // Issue #781: preserve branch-operation stderr so checkout/create/delete can
    // normalize it to typed errors (branch_not_found / not_merged). Read-path
    // getGitStatus uses execGitCommand and is unaffected.
    if (
      /did not match|not a valid ref|not found|invalid reference|not fully merged|couldn't find remote ref/i.test(
        combinedMsg
      )
    ) {
      throw new Error(combinedMsg.trim());
    }
    // Log and re-throw generic error
    logger.error('git:command-failed', {
      args: args.join(' '),
      error: err.message,
    });
    throw new Error('Failed to execute git command');
  }
}

/**
 * Parse git log format output into CommitInfo array
 *
 * Format: "%H%n%h%n%s%n%an%n%aI" produces 5 lines per commit
 */
function parseGitLogOutput(output: string): CommitInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const lines = trimmed.split('\n');
  const commits: CommitInfo[] = [];

  for (let i = 0; i + 4 < lines.length; i += 5) {
    commits.push({
      hash: lines[i],
      shortHash: lines[i + 1],
      message: lines[i + 2],
      author: lines[i + 3],
      date: lines[i + 4],
    });
  }

  return commits;
}

/**
 * Get commit history for a worktree
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param limit - Maximum number of commits to return (default: 50)
 * @param offset - Number of commits to skip (default: 0)
 * @returns Array of CommitInfo objects
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 * @throws {Error} For other git errors
 */
export async function getGitLog(
  worktreePath: string,
  limit: number = 50,
  offset: number = 0
): Promise<CommitInfo[]> {
  const stdout = await execGitCommandTyped(
    ['log', `--max-count=${limit}`, `--skip=${offset}`, '--format=%H%n%h%n%s%n%an%n%aI', '--'],
    worktreePath,
    GIT_LOG_TIMEOUT_MS
  );
  return parseGitLogOutput(stdout);
}

/**
 * Parse git diff-tree --name-status output to extract changed files.
 * Format: "STATUS\tpath" (e.g., "M\tsrc/lib/foo.ts", "A\tnew-file.ts")
 * For renames: "RXXX\told-path\tnew-path"
 *
 * Uses diff-tree instead of show --stat to avoid path truncation with long paths.
 */
function parseDiffTreeOutput(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const statusCode = parts[0].trim();
    const filePath = parts[parts.length - 1].trim(); // Use last part (new path for renames)

    if (statusCode.startsWith('R')) {
      files.push({ path: filePath, status: 'renamed' });
    } else if (statusCode === 'A') {
      files.push({ path: filePath, status: 'added' });
    } else if (statusCode === 'D') {
      files.push({ path: filePath, status: 'deleted' });
    } else {
      files.push({ path: filePath, status: 'modified' });
    }
  }

  return files;
}

/**
 * Get commit details and changed files
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param commitHash - Commit hash to show
 * @returns Commit info and changed files, or null if commit not found
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 * @throws {Error} For other git errors
 */
export async function getGitShow(
  worktreePath: string,
  commitHash: string
): Promise<{ commit: CommitInfo; files: ChangedFile[] } | null> {
  try {
    // Get commit info using git log (1 commit)
    const logStdout = await execGitCommandTyped(
      ['log', '-1', '--format=%H%n%h%n%s%n%an%n%aI', commitHash, '--'],
      worktreePath,
      GIT_LOG_TIMEOUT_MS
    );

    const lines = logStdout.trim().split('\n');
    if (lines.length < 5) return null;

    const commit: CommitInfo = {
      hash: lines[0],
      shortHash: lines[1],
      message: lines[2],
      author: lines[3],
      date: lines[4],
    };

    // Get changed files using diff-tree (outputs full paths, no truncation)
    const diffTreeStdout = await execGitCommandTyped(
      ['diff-tree', '--no-commit-id', '-r', '--name-status', commitHash, '--'],
      worktreePath,
      GIT_LOG_TIMEOUT_MS
    );

    const files = parseDiffTreeOutput(diffTreeStdout);

    return { commit, files };
  } catch (error) {
    // Re-throw timeout and not-repo errors
    if (error instanceof GitTimeoutError || error instanceof GitNotRepoError) {
      throw error;
    }
    // "unknown revision" means commit not found
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('unknown revision') || msg.includes('bad object')) {
      return null;
    }
    throw error;
  }
}

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

// ============================================================================
// Issue #780: stage / unstage / commit operations
// ============================================================================

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

/**
 * Map a single porcelain v1 status code (one column character) to a ChangedFile
 * status. Caller is responsible for excluding the empty/space and `?` columns.
 *
 * @param code - One status character (`A` `M` `D` `R` `C` `T` ...)
 * @returns ChangedFile['status'] (defaults to 'modified' for unknown codes)
 */
function mapPorcelainCode(code: string): ChangedFile['status'] {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'M':
    case 'T': // typechange
    default:
      return 'modified';
  }
}

/**
 * Set of porcelain XY two-character codes that denote an unmerged (conflict)
 * entry. Per `git status` docs these are: DD, AU, UD, UA, DU, AA, UU.
 * (Equivalently: either column is `U`, or the code is `AA` / `DD`.)
 */
const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Determine whether a porcelain XY code is an unmerged (conflict) entry.
 */
function isUnmergedCode(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || UNMERGED_CODES.has(`${x}${y}`);
}

/**
 * Extract the reported path from a porcelain status line body, handling the
 * rename/copy ` old -> new ` form by returning the NEW path.
 *
 * @param body - The path portion of the line (everything after `XY `)
 * @returns The relevant path (new path for renames/copies)
 */
function parsePorcelainPath(body: string): string {
  const arrowIndex = body.indexOf(' -> ');
  if (arrowIndex !== -1) {
    return body.slice(arrowIndex + 4);
  }
  return body;
}

/**
 * Parse `git status --porcelain` (v1) output into staged / unstaged / untracked
 * buckets (Issue #780). This is git/staged-scoped ONLY and is intentionally
 * separate from getGitStatus (#779 high-frequency poll path), which is unchanged.
 *
 * Porcelain v1 lines have the form `XY <path>` where:
 * - X is the index (staged) column, Y is the working-tree (unstaged) column.
 * - `??` => untracked.
 * - X not in {space, `?`} => a staged entry mapped via the X code.
 * - Y not in {space, `?`} => an unstaged entry mapped via the Y code.
 * - Unmerged codes (DD/AU/UD/UA/DU/AA/UU, i.e. either column `U` or AA/DD) =>
 *   status `'unmerged'` placed in the `unstaged` bucket (needs resolution).
 * - Renames (`R old -> new`) use the NEW path.
 *
 * @param output - Raw stdout from `git status --porcelain`
 * @returns GitStagedResponse with the three buckets
 */
export function parsePorcelainStatus(output: string): GitStagedResponse {
  const staged: ChangedFile[] = [];
  const unstaged: ChangedFile[] = [];
  const untracked: ChangedFile[] = [];

  if (!output) {
    return { staged, unstaged, untracked };
  }

  // Porcelain lines are NUL- or LF-separated; we split on LF (default output).
  const lines = output.split('\n');

  for (const rawLine of lines) {
    // A valid porcelain line is `XY <path>` => at least 4 chars (X, Y, space, path char)
    if (rawLine.length < 4) continue;

    const x = rawLine[0];
    const y = rawLine[1];
    const body = rawLine.slice(3); // skip "XY "
    if (!body) continue;

    // Untracked
    if (x === '?' && y === '?') {
      untracked.push({ path: parsePorcelainPath(body), status: 'untracked' });
      continue;
    }

    const filePath = parsePorcelainPath(body);

    // Unmerged (conflict) -> single 'unmerged' entry in the unstaged bucket
    if (isUnmergedCode(x, y)) {
      unstaged.push({ path: filePath, status: 'unmerged' });
      continue;
    }

    // Staged change (index column populated)
    if (x !== ' ' && x !== '?') {
      staged.push({ path: filePath, status: mapPorcelainCode(x) });
    }

    // Unstaged change (working-tree column populated)
    if (y !== ' ' && y !== '?') {
      unstaged.push({ path: filePath, status: mapPorcelainCode(y) });
    }
  }

  return { staged, unstaged, untracked };
}

/**
 * Get the staged / unstaged / untracked status for a worktree (Issue #780).
 *
 * Runs `git status --porcelain` via execGitCommandTyped (GIT_WRITE_TIMEOUT_MS,
 * which comfortably covers a status read) and parses with parsePorcelainStatus.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @returns GitStagedResponse buckets
 * @throws {GitTimeoutError} When the command times out
 * @throws {GitNotRepoError} When the directory is not a git repository
 */
export async function getStagedStatus(worktreePath: string): Promise<GitStagedResponse> {
  const stdout = await execGitCommandTyped(
    ['status', '--porcelain'],
    worktreePath,
    GIT_WRITE_TIMEOUT_MS
  );
  return parsePorcelainStatus(stdout);
}

// ----------------------------------------------------------------------------
// Per-worktree in-process serialization + index.lock detection
// ----------------------------------------------------------------------------

/**
 * Module-level chain of in-flight write operations keyed by worktree path.
 * git's index can only safely accept one mutating operation at a time, so we
 * serialize all write ops for the same worktree within this process. (We do NOT
 * reuse the clone-manager DB-job pattern, which is built for long-lived clones.)
 */
const writeChains = new Map<string, Promise<unknown>>();

/**
 * Throw GitIndexLockedError if `.git/index.lock` exists for the worktree, which
 * indicates another git process (CLI, another server) is mid-write.
 *
 * Note: `.git` may be a file (worktree gitdir pointer) — in that case we cannot
 * cheaply resolve the lock path, so we skip the FS check and rely on git itself
 * to fail (which execGitCommandTyped surfaces). This is best-effort defense.
 */
function assertIndexNotLocked(worktreePath: string): void {
  const lockPath = path.join(worktreePath, '.git', 'index.lock');
  let exists = false;
  try {
    exists = fs.existsSync(lockPath);
  } catch {
    exists = false;
  }
  if (exists) {
    throw new GitIndexLockedError('Git index is locked (.git/index.lock exists)');
  }
}

/**
 * Run a write operation serialized per worktree path, after verifying the index
 * is not externally locked. Subsequent calls for the same path queue behind the
 * current one; failures do not break the chain for later callers.
 */
async function runSerializedWrite<T>(
  worktreePath: string,
  op: () => Promise<T>
): Promise<T> {
  const previous = writeChains.get(worktreePath) ?? Promise.resolve();

  const run = previous
    .catch(() => undefined) // isolate prior failures from this op's gate
    .then(() => {
      assertIndexNotLocked(worktreePath);
      return op();
    });

  // Keep the chain alive regardless of this op's outcome. Store the SAME
  // settled promise we later compare against so cleanup can drop a stale entry.
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  writeChains.set(worktreePath, settled);

  try {
    return await run;
  } finally {
    // Best-effort cleanup: if no newer op queued behind us, drop the entry.
    if (writeChains.get(worktreePath) === settled) {
      writeChains.delete(worktreePath);
    }
  }
}

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

// ============================================================================
// Issue #781: branch list (READ) / checkout / create / delete (WRITE)
// ============================================================================

/**
 * Parse the porcelain output of `git worktree list --porcelain` into a map of
 * `branch name -> worktree path` (Issue #781). The non-porcelain
 * `parseWorktreeOutput` (worktrees.ts) cannot be reused for the porcelain form.
 *
 * Porcelain records are blank-line-separated; each record has:
 *   worktree <abs-path>
 *   HEAD <sha>
 *   branch refs/heads/<name>        (omitted when detached)
 *   detached                        (when detached HEAD)
 *
 * The returned key is the short branch name (`refs/heads/` stripped). Detached
 * records contribute no branch mapping.
 *
 * @param output - Raw stdout from `git worktree list --porcelain`
 * @returns Map of short branch name to the worktree path that has it checked out
 */
export function parseWorktreePorcelain(output: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!output) return map;

  let currentPath: string | null = null;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ') && currentPath) {
      const ref = line.slice('branch '.length).trim();
      const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      if (name) {
        map.set(name, currentPath);
      }
    } else if (line === '') {
      currentPath = null;
    }
  }
  return map;
}

/**
 * Parse `git for-each-ref --format=%(refname:short)\t%(upstream:short)\t%(upstream:track)`
 * over refs/heads into a map of `branch -> { upstream, aheadBehind }` (Issue #781).
 *
 * The track field looks like `[ahead 2, behind 1]`, `[ahead 3]`, `[behind 4]`,
 * `[gone]`, or is empty. Missing/unparseable counts default to 0 on the present
 * side; a fully absent upstream yields aheadBehind=null.
 */
export function parseForEachRefTracking(
  output: string
): Map<string, { upstream: string | null; aheadBehind: { ahead: number; behind: number } | null }> {
  const map = new Map<
    string,
    { upstream: string | null; aheadBehind: { ahead: number; behind: number } | null }
  >();
  if (!output) return map;

  for (const rawLine of output.split('\n')) {
    if (!rawLine.trim()) continue;
    const [name, upstreamRaw = '', trackRaw = ''] = rawLine.split('\t');
    if (!name) continue;

    const upstream = upstreamRaw.trim() || null;
    let aheadBehind: { ahead: number; behind: number } | null = null;

    if (upstream) {
      const aheadMatch = trackRaw.match(/ahead (\d+)/);
      const behindMatch = trackRaw.match(/behind (\d+)/);
      if (aheadMatch || behindMatch) {
        aheadBehind = {
          ahead: aheadMatch ? parseInt(aheadMatch[1], 10) : 0,
          behind: behindMatch ? parseInt(behindMatch[1], 10) : 0,
        };
      } else if (!/gone/.test(trackRaw)) {
        // Upstream set, no ahead/behind reported => in sync.
        aheadBehind = { ahead: 0, behind: 0 };
      }
    }

    map.set(name, { upstream, aheadBehind });
  }
  return map;
}

/**
 * Parse `git branch` (local) output into `{ name, isCurrent }` rows (Issue #781).
 * The current branch is prefixed with `* `; detached HEAD lines (`* (HEAD ...)`)
 * are skipped.
 */
function parseLocalBranchList(output: string): Array<{ name: string; isCurrent: boolean }> {
  const rows: Array<{ name: string; isCurrent: boolean }> = [];
  if (!output) return rows;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const isCurrent = line.startsWith('* ');
    const name = line.replace(/^[*+]?\s+/, '').trim();
    // Skip detached HEAD pseudo-entries like "(HEAD detached at abc123)".
    if (!name || name.startsWith('(')) continue;
    rows.push({ name, isCurrent });
  }
  return rows;
}

/**
 * Parse `git branch -r` (remote) output into remote ref names (Issue #781).
 * Skips the `origin/HEAD -> origin/main` pointer line.
 */
function parseRemoteBranchList(output: string): string[] {
  const names: string[] = [];
  if (!output) return names;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // e.g. "origin/HEAD -> origin/main" — pointer, not a real branch.
    if (line.includes('->')) continue;
    names.push(line);
  }
  return names;
}

/**
 * List branches for a worktree (Issue #781, READ path).
 *
 * Independent of getGitStatus / the 1s execGitCommand read path (#779/#780 stays
 * byte-invariant). Runs several read commands, each via the non-throwing 1s
 * execGitCommand, and degrades best-effort: if the default-branch or
 * worktree-list or tracking read fails, that field is filled with its "unknown"
 * value (isDefault=false / checkedOutWorktreePath=null / upstream=null /
 * aheadBehind=null) instead of failing the whole list. NEVER throws.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param include - `local` (default) / `remote` / `all`
 * @returns Array of BranchInfo (empty array if the primary `git branch` read fails)
 */
export async function listBranches(
  worktreePath: string,
  include: BranchInclude = 'local'
): Promise<BranchInfo[]> {
  const wantLocal = include === 'local' || include === 'all';
  const wantRemote = include === 'remote' || include === 'all';

  const [localOut, remoteOut, defaultOut, worktreeListOut, trackingOut] = await Promise.all([
    wantLocal ? execGitCommand(['branch', '--list'], worktreePath) : Promise.resolve(''),
    wantRemote ? execGitCommand(['branch', '-r'], worktreePath) : Promise.resolve(''),
    execGitCommand(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], worktreePath),
    execGitCommand(['worktree', 'list', '--porcelain'], worktreePath),
    execGitCommand(
      ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)', 'refs/heads'],
      worktreePath
    ),
  ]);

  // origin/main short name; null if origin/HEAD is unresolved -> isDefault all false.
  const defaultBranch = defaultOut ? defaultOut.trim() : null;
  const checkedOutMap = parseWorktreePorcelain(worktreeListOut ?? '');
  const trackingMap = parseForEachRefTracking(trackingOut ?? '');

  const branches: BranchInfo[] = [];

  if (wantLocal) {
    const locals = parseLocalBranchList(localOut ?? '');
    for (const { name, isCurrent } of locals) {
      const tracking = trackingMap.get(name);
      branches.push({
        name,
        isCurrent,
        isRemote: false,
        // origin/main -> local "main" is default.
        isDefault: defaultBranch !== null && defaultBranch === `origin/${name}`,
        upstream: tracking?.upstream ?? null,
        aheadBehind: tracking?.aheadBehind ?? null,
        checkedOutWorktreePath: checkedOutMap.get(name) ?? null,
      });
    }
  }

  if (wantRemote) {
    const remotes = parseRemoteBranchList(remoteOut ?? '');
    for (const name of remotes) {
      branches.push({
        name,
        isCurrent: false,
        isRemote: true,
        isDefault: defaultBranch !== null && defaultBranch === name,
        upstream: null,
        aheadBehind: null,
        checkedOutWorktreePath: null,
      });
    }
  }

  return branches;
}

/**
 * Look up which worktree (if any) has `branch` checked out, EXCLUDING the
 * current worktree (Issue #781). Returns the occupying worktree path or null.
 * Best-effort: a failed worktree-list read yields null (no false positive).
 */
async function findCheckedOutElsewhere(
  worktreePath: string,
  branch: string
): Promise<string | null> {
  const out = await execGitCommand(['worktree', 'list', '--porcelain'], worktreePath);
  if (out === null) return null;
  const map = parseWorktreePorcelain(out);
  const occupant = map.get(branch);
  if (occupant && occupant !== worktreePath) {
    return occupant;
  }
  return null;
}

/**
 * Normalize a caught git error into a typed branch error where recognizable
 * (Issue #781). Currently maps "did not match" / "not found" / "invalid
 * reference" stderr to GitBranchNotFoundError; otherwise re-throws unchanged.
 */
function rethrowBranchError(error: unknown): never {
  if (
    error instanceof GitTimeoutError ||
    error instanceof GitNotRepoError ||
    error instanceof GitIndexLockedError
  ) {
    throw error;
  }
  const msg = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: string })?.stderr ?? '';
  const combined = `${stderr} ${msg}`;
  if (
    /did not match|not a valid ref|not found|unknown revision|invalid reference|couldn't find remote ref/i.test(
      combined
    )
  ) {
    throw new GitBranchNotFoundError('Branch not found');
  }
  throw error;
}

/**
 * Options for checkoutBranch (Issue #781).
 */
export interface CheckoutOptions {
  branch: string;
  createIfMissing?: boolean;
  from?: string;
  force?: boolean;
}

/**
 * Check out / switch to a branch (Issue #781, WRITE path).
 *
 * Preconditions (evaluated BEFORE the mutating git call, raising typed errors):
 * - The branch must not be checked out in another worktree (checked_out_elsewhere,
 *   NOT bypassable by force).
 * - When force is false, the working tree must be clean (dirty otherwise).
 *
 * Execution:
 * - createIfMissing -> `git switch -c <branch> [from] --`
 * - remote ref (`origin/<x>`) -> `git switch -c <localname> --track origin/<x> --`
 *   (avoids detached HEAD, S3-008)
 * - force -> `git checkout -f <branch> --`
 * - otherwise -> `git switch <branch> --`
 *
 * Serialized per worktree (runSerializedWrite) and uses GIT_WRITE_TIMEOUT_MS. All
 * branch args are `--`-terminated.
 *
 * @throws {GitBranchCheckedOutElsewhereError} branch occupied by another worktree
 * @throws {GitDirtyError} non-force checkout over a dirty tree
 * @throws {GitBranchNotFoundError} branch does not exist
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function checkoutBranch(
  worktreePath: string,
  options: CheckoutOptions
): Promise<void> {
  const { branch, createIfMissing = false, from, force = false } = options;

  // Precondition ORDER MATTERS: the checked_out_elsewhere guard is evaluated
  // BEFORE the force-gated dirty guard. Git itself refuses to check out a branch
  // that another worktree already has, and `force` (which only discards THIS
  // worktree's local changes) cannot legitimately steal a branch from a sibling
  // worktree. Evaluating it first means a force:true request over an occupied
  // branch still surfaces checked_out_elsewhere (409, NOT bypassable) instead of
  // being masked by — or wrongly bypassing — the dirty check (reason:
  // checked_out_elsewhere takes precedence over reason: dirty).
  const occupant = await findCheckedOutElsewhere(worktreePath, branch);
  if (occupant) {
    throw new GitBranchCheckedOutElsewhereError(
      'Branch is checked out in another worktree',
      occupant
    );
  }

  // Precondition: a dirty tree blocks a non-force checkout (reason: dirty). force
  // intentionally bypasses ONLY this guard (it discards local changes), never the
  // checked_out_elsewhere guard above.
  if (!force) {
    const status = await execGitCommand(['status', '--porcelain'], worktreePath);
    if (status !== null && status.length > 0) {
      throw new GitDirtyError('Working tree has uncommitted changes');
    }
  }

  await runSerializedWrite(worktreePath, async () => {
    let args: string[];
    if (createIfMissing) {
      args = ['switch', '-c', branch];
      if (from) args.push(from);
      args.push('--');
    } else if (branch.startsWith('origin/')) {
      // Remote ref: create a local tracking branch (no detached HEAD, S3-008).
      const localName = branch.slice('origin/'.length);
      args = ['switch', '-c', localName, '--track', branch, '--'];
    } else if (force) {
      args = ['checkout', '-f', branch, '--'];
    } else {
      args = ['switch', branch, '--'];
    }

    try {
      await execGitCommandTyped(args, worktreePath, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
      rethrowBranchError(error);
    }
  });
}

/**
 * Options for createBranch (Issue #781).
 */
export interface CreateBranchOptions {
  name: string;
  from?: string;
}

/**
 * Create a branch without checking it out (Issue #781, WRITE path).
 * `git branch <name> [from] --`. Serialized per worktree.
 *
 * @throws {GitBranchNotFoundError} the `from` ref does not exist
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function createBranch(
  worktreePath: string,
  options: CreateBranchOptions
): Promise<void> {
  const { name, from } = options;
  await runSerializedWrite(worktreePath, async () => {
    const args = ['branch', name];
    if (from) args.push(from);
    args.push('--');
    try {
      await execGitCommandTyped(args, worktreePath, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
      rethrowBranchError(error);
    }
  });
}

/**
 * Options for deleteBranch (Issue #781).
 */
export interface DeleteBranchOptions {
  name: string;
  force?: boolean;
}

/**
 * Delete a branch (Issue #781, WRITE path). `git branch -d|-D <name> --`.
 *
 * Preconditions (typed errors before the mutating call):
 * - Cannot delete the current branch (current_branch).
 * - Cannot delete the default branch from origin/HEAD (default_branch).
 *
 * `git branch -d` "not fully merged" stderr is normalized to
 * GitBranchNotMergedError (409). Serialized per worktree.
 *
 * @throws {GitCurrentBranchError | GitDefaultBranchError} precondition failures
 * @throws {GitBranchNotMergedError} `-d` refused (use force)
 * @throws {GitBranchNotFoundError} branch does not exist
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function deleteBranch(
  worktreePath: string,
  options: DeleteBranchOptions
): Promise<void> {
  const { name, force = false } = options;

  // Precondition: refuse to delete the current branch.
  const current = await execGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  if (current !== null && current.trim() === name) {
    throw new GitCurrentBranchError('Cannot delete the current branch');
  }

  // Precondition: refuse to delete the default branch (origin/HEAD-derived).
  const defaultOut = await execGitCommand(
    ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
    worktreePath
  );
  if (defaultOut !== null && defaultOut.trim() === `origin/${name}`) {
    throw new GitDefaultBranchError('Cannot delete the default branch');
  }

  await runSerializedWrite(worktreePath, async () => {
    const flag = force ? '-D' : '-d';
    try {
      await execGitCommandTyped(['branch', flag, name, '--'], worktreePath, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stderr = (error as { stderr?: string })?.stderr ?? '';
      const combined = `${stderr} ${msg}`;
      if (/not fully merged/i.test(combined)) {
        throw new GitBranchNotMergedError('Branch is not fully merged');
      }
      rethrowBranchError(error);
    }
  });
}

// ============================================================================
// Issue #782: stash list (READ) / push/pop/apply/drop + reset/revert (WRITE)
// ============================================================================

/**
 * Tab-separated `git stash list` format (Issue #782). `%x09` is a literal TAB,
 * matching the for-each-ref / commit-log delimiter policy:
 *   %gd  -> the `stash@{N}` selector
 *   %s   -> the stash subject
 *   %cI  -> committer date (ISO8601)
 *   %H   -> the stash commit's full hash
 */
const STASH_LIST_FORMAT = '--format=%gd%x09%s%x09%cI%x09%H';

/** Matches a `stash@{N}` selector (the `%gd` field) and captures N. */
const STASH_SELECTOR_PATTERN = /^stash@\{(\d+)\}$/;

/**
 * Extract the branch from a stash subject (`%s`). git writes
 * `WIP on <branch>: <sha> <msg>` (auto) or `On <branch>: <msg>` (manual `-m`).
 * Returns the branch, or null when neither prefix is present.
 */
function extractStashBranch(subject: string): string | null {
  const wip = subject.match(/^WIP on ([^:]+):/);
  if (wip) return wip[1].trim() || null;
  const on = subject.match(/^On ([^:]+):/);
  if (on) return on[1].trim() || null;
  return null;
}

/**
 * Parse `git stash list --format='%gd%x09%s%x09%cI%x09%H'` output into
 * StashInfo[] (Issue #782). Same tab-split policy as parseForEachRefTracking.
 * Lines whose `%gd` does not match `stash@{N}` are skipped; empty output -> [].
 *
 * @param output - Raw stdout from the formatted `git stash list`
 * @returns Parsed StashInfo entries in list order
 */
export function parseStashList(output: string): StashInfo[] {
  const stashes: StashInfo[] = [];
  if (!output || !output.trim()) return stashes;

  for (const rawLine of output.split('\n')) {
    if (!rawLine.trim()) continue;
    const [selector = '', message = '', date = '', sha = ''] = rawLine.split('\t');
    const match = selector.match(STASH_SELECTOR_PATTERN);
    if (!match) continue;
    stashes.push({
      index: parseInt(match[1], 10),
      message,
      branch: extractStashBranch(message),
      date,
      sha,
    });
  }
  return stashes;
}

/**
 * List the stashes for a worktree (Issue #782, READ path).
 *
 * Independent of getGitStatus / the 1s execGitCommand read path (#779/#780/#781
 * stays byte-invariant). Uses the non-throwing 1s execGitCommand and degrades
 * best-effort: any failure yields `[]` (200 at the API layer) rather than
 * breaking the section, exactly like listBranches. NEVER throws.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @returns Array of StashInfo (empty array if the read fails)
 */
export async function getStashList(worktreePath: string): Promise<StashInfo[]> {
  const output = await execGitCommand(['stash', 'list', STASH_LIST_FORMAT], worktreePath);
  if (output === null) return [];
  return parseStashList(output);
}

/**
 * Result of a stash pop/apply (and revert): clean completion vs. a conflict left
 * in the working tree (Issue #782). A conflict is a SUCCESS (the operation ran),
 * surfaced as `conflict: true` with the conflicted paths — never a throw.
 */
export interface ConflictResult {
  conflict: boolean;
  conflictFiles?: string[];
  /** For `pop`: git keeps the stash entry when the pop conflicts. */
  stashRetained?: boolean;
}

/** Extract `CONFLICT ... in <path>` file paths from git stdout (Issue #782). */
function parseConflictFiles(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/);
    if (m) files.push(m[1].trim());
  }
  return files;
}

/**
 * Run a git command that may legitimately exit non-zero on a CONFLICT, via
 * execFileAsync directly so the conflict patch on `err.stdout` is recoverable
 * (Issue #782, S3-002). execGitCommandTyped discards stdout on reject, so it
 * cannot be used here. We MANUALLY re-create the normalization
 * execGitCommandTyped would otherwise provide:
 *   - killed / ETIMEDOUT          -> GitTimeoutError (504)
 *   - "not a git repository"      -> GitNotRepoError (400)
 *   - exit-1 with CONFLICT stdout -> { conflict: true, conflictFiles }
 *   - any other failure           -> generic Error (500)
 *
 * The caller is responsible for running this inside runSerializedWrite (which
 * also performs the index.lock check), so serialization + lock detection are
 * preserved on this path too.
 */
async function execGitConflictAware(
  args: string[],
  worktreePath: string
): Promise<ConflictResult> {
  try {
    await execFileAsync('git', args, { cwd: worktreePath, timeout: GIT_WRITE_TIMEOUT_MS });
    return { conflict: false };
  } catch (error) {
    const err = error as Error & {
      code?: string | number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };

    // Timeout BEFORE the conflict recovery so a killed process is never mistaken
    // for a "normal" conflicting exit.
    if (err.killed || err.code === 'ERR_CHILD_PROCESS_EXEC_TIMEOUT' || err.code === 'ETIMEDOUT') {
      throw new GitTimeoutError(`Git command timed out after ${GIT_WRITE_TIMEOUT_MS}ms`);
    }

    const combined = `${err.stderr || ''} ${err.message || ''}`;
    if (combined.includes('not a git repository')) {
      throw new GitNotRepoError('Not a git repository');
    }

    // A conflict leaves the merge markers and prints `CONFLICT ...` on stdout.
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    if (stdout.includes('CONFLICT')) {
      return { conflict: true, conflictFiles: parseConflictFiles(stdout) };
    }

    logger.error('git:conflict-aware-failed', {
      args: args.join(' '),
      error: err.message,
    });
    throw new Error('Failed to execute git command');
  }
}

/** Options for stashPush (Issue #782). */
export interface StashPushOptions {
  message?: string;
  includeUntracked?: boolean;
}

/**
 * Stash the working tree: `git stash push [--include-untracked] [-m <msg>] --`
 * (Issue #782, WRITE path). Serialized per worktree; the trailing `--` blocks
 * pathspec/option injection. "No local changes to save" is normalized to
 * GitNothingToStashError (400), mirroring gitCommit's nothing-to-commit handling.
 *
 * @throws {GitNothingToStashError} working tree is clean
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function stashPush(
  worktreePath: string,
  options: StashPushOptions
): Promise<void> {
  const { message, includeUntracked } = options;
  await runSerializedWrite(worktreePath, async () => {
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (message) args.push('-m', message);
    args.push('--');
    try {
      await execGitCommandTyped(args, worktreePath, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      const stderr = (error as { stderr?: string })?.stderr ?? '';
      if (/No local changes to save|No stash entries|No local changes/i.test(`${stderr} ${msg}`)) {
        throw new GitNothingToStashError('No local changes to stash');
      }
      throw error;
    }
  });
}

/**
 * Pop a stash: `git stash pop -- stash@{N}` (Issue #782, WRITE path). The index
 * is a validated non-negative integer, so the `stash@{N}` string is injection-
 * free. A conflict returns `{ conflict: true, conflictFiles, stashRetained: true }`
 * (git keeps the stash) — NOT a throw. Serialized per worktree; index.lock and
 * timeout are honored (S3-002).
 */
export async function stashPop(worktreePath: string, index: number): Promise<ConflictResult> {
  return runSerializedWrite(worktreePath, async () => {
    const result = await execGitConflictAware(
      ['stash', 'pop', '--', `stash@{${index}}`],
      worktreePath
    );
    // git does NOT drop a stash whose pop conflicted; reflect that to the client.
    if (result.conflict) {
      return { ...result, stashRetained: true };
    }
    return result;
  });
}

/**
 * Apply a stash without dropping it: `git stash apply -- stash@{N}` (Issue #782).
 * Conflict handling mirrors stashPop (apply already keeps the stash regardless).
 */
export async function stashApply(worktreePath: string, index: number): Promise<ConflictResult> {
  return runSerializedWrite(worktreePath, async () => {
    return execGitConflictAware(['stash', 'apply', '--', `stash@{${index}}`], worktreePath);
  });
}

/**
 * Drop a stash: `git stash drop -- stash@{N}` (Issue #782, WRITE path). No
 * conflict path (drop never conflicts). Serialized per worktree.
 *
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function stashDrop(worktreePath: string, index: number): Promise<void> {
  logger.warn('git:danger:stash-drop', {
    operation: 'stash-drop',
    worktreePath,
    index,
    timestamp: new Date().toISOString(),
  });
  await runSerializedWrite(worktreePath, async () => {
    await execGitCommandTyped(
      ['stash', 'drop', '--', `stash@{${index}}`],
      worktreePath,
      GIT_WRITE_TIMEOUT_MS
    );
  });
}

/** Options for gitReset (Issue #782). */
export interface ResetOptions {
  target: string;
  mode: GitResetMode;
}

/**
 * Resolve whether the current branch is the default branch FOR THE PURPOSE OF
 * the hard-reset guard (Issue #782, S3-010).
 *
 * Default detection uses #781's origin/HEAD symbolic-ref. INTENTIONAL ASYMMETRY
 * vs. deleteBranch (git-utils.ts deleteBranch): when origin/HEAD is unresolved,
 * deleteBranch offers NO protection, but hard reset conservatively treats
 * `main` / `master` as default and refuses — the destructiveness of a hard
 * reset warrants the stronger fallback. Whether to propagate this fallback to
 * deleteBranch is deferred to a separate issue (S3-010).
 */
async function isDefaultBranchForReset(worktreePath: string): Promise<boolean> {
  const current = await execGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  if (current === null) return false;
  const currentBranch = current.trim();

  const defaultOut = await execGitCommand(
    ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
    worktreePath
  );
  if (defaultOut !== null && defaultOut.trim() === `origin/${currentBranch}`) {
    return true;
  }
  // Conservative fallback when origin/HEAD is unresolved (S3-010): protect
  // main/master only. This is deliberately stronger than deleteBranch.
  if (defaultOut === null && (currentBranch === 'main' || currentBranch === 'master')) {
    return true;
  }
  return false;
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

// ============================================================================
// Issue #627: Commit log collection for daily reports
// ============================================================================

/** Timeout for individual git log commit collection in milliseconds */
const GIT_COMMIT_LOG_TIMEOUT_MS = 5000;

/**
 * Unit separator character used as field delimiter in git log format.
 * Using \x1f avoids conflicts with commit messages that may contain
 * common delimiters like | or ,.
 */
const FIELD_SEPARATOR = '\x1f';

/**
 * Get commits within a date range for a repository.
 * Uses --all to include all branches.
 *
 * @param repoPath - Path to the repository (must exist on filesystem)
 * @param since - ISO 8601 date string for the start of the range
 * @param until - ISO 8601 date string for the end of the range
 * @returns Array of CommitLogEntry, empty array on error or missing path
 */
export async function getCommitsByDateRange(
  repoPath: string,
  since: string,
  until: string
): Promise<CommitLogEntry[]> {
  if (!fs.existsSync(repoPath)) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync('git', [
      'log',
      '--all',
      `--since=${since}`,
      `--until=${until}`,
      `--format=%h${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%an`,
      '--',
    ], {
      cwd: repoPath,
      timeout: GIT_COMMIT_LOG_TIMEOUT_MS,
    });

    const trimmed = stdout.trim();
    if (!trimmed) return [];

    const entries: CommitLogEntry[] = [];
    for (const line of trimmed.split('\n')) {
      const parts = line.split(FIELD_SEPARATOR);
      if (parts.length !== 3) continue;
      entries.push({
        shortHash: parts[0],
        message: parts[1],
        author: parts[2],
      });
    }

    return entries;
  } catch (error) {
    logger.error('git:commit-log-failed', {
      repoPath,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return [];
  }
}

/**
 * Collect commit logs from multiple repositories in parallel.
 * Repositories with no commits are skipped from the result.
 *
 * @param repositories - Array of { id, name, path } objects
 * @param since - ISO 8601 date string for the start of the range
 * @param until - ISO 8601 date string for the end of the range
 * @returns Map of repository ID to { name, commits }
 */
export async function collectRepositoryCommitLogs(
  repositories: Array<{ id: string; name: string; path: string }>,
  since: string,
  until: string
): Promise<RepositoryCommitLogs> {
  const results = await Promise.allSettled(
    repositories.map(async (repo) => ({
      id: repo.id,
      name: repo.name,
      commits: await getCommitsByDateRange(repo.path, since, until),
    }))
  );

  const commitLogs: RepositoryCommitLogs = new Map();
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.commits.length > 0) {
      commitLogs.set(result.value.id, {
        name: result.value.name,
        commits: result.value.commits,
      });
    }
  }

  return commitLogs;
}

// =============================================================================
// Issue #630: Issue context in report
// =============================================================================

/**
 * Pattern to extract issue numbers from commit messages.
 * Matches: #NNN, Closes #NNN, Fixes #NNN, Resolves #NNN (case-insensitive)
 */
const ISSUE_NUMBER_PATTERN = /(?:(?:closes|fixes|resolves)\s+)?#(\d+)/gi;

/**
 * Extract unique issue numbers from an array of commit messages.
 *
 * @param messages - Array of commit message strings
 * @returns Sorted array of unique issue numbers
 */
export function extractIssueNumbers(messages: string[]): number[] {
  const seen = new Set<number>();
  for (const msg of messages) {
    ISSUE_NUMBER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ISSUE_NUMBER_PATTERN.exec(msg)) !== null) {
      seen.add(parseInt(match[1], 10));
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}
