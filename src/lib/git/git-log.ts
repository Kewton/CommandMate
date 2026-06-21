/**
 * Git log / show + repository commit-log collection.
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 */

import fs from 'fs';
import type {
  CommitInfo,
  ChangedFile,
  CommitLogEntry,
  RepositoryCommitLogs,
} from '@/types/git';
import { createLogger } from '@/lib/logger';
import { execFileAsync, execGitCommandTyped, GIT_LOG_TIMEOUT_MS } from './git-exec';
import { GitTimeoutError, GitNotRepoError } from './git-errors';

const logger = createLogger('git-log');

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
