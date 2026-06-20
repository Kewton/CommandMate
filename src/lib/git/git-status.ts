/**
 * Git status: working-tree status, ahead/behind, and porcelain staged buckets.
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 */

import type { GitStatus, AheadBehind } from '@/types/models';
import type { ChangedFile, GitStagedResponse } from '@/types/git';
import { GIT_WRITE_TIMEOUT_MS } from '@/config/git-status-config';
import { execGitCommand, execGitCommandTyped } from './git-exec';

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
// Issue #780: porcelain status parsing (staged / unstaged / untracked)
// ============================================================================

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
