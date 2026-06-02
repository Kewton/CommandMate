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
import type { CommitInfo, ChangedFile, CommitLogEntry, RepositoryCommitLogs, GitStagedResponse } from '@/types/git';
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
