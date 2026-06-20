/**
 * Git branch list (READ) + checkout / create / delete (WRITE).
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 */

import type { BranchInfo, BranchInclude } from '@/types/git';
import { GIT_WRITE_TIMEOUT_MS } from '@/config/git-status-config';
import { execGitCommand, execGitCommandTyped, runSerializedWrite } from './git-exec';
import { resolveDefaultBranchName } from './git-default-branch';
import {
  GitTimeoutError,
  GitNotRepoError,
  GitIndexLockedError,
  GitBranchNotFoundError,
  GitBranchNotMergedError,
  GitBranchCheckedOutElsewhereError,
  GitDirtyError,
  GitCurrentBranchError,
  GitDefaultBranchError,
} from './git-errors';

/**
 * Parse the porcelain output of `git worktree list --porcelain` into a map of
 * `branch name -> worktree path` (Issue #781). The non-porcelain
 * `parseWorktreeOutput` (worktrees.ts) cannot be reused for the porcelain form.
 *
 * Porcelain records are blank-line-separated; each record has:
 *   worktree <abs-path>
 *   HEAD <sha>
 *   branch refs/heads/<name>        (omitted when detached)
 *   detached                        (when detached HEAD)
 *
 * The returned key is the short branch name (`refs/heads/` stripped). Detached
 * records contribute no branch mapping.
 *
 * @param output - Raw stdout from `git worktree list --porcelain`
 * @returns Map of short branch name to the worktree path that has it checked out
 */
export function parseWorktreePorcelain(output: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!output) return map;

  let currentPath: string | null = null;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ') && currentPath) {
      const ref = line.slice('branch '.length).trim();
      const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      if (name) {
        map.set(name, currentPath);
      }
    } else if (line === '') {
      currentPath = null;
    }
  }
  return map;
}

/**
 * Parse `git for-each-ref --format=%(refname:short)\t%(upstream:short)\t%(upstream:track)`
 * over refs/heads into a map of `branch -> { upstream, aheadBehind }` (Issue #781).
 *
 * The track field looks like `[ahead 2, behind 1]`, `[ahead 3]`, `[behind 4]`,
 * `[gone]`, or is empty. Missing/unparseable counts default to 0 on the present
 * side; a fully absent upstream yields aheadBehind=null.
 */
export function parseForEachRefTracking(
  output: string
): Map<string, { upstream: string | null; aheadBehind: { ahead: number; behind: number } | null }> {
  const map = new Map<
    string,
    { upstream: string | null; aheadBehind: { ahead: number; behind: number } | null }
  >();
  if (!output) return map;

  for (const rawLine of output.split('\n')) {
    if (!rawLine.trim()) continue;
    const [name, upstreamRaw = '', trackRaw = ''] = rawLine.split('\t');
    if (!name) continue;

    const upstream = upstreamRaw.trim() || null;
    let aheadBehind: { ahead: number; behind: number } | null = null;

    if (upstream) {
      const aheadMatch = trackRaw.match(/ahead (\d+)/);
      const behindMatch = trackRaw.match(/behind (\d+)/);
      if (aheadMatch || behindMatch) {
        aheadBehind = {
          ahead: aheadMatch ? parseInt(aheadMatch[1], 10) : 0,
          behind: behindMatch ? parseInt(behindMatch[1], 10) : 0,
        };
      } else if (!/gone/.test(trackRaw)) {
        // Upstream set, no ahead/behind reported => in sync.
        aheadBehind = { ahead: 0, behind: 0 };
      }
    }

    map.set(name, { upstream, aheadBehind });
  }
  return map;
}

/**
 * Parse `git branch` (local) output into `{ name, isCurrent }` rows (Issue #781).
 * The current branch is prefixed with `* `; detached HEAD lines (`* (HEAD ...)`)
 * are skipped.
 */
