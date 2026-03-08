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
 */
export interface ChangedFile {
  /** File path */
  path: string;
  /** Change status */
  status: 'added' | 'modified' | 'deleted' | 'renamed';
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
