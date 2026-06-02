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

// =============================================================================
// Issue #781: branch list / checkout / create / delete (Phase 3/5)
// =============================================================================

/**
 * Information about a single git branch (Issue #781).
 *
 * Net-new type (no existing consumers) — additive to src/types/git.ts. Built by
 * the read-path `listBranches()` from `git branch [-r]`, plus best-effort extra
 * reads (`git symbolic-ref refs/remotes/origin/HEAD` for the default branch,
 * `git worktree list --porcelain` for checkedOutWorktreePath, `git branch -vv`
 * for upstream / aheadBehind). When an extra read fails, the corresponding field
 * degrades to its "unknown" value (isDefault=false / checkedOutWorktreePath=null
 * / upstream=null / aheadBehind=null) rather than failing the whole list.
 */
export interface BranchInfo {
  /** Local branches are e.g. "feature/781-worktree"; remote refs include the remote, e.g. "origin/main". */
  name: string;
  /** The branch currently checked out in this worktree (cannot checkout / delete it). */
  isCurrent: boolean;
  /** A remote-tracking ref (checking it out creates a new local tracking branch). */
  isRemote: boolean;
  /** The default branch (delete disabled). Sourced from origin/HEAD; false when unresolved. */
  isDefault: boolean;
  /** Upstream tracking ref (e.g. "origin/feature/x"), or null when none. */
  upstream: string | null;
  /** ahead/behind vs upstream (null when no upstream / detached). Display is best-effort. */
  aheadBehind: { ahead: number; behind: number } | null;
  /** Absolute path of another worktree that has this branch checked out, or null. */
  checkedOutWorktreePath: string | null;
}

/**
 * `include` filter for the branches API / listBranches (Issue #781).
 * - `local`  -> `git branch`     (default)
 * - `remote` -> `git branch -r`  (cached remote-tracking refs only; NO network)
 * - `all`    -> local + remote
 */
export type BranchInclude = 'local' | 'remote' | 'all';

/**
 * Response type for GET /api/worktrees/[id]/git/branches (Issue #781).
 */
export interface BranchListResponse {
  branches: BranchInfo[];
}

/**
 * Success response for POST /api/worktrees/[id]/git/checkout (Issue #781).
 */
export interface CheckoutResponse {
  success: true;
  currentBranch: string;
  isDirty: boolean;
}

/**
 * Success response for POST /api/worktrees/[id]/git/branch/create (Issue #781).
 */
export interface BranchCreateResponse {
  success: true;
  branch: BranchInfo;
}

/**
 * Success response for POST /api/worktrees/[id]/git/branch/delete (Issue #781).
 */
export interface BranchDeleteResponse {
  success: true;
  deleted: string;
}

/**
 * Machine-readable failure reasons for branch operations (Issue #781). Surfaced
 * in the route error body as `{ error, reason }` so the UI can branch / toast.
 */
export type GitBranchErrorReason =
  | 'invalid_branch_name'
  | 'branch_not_found'
  | 'not_merged'
  | 'current_branch'
  | 'default_branch'
  | 'checked_out_elsewhere'
  | 'dirty';

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