function parseLocalBranchList(output: string): Array<{ name: string; isCurrent: boolean }> {
  const rows: Array<{ name: string; isCurrent: boolean }> = [];
  if (!output) return rows;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const isCurrent = line.startsWith('* ');
    const name = line.replace(/^[*+]?\s+/, '').trim();
    // Skip detached HEAD pseudo-entries like "(HEAD detached at abc123)".
    if (!name || name.startsWith('(')) continue;
    rows.push({ name, isCurrent });
  }
  return rows;
}

/**
 * Parse `git branch -r` (remote) output into remote ref names (Issue #781).
 * Skips the `origin/HEAD -> origin/main` pointer line.
 */
function parseRemoteBranchList(output: string): string[] {
  const names: string[] = [];
  if (!output) return names;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // e.g. "origin/HEAD -> origin/main" — pointer, not a real branch.
    if (line.includes('->')) continue;
    names.push(line);
  }
  return names;
}

/**
 * List branches for a worktree (Issue #781, READ path).
 *
 * Independent of getGitStatus / the 1s execGitCommand read path (#779/#780 stays
 * byte-invariant). Runs several read commands, each via the non-throwing 1s
 * execGitCommand, and degrades best-effort: if the default-branch or
 * worktree-list or tracking read fails, that field is filled with its "unknown"
 * value (isDefault=false / checkedOutWorktreePath=null / upstream=null /
 * aheadBehind=null) instead of failing the whole list. NEVER throws.
 *
 * @param worktreePath - Path to worktree directory (MUST be from DB, trusted source)
 * @param include - `local` (default) / `remote` / `all`
 * @returns Array of BranchInfo (empty array if the primary `git branch` read fails)
 */
export async function listBranches(
  worktreePath: string,
  include: BranchInclude = 'local'
): Promise<BranchInfo[]> {
  const wantLocal = include === 'local' || include === 'all';
  const wantRemote = include === 'remote' || include === 'all';

  const [localOut, remoteOut, defaultOut, worktreeListOut, trackingOut] = await Promise.all([
    wantLocal ? execGitCommand(['branch', '--list'], worktreePath) : Promise.resolve(''),
    wantRemote ? execGitCommand(['branch', '-r'], worktreePath) : Promise.resolve(''),
    execGitCommand(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], worktreePath),
    execGitCommand(['worktree', 'list', '--porcelain'], worktreePath),
    execGitCommand(
      ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)', 'refs/heads'],
      worktreePath
    ),
  ]);

  // origin/main short name; null if origin/HEAD is unresolved -> isDefault all false.
  const defaultBranch = defaultOut ? defaultOut.trim() : null;
  const checkedOutMap = parseWorktreePorcelain(worktreeListOut ?? '');
  const trackingMap = parseForEachRefTracking(trackingOut ?? '');

  const branches: BranchInfo[] = [];

  if (wantLocal) {
    const locals = parseLocalBranchList(localOut ?? '');
    for (const { name, isCurrent } of locals) {
      const tracking = trackingMap.get(name);
      branches.push({
        name,
        isCurrent,
        isRemote: false,
        // origin/main -> local "main" is default.
        isDefault: defaultBranch !== null && defaultBranch === `origin/${name}`,
        upstream: tracking?.upstream ?? null,
        aheadBehind: tracking?.aheadBehind ?? null,
        checkedOutWorktreePath: checkedOutMap.get(name) ?? null,
      });
    }
  }

  if (wantRemote) {
    const remotes = parseRemoteBranchList(remoteOut ?? '');
    for (const name of remotes) {
      branches.push({
        name,
        isCurrent: false,
        isRemote: true,
        isDefault: defaultBranch !== null && defaultBranch === name,
        upstream: null,
        aheadBehind: null,
        checkedOutWorktreePath: null,
      });
    }
  }

  return branches;
}

/**
 * Look up which worktree (if any) has `branch` checked out, EXCLUDING the
 * current worktree (Issue #781). Returns the occupying worktree path or null.
 * Best-effort: a failed worktree-list read yields null (no false positive).
 */
