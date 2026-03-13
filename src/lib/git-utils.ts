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
import type { GitStatus } from '@/types/models';
import type { CommitInfo, ChangedFile } from '@/types/git';
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
