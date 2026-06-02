/**
 * Git type definitions
 * Issue #447: Git tab feature (commit history & diff display)
 */

/**
 * Commit information
 */
export interface CommitInfo {
  /** Full commit hash */
  hash: string;
  /** Short commit hash (7 characters) */
  shortHash: string;
  /** Commit message */
  message: string;
  /** Author name */
  author: string;
  /** Date in ISO 8601 format */
  date: string;
}

/**
 * Changed file in a commit
 *
 * Issue #780: union extended with 'untracked' | 'unmerged' (ADDITIVE — the
 * original 4 values are unchanged so existing #447/#627 consumers behave
 * identically). 'untracked' / 'unmerged' only appear in the working-tree
 * status (parsePorcelainStatus / getStagedStatus), never in commit diffs.
 */
export interface ChangedFile {
  /** File path */
  path: string;
  /** Change status */
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'unmerged';
}

/**
 * Response type for the git staged-status API (Issue #780).
 *
 * Splits the working-tree status into three buckets:
 * - staged:    entries with a non-space, non-`?` index (X) column
 * - unstaged:  entries with a non-space, non-`?` worktree (Y) column
 * - untracked: porcelain `??` entries
 *
 * Unmerged (conflict) entries are surfaced with status `'unmerged'` in the
 * `unstaged` list (a conflicted file needs working-tree resolution before it
 * can be staged, so the unstaged bucket is the actionable place for it).
 */
export interface GitStagedResponse {
  /** Files with staged (index) changes */
  staged: ChangedFile[];
  /** Files with unstaged (working-tree) changes, including unmerged conflicts */
  unstaged: ChangedFile[];
  /** Untracked files (`??` in porcelain output) */
  untracked: ChangedFile[];
}

/**
 * Response type for git log API
 */
export interface GitLogResponse {
  commits: CommitInfo[];
}

/**
 * Response type for git show API
 */
export interface GitShowResponse {
  commit: CommitInfo;
  files: ChangedFile[];
}

/**
 * Response type for git diff API
 */
export interface GitDiffResponse {
  /** Unified diff format */
  diff: string;
}

/**
 * Commit hash validation pattern: 7-40 lowercase hex characters
 * Used by API routes to validate commit hash parameters before passing to git commands.
 */
export const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/;

// =============================================================================
// Issue #627: Commit log in report
// =============================================================================

/**
 * Lightweight commit entry for report generation.
 * Picks only the fields needed for commit log display.
 */
export type CommitLogEntry = Pick<CommitInfo, 'shortHash' | 'message' | 'author'>;

/**
 * Map of repository ID to its name and commits.
 * Used to collect commit logs across all repositories for daily reports.
 */
export type RepositoryCommitLogs = Map<string, { name: string; commits: CommitLogEntry[] }>;

// =============================================================================
// Issue #630: Issue context in report
// =============================================================================

/**
 * GitHub Issue information for report generation context.
 * Includes repository name prefix to distinguish same issue numbers across repos.
 */
export interface IssueInfo {
  /** Repository name (for disambiguation when same issue number exists in multiple repos) */
  repositoryName: string;
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue labels */
  labels: string[];
  /** Issue state (open/closed) */
  state: string;
  /** Truncated body summary (up to MAX_ISSUE_BODY_LENGTH chars) */
  bodySummary: string;
}