async function findCheckedOutElsewhere(
  worktreePath: string,
  branch: string
): Promise<string | null> {
  const out = await execGitCommand(['worktree', 'list', '--porcelain'], worktreePath);
  if (out === null) return null;
  const map = parseWorktreePorcelain(out);
  const occupant = map.get(branch);
  if (occupant && occupant !== worktreePath) {
    return occupant;
  }
  return null;
}

/**
 * Normalize a caught git error into a typed branch error where recognizable
 * (Issue #781). Currently maps "did not match" / "not found" / "invalid
 * reference" stderr to GitBranchNotFoundError; otherwise re-throws unchanged.
 */
function rethrowBranchError(error: unknown): never {
  if (
    error instanceof GitTimeoutError ||
    error instanceof GitNotRepoError ||
    error instanceof GitIndexLockedError
  ) {
    throw error;
  }
  const msg = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: string })?.stderr ?? '';
  const combined = `${stderr} ${msg}`;
  if (
    /did not match|not a valid ref|not found|unknown revision|invalid reference|couldn't find remote ref/i.test(
      combined
    )
  ) {
    throw new GitBranchNotFoundError('Branch not found');
  }
  throw error;
}

/**
 * Options for checkoutBranch (Issue #781).
 */
export interface CheckoutOptions {
  branch: string;
  createIfMissing?: boolean;
  from?: string;
  force?: boolean;
}

/**
 * Check out / switch to a branch (Issue #781, WRITE path).
 *
 * Preconditions (evaluated BEFORE the mutating git call, raising typed errors):
 * - The branch must not be checked out in another worktree (checked_out_elsewhere,
 *   NOT bypassable by force).
 * - When force is false, the working tree must be clean (dirty otherwise).
 *
 * Execution:
 * - createIfMissing -> `git switch -c <branch> [from] --`
 * - remote ref (`origin/<x>`) -> `git switch -c <localname> --track origin/<x> --`
 *   (avoids detached HEAD, S3-008)
 * - force -> `git checkout -f <branch> --`
 * - otherwise -> `git switch <branch> --`
 *
 * Serialized per worktree (runSerializedWrite) and uses GIT_WRITE_TIMEOUT_MS. All
 * branch args are `--`-terminated.
 *
 * @throws {GitBranchCheckedOutElsewhereError} branch occupied by another worktree
 * @throws {GitDirtyError} non-force checkout over a dirty tree
 * @throws {GitBranchNotFoundError} branch does not exist
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function checkoutBranch(
  worktreePath: string,
  options: CheckoutOptions
): Promise<void> {
  const { branch, createIfMissing = false, from, force = false } = options;

  // Precondition ORDER MATTERS: the checked_out_elsewhere guard is evaluated
  // BEFORE the force-gated dirty guard. Git itself refuses to check out a branch
  // that another worktree already has, and `force` (which only discards THIS
  // worktree's local changes) cannot legitimately steal a branch from a sibling
  // worktree. Evaluating it first means a force:true request over an occupied
  // branch still surfaces checked_out_elsewhere (409, NOT bypassable) instead of
  // being masked by — or wrongly bypassing — the dirty check (reason:
  // checked_out_elsewhere takes precedence over reason: dirty).
  const occupant = await findCheckedOutElsewhere(worktreePath, branch);
  if (occupant) {
    throw new GitBranchCheckedOutElsewhereError(
      'Branch is checked out in another worktree',
      occupant
    );
  }

  // Precondition: a dirty tree blocks a non-force checkout (reason: dirty). force
  // intentionally bypasses ONLY this guard (it discards local changes), never the
  // checked_out_elsewhere guard above.
  if (!force) {
    const status = await execGitCommand(['status', '--porcelain'], worktreePath);
    if (status !== null && status.length > 0) {
      throw new GitDirtyError('Working tree has uncommitted changes');
    }
  }

  await runSerializedWrite(worktreePath, async () => {
    let args: string[];
    if (createIfMissing) {
      args = ['switch', '-c', branch];
      if (from) args.push(from);
      args.push('--');
    } else if (branch.startsWith('origin/')) {
      // Remote ref: create a local tracking branch (no detached HEAD, S3-008).
      const localName = branch.slice('origin/'.length);
      args = ['switch', '-c', localName, '--track', branch, '--'];
    } else if (force) {
      args = ['checkout', '-f', branch, '--'];
    } else {
      args = ['switch', branch, '--'];
    }

    try {
      await execGitCommandTyped(args, worktreePath, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
      rethrowBranchError(error);
    }
  });
}

/**
 * Options for createBranch (Issue #781).
 */
