/**
 * Worktree Detector
 * Issue #136: Phase 1 - Task 1.3
 *
 * Provides utilities for detecting git worktrees and extracting issue numbers.
 * Used to automatically identify which worktree environment the CLI is running in.
 *
 * Security: Uses execFile instead of exec to prevent command injection.
 *
 * @module worktree-detector
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Information about a detected worktree
 */
export interface WorktreeInfo {
  /** Issue number associated with the worktree */
  issueNo: number;
  /** Absolute path to the worktree root */
  path: string;
  /** Current git branch */
  branch: string;
}

/**
 * Pattern for extracting issue number from worktree directory name
 * Matches: commandmate-issue-{number}
 */
const WORKTREE_PATH_PATTERN = /commandmate-issue-(\d+)/;

/**
 * Pattern for extracting issue number from branch name
 * Matches:
 * - feature/{number}-description
 * - fix/{number}-description
 * - hotfix/{number}-description
 * - {number}-description (without prefix)
 */
const BRANCH_ISSUE_PATTERN = /^(?:feature\/|fix\/|hotfix\/)?(\d+)-/;

/**
 * Extract issue number from a worktree directory path
 *
 * @param dirPath - Directory path to check
 * @returns Issue number or null if not a worktree path
 *
 * @example
 * ```typescript
 * extractIssueNoFromPath('/home/user/repos/commandmate-issue-135'); // 135
 * extractIssueNoFromPath('/home/user/repos/commandmate'); // null
 * ```
 */
export function extractIssueNoFromPath(dirPath: string): number | null {
  // Normalize path and remove trailing slash
  const normalizedPath = path.normalize(dirPath).replace(/\/$/, '');

  const match = normalizedPath.match(WORKTREE_PATH_PATTERN);
  if (!match) {
    return null;
  }

  const issueNo = parseInt(match[1], 10);

  // Validate: must be positive integer
  if (!Number.isInteger(issueNo) || issueNo <= 0) {
    return null;
  }

  return issueNo;
}

/**
 * Extract issue number from a git branch name
 *
 * @param branchName - Git branch name
 * @returns Issue number or null if not found
 *
 * @example
 * ```typescript
 * extractIssueNoFromBranch('feature/135-add-worktree'); // 135
 * extractIssueNoFromBranch('main'); // null
 * ```
 */
export function extractIssueNoFromBranch(branchName: string): number | null {
  const match = branchName.match(BRANCH_ISSUE_PATTERN);
  if (!match) {
    return null;
  }

  const issueNo = parseInt(match[1], 10);

  // Validate: must be positive integer
  if (!Number.isInteger(issueNo) || issueNo <= 0) {
    return null;
  }

  return issueNo;
}

/**
 * Check if a directory is inside a git worktree
 *
 * @param dirPath - Directory path to check
 * @returns true if directory is inside a git repository
 */
export async function isWorktreeDirectory(dirPath: string): Promise<boolean> {
  try {
    // Use execFile for security (no shell interpretation)
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dirPath,
      timeout: 5000, // 5 second timeout
    });

    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Get the git repository root for a directory
 *
 * @param dirPath - Directory path
 * @returns Repository root path or null
 */
async function getGitRoot(dirPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dirPath,
      timeout: 5000,
    });

    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get the current git branch name
 *
 * @param dirPath - Directory path within git repository
 * @returns Branch name or null
 */
async function getCurrentBranch(dirPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dirPath,
      timeout: 5000,
    });

    const branch = stdout.trim();
    // Handle detached HEAD
    if (branch === 'HEAD') {
      return null;
    }
    return branch;
  } catch {
    return null;
  }
}

/**
 * Detect if the current directory is within a CommandMate worktree
 *
 * Attempts to extract issue number from:
 * 1. Directory path (e.g., commandmate-issue-135)
 * 2. Git branch name (e.g., feature/135-description)
 *
 * @param dirPath - Directory path to check (defaults to cwd)
 * @returns WorktreeInfo if detected, null otherwise
 *
 * @example
 * ```typescript
 * const info = await detectCurrentWorktree();
 * if (info) {
 *   console.log(`Running in worktree for Issue #${info.issueNo}`);
 * }
 * ```
 */
export async function detectCurrentWorktree(dirPath?: string): Promise<WorktreeInfo | null> {
  const targetPath = dirPath || process.cwd();

  try {
    // Get git root
    const gitRoot = await getGitRoot(targetPath);
    if (!gitRoot) {
      return null;
    }

    // Get current branch
    const branch = await getCurrentBranch(targetPath);

    // Try to extract issue number from path first
    let issueNo = extractIssueNoFromPath(gitRoot);

    // If not found in path, try branch name
    if (issueNo === null && branch) {
      issueNo = extractIssueNoFromBranch(branch);
    }

    // If no issue number found, this is not a worktree for an issue
    if (issueNo === null) {
      return null;
    }

    return {
      issueNo,
      path: gitRoot,
      branch: branch || 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Detect worktree from environment or current directory
 * Convenience function that checks CM_ISSUE_NO env var first
 *
 * @returns WorktreeInfo if detected, null otherwise
 */
export async function detectWorktreeContext(): Promise<WorktreeInfo | null> {
  // Check environment variable first
  const envIssueNo = process.env.CM_ISSUE_NO;
  if (envIssueNo) {
    const issueNo = parseInt(envIssueNo, 10);
    if (Number.isInteger(issueNo) && issueNo > 0) {
      const gitRoot = await getGitRoot(process.cwd());
      const branch = await getCurrentBranch(process.cwd());

      return {
        issueNo,
        path: gitRoot || process.cwd(),
        branch: branch || 'unknown',
      };
    }
  }

  // Fall back to detection
  return detectCurrentWorktree();
}
