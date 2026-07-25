/**
 * Git status: working-tree status, ahead/behind, and porcelain staged buckets.
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 */

import path from 'path';
import { stat } from 'fs/promises';
import type { GitStatus, AheadBehind, AheadBehindReason } from '@/types/models';
import type { ChangedFile, GitStagedResponse } from '@/types/git';
import { GIT_WRITE_TIMEOUT_MS } from '@/config/git-status-config';
import { createLogger } from '@/lib/logger';
import { execGitCommand, execGitCommandCapture, execGitCommandTyped } from './git-exec';

const logger = createLogger('git-status');

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
 * Result of {@link getAheadBehind} (Issue #1515, B-1).
 *
 * `reason` is non-null EXACTLY when `aheadBehind` is null, so the UI can explain
 * the missing `↑N ↓N` chip instead of silently rendering nothing.
 */
export interface AheadBehindResult {
  aheadBehind: AheadBehind | null;
  /** null when `aheadBehind` was computed successfully. */
  reason: AheadBehindReason | null;
}

/**
 * Classify a `git rev-list @{upstream}...HEAD` failure into a coarse reason
 * (Issue #1515, B-1). Best-effort: unrecognized wording falls back to 'error'.
 *
 * The wordings below were measured on git 2.49 (`fatal:` prefix omitted):
 * - no upstream configured for branch 'x'                    -> no_upstream
 * - HEAD does not point to a branch                          -> detached
 * - ambiguous argument '@{upstream}...HEAD': unknown revision -> upstream_gone
 *   (an upstream IS configured, but `refs/remotes/<remote>/<branch>` is gone)
 *
 * SECURITY: the stderr is read for matching ONLY. The returned value is a fixed
 * enum member — no stderr text is ever propagated to the caller (and from there
 * to the HTTP body).
 */
function classifyAheadBehindStderr(stderr: string): AheadBehindReason {
  if (/no upstream/i.test(stderr)) {
    return 'no_upstream';
  }
  if (/HEAD does not point to a branch|not point to a branch/i.test(stderr)) {
    return 'detached';
  }
  if (/unknown revision|ambiguous argument|bad revision/i.test(stderr)) {
    return 'upstream_gone';
  }
  return 'error';
}

/**
 * Get ahead/behind commit counts relative to the upstream branch.
 * Issue #779: git status API + GitPane Current Status (Phase 1/5).
 *
 * Runs `git rev-list --left-right --count @{upstream}...HEAD` which prints
 * `<left>\t<right>` where (for `@{upstream}...HEAD`) left = commits only on
 * upstream = behind, and right = commits only on HEAD = ahead.
 * (Verified empirically: local ahead2/behind1 -> '1\t2'.)
 *
 * IMPORTANT (Issue #1515): `@{upstream}` resolves to the LOCAL remote-tracking
 * ref, i.e. the last `git fetch` snapshot. Without a fetch these counts never
 * change no matter how far the remote has moved — see {@link getLastFetchAt},
 * which the API returns alongside so the UI can date the comparison.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @returns `{ aheadBehind, reason }`: counts on success, else `aheadBehind: null`
 *          plus the classified reason (no upstream / upstream gone / detached
 *          HEAD / timeout / parse failure). NEVER throws.
 *
 * @remarks
 * - Static arg-array (no string concatenation, no @{upstream} substitution) for
 *   command-injection safety (execFile, trusted path only).
 * - Issue #1515 (B-1): uses execGitCommandCapture (same 1s timeout, still
 *   non-throwing) instead of execGitCommand so the stderr can be CLASSIFIED. The
 *   raw stderr never leaves this function — only the enum does.
 * - The strict parse below (tab-count check + Number.isInteger guard) maps every
 *   malformed/empty/corrupt output to `reason: 'error'`.
 */
export async function getAheadBehind(
  worktreePath: string
): Promise<AheadBehindResult> {
  const outcome = await execGitCommandCapture(
    ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
    worktreePath
  );

  if (!outcome.ok) {
    const reason = outcome.timedOut ? 'error' : classifyAheadBehindStderr(outcome.stderr);
    // Server-side breadcrumb with the CLASSIFIED reason only (no stderr, which
    // can carry credential-bearing URLs). debug level because a branch with no
    // upstream is an expected state re-polled every few seconds.
    logger.debug('git:ahead-behind-unavailable', { reason });
    return { aheadBehind: null, reason };
  }

  const parts = outcome.stdout.split('\t');
  if (parts.length !== 2) {
    return { aheadBehind: null, reason: 'error' };
  }

  const behind = parseInt(parts[0], 10);
  const ahead = parseInt(parts[1], 10);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
    return { aheadBehind: null, reason: 'error' };
  }

  return { aheadBehind: { ahead, behind }, reason: null };
}

/**
 * Get when this worktree last fetched from a remote, as epoch milliseconds
 * (Issue #1515, A-3). Returns null when nothing has ever been fetched, and NEVER
 * throws.
 *
 * Uses the mtime of `FETCH_HEAD`, which git rewrites on EVERY fetch — including
 * a fetch that brought nothing new (verified empirically on git 2.49). That
 * makes it a true "when did we last look at the remote?" signal, which is
 * exactly what dates the {@link getAheadBehind} comparison.
 *
 * Two FETCH_HEAD files are considered because CommandMate's worktrees are LINKED
 * worktrees (verified empirically):
 * - `<gitdir>/FETCH_HEAD` (`--git-path FETCH_HEAD`) — written when the fetch ran
 *   in THIS worktree (e.g. via the Current Status refresh button)
 * - `<common-dir>/FETCH_HEAD` — written when the fetch ran in the repository root
 * A fetch in either place updates the SHARED `refs/remotes/*` that ahead/behind
 * reads, so the freshest of the two is the honest answer. (A fetch run from a
 * *sibling* worktree is not visible here; it would read as older, never newer.)
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @returns Epoch ms of the newest FETCH_HEAD, or null if none exists / git failed
 */
export async function getLastFetchAt(worktreePath: string): Promise<number | null> {
  const output = await execGitCommand(
    ['rev-parse', '--git-path', 'FETCH_HEAD', '--git-common-dir'],
    worktreePath
  );
  if (output === null) {
    return null;
  }

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  // `git rev-parse --git-path` prints a path relative to the worktree for a
  // normal repo and an absolute one for a linked worktree; path.resolve handles
  // both. The Set collapses the two candidates when they coincide (normal repo).
  const candidates = new Set<string>([path.resolve(worktreePath, lines[0])]);
  if (lines[1]) {
    candidates.add(path.resolve(worktreePath, lines[1], 'FETCH_HEAD'));
  }

  let latest: number | null = null;
  for (const candidate of candidates) {
    try {
      const { mtimeMs } = await stat(candidate);
      if (latest === null || mtimeMs > latest) {
        latest = mtimeMs;
      }
    } catch {
      // Missing FETCH_HEAD = never fetched through that gitdir. Not an error.
    }
  }

  return latest === null ? null : Math.round(latest);
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
