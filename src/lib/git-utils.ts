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
import type { GitStatus } from '@/types/models';

const execFileAsync = promisify(execFile);

/** Timeout for git commands in milliseconds */
const GIT_COMMAND_TIMEOUT_MS = 1000;

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
    console.error(`[git-utils] Git command failed:`, {
      args,
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
  // Get current branch
  const branchOutput = await execGitCommand(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    worktreePath
  );

  // Handle detached HEAD or error
  let currentBranch: string;
  if (branchOutput === null) {
    currentBranch = '(unknown)';
  } else if (branchOutput === 'HEAD') {
    currentBranch = '(detached HEAD)';
  } else {
    currentBranch = branchOutput;
  }

  // Get short commit hash
  const commitOutput = await execGitCommand(
    ['rev-parse', '--short', 'HEAD'],
    worktreePath
  );
  const commitHash = commitOutput ?? '(unknown)';

  // Check for uncommitted changes
  const statusOutput = await execGitCommand(
    ['status', '--porcelain'],
    worktreePath
  );
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