export interface CreateBranchOptions {
  name: string;
  from?: string;
}

/**
 * Create a branch without checking it out (Issue #781, WRITE path).
 * `git branch <name> [from] --`. Serialized per worktree.
 *
 * @throws {GitBranchNotFoundError} the `from` ref does not exist
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function createBranch(
  worktreePath: string,
  options: CreateBranchOptions
): Promise<void> {
  const { name, from } = options;
  await runSerializedWrite(worktreePath, async () => {
    const args = ['branch', name];
    if (from) args.push(from);
    args.push('--');
    try {
      await execGitCommandTyped(args, worktreePath, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
      rethrowBranchError(error);
    }
  });
}

/**
 * Options for deleteBranch (Issue #781).
 */
export interface DeleteBranchOptions {
  name: string;
  force?: boolean;
}

/**
 * Delete a branch (Issue #781, WRITE path). `git branch -d|-D <name> --`.
 *
 * Preconditions (typed errors before the mutating call):
 * - Cannot delete the current branch (current_branch).
 * - Cannot delete the default branch from origin/HEAD (default_branch).
 *
 * `git branch -d` "not fully merged" stderr is normalized to
 * GitBranchNotMergedError (409). Serialized per worktree.
 *
 * @throws {GitCurrentBranchError | GitDefaultBranchError} precondition failures
 * @throws {GitBranchNotMergedError} `-d` refused (use force)
 * @throws {GitBranchNotFoundError} branch does not exist
 * @throws {GitIndexLockedError | GitTimeoutError | GitNotRepoError} infra errors
 */
export async function deleteBranch(
  worktreePath: string,
  options: DeleteBranchOptions
): Promise<void> {
  const { name, force = false } = options;

  // Precondition: refuse to delete the current branch.
  const current = await execGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  if (current !== null && current.trim() === name) {
    throw new GitCurrentBranchError('Cannot delete the current branch');
  }

  // Precondition: refuse to delete the default branch (origin/HEAD-derived).
  // Issue #783 (DR1-001): consolidated onto the shared resolveDefaultBranchName
  // helper. BYTE-INVARIANT: resolveDefaultBranchName collapses both
  // DEFAULT_BRANCH_UNRESOLVED and a non-origin/ value into null, and null never
  // equals `name`, so the original "unresolved = NOT protected" behavior is kept
  // (NO main/master fallback here — deliberately asymmetric to reset, §4.2).
  const defaultName = await resolveDefaultBranchName(worktreePath);
  if (defaultName !== null && defaultName === name) {
    throw new GitDefaultBranchError('Cannot delete the default branch');
  }

  await runSerializedWrite(worktreePath, async () => {
    const flag = force ? '-D' : '-d';
    try {
      await execGitCommandTyped(['branch', flag, name, '--'], worktreePath, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stderr = (error as { stderr?: string })?.stderr ?? '';
      const combined = `${stderr} ${msg}`;
      if (/not fully merged/i.test(combined)) {
        throw new GitBranchNotMergedError('Branch is not fully merged');
      }
      rethrowBranchError(error);
    }
  });
}
