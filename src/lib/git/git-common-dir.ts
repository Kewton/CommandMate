/**
 * Scan-root identity: *which git repository* does a registered directory belong
 * to? (Issue #1662)
 *
 * `repositories` rows are keyed by directory path, but a git repository can be
 * checked out at many paths at once — every linked worktree is its own
 * directory. Registering two of them as separate scan roots makes both scans
 * enumerate the *same* worktree set, so every sync upserts each worktree twice
 * and `worktrees.repository_path` flips between the two roots run to run. That
 * is the configuration behind the #1659 ID churn; #1660 stopped the churn, and
 * this module is what lets a user SEE the configuration that caused it.
 *
 * The identity used is `git rev-parse --git-common-dir`, resolved to a physical
 * path. All worktrees of one repository share that directory by construction —
 * `git worktree list` is itself derived from it (the main worktree plus
 * `<common-dir>/worktrees/*`), which is why comparing common dirs is enough and
 * the two roots' `git worktree list` output cannot disagree. Verified
 * empirically on git 2.49 against a repository with 29 worktrees: the listing
 * taken from a linked worktree and from the main checkout was byte-identical.
 *
 * Failure is never fatal here. A path that is not a git repository, a git that
 * is missing or times out, a directory that has been deleted — all resolve to
 * `null`, which means "no opinion" and leaves the caller's flow untouched.
 */

import path from 'path';
import { realpath } from 'fs/promises';
import { execGitCommandCapture } from './git-exec';

/**
 * The physical `.git` common directory shared by every worktree of one
 * repository, or `null` when the question cannot be answered.
 *
 * Two normalizations matter and both are load-bearing:
 *
 * 1. `git rev-parse --git-common-dir` prints an ABSOLUTE path from a linked
 *    worktree but a RELATIVE one (`.git`) from a main checkout — measured, not
 *    assumed. `path.resolve(repoPath, …)` covers both.
 * 2. The result is passed through `realpath`, because the two roots being
 *    compared may reach the same directory through different symlinked
 *    prefixes. On macOS this is not hypothetical: `/tmp` is a symlink to
 *    `/private/tmp`, and the very repository pair in #1659 had worktrees under
 *    it. Lexical comparison would miss that pair.
 *
 * Uses {@link execGitCommandCapture} rather than `execGitCommand` on purpose:
 * "not a git repository" is an EXPECTED answer on this path (the user may be
 * typing a path into the Add form), and `execGitCommand` would log it at error
 * level every keystroke.
 *
 * @param repoPath - Directory to interrogate. Never interpolated into a shell.
 * @returns Physical common-dir path, or `null` when git could not answer.
 */
export async function resolveGitCommonDir(repoPath: string): Promise<string | null> {
  const outcome = await execGitCommandCapture(['rev-parse', '--git-common-dir'], repoPath);
  if (!outcome.ok) {
    return null;
  }

  const firstLine = outcome.stdout.split('\n')[0]?.trim();
  if (!firstLine) {
    return null;
  }

  return realpathOrLexical(path.resolve(repoPath, firstLine));
}

/**
 * `realpath` that degrades to the lexical path instead of throwing.
 *
 * A common dir that cannot be `realpath`'d (racing deletion, permissions) still
 * compares usefully against another lexical path, and losing the whole
 * comparison over it would be worse than comparing slightly too strictly.
 */
async function realpathOrLexical(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}

/**
 * A set of scan roots that are all the same git repository (Issue #1662).
 */
export interface DuplicateScanRootGroup {
  /** Physical `.git` common directory the group shares. */
  commonDir: string;
  /**
   * The scan-root paths that resolve to it, VERBATIM as supplied by the caller
   * so they can be matched back to `repositories` rows. Always 2 or more.
   */
  paths: string[];
}

/**
 * Resolve the common dir of every supplied scan root, in parallel.
 *
 * Paths whose common dir cannot be resolved are simply absent from the result
 * (see the module docstring: failure means "no opinion"). Duplicated inputs are
 * resolved once; the returned map is keyed by the caller's original strings.
 *
 * Parallel rather than sequential because the caller is an HTTP handler and
 * each probe carries the 1s `execGitCommandCapture` timeout — serialized, a
 * dozen dead scan roots would add a dozen seconds to a page load.
 */
export async function resolveGitCommonDirs(
  repoPaths: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(repoPaths)];
  const resolved = await Promise.all(unique.map((p) => resolveGitCommonDir(p)));

  const byPath = new Map<string, string>();
  unique.forEach((repoPath, index) => {
    const commonDir = resolved[index];
    if (commonDir !== null) {
      byPath.set(repoPath, commonDir);
    }
  });
  return byPath;
}

/**
 * Which of the supplied scan roots are secretly the same repository?
 *
 * @param repoPaths - Scan-root paths to compare (typically the ENABLED
 *   `repositories` rows — a disabled root is not scanned, so it cannot be half
 *   of a double-scan; see `GET /api/repositories`).
 * @returns One group per repository that more than one path points at. Empty
 *   when every path is its own repository, which is the normal case: two
 *   worktrees of two DIFFERENT repositories have different common dirs and are
 *   never grouped.
 */
export async function findDuplicateScanRoots(
  repoPaths: string[]
): Promise<DuplicateScanRootGroup[]> {
  const byPath = await resolveGitCommonDirs(repoPaths);

  const byCommonDir = new Map<string, string[]>();
  for (const [repoPath, commonDir] of byPath) {
    const members = byCommonDir.get(commonDir);
    if (members) {
      members.push(repoPath);
    } else {
      byCommonDir.set(commonDir, [repoPath]);
    }
  }

  const groups: DuplicateScanRootGroup[] = [];
  for (const [commonDir, paths] of byCommonDir) {
    if (paths.length > 1) {
      groups.push({ commonDir, paths });
    }
  }
  return groups;
}

/**
 * Which ALREADY-REGISTERED scan roots would a newly registered `candidatePath`
 * duplicate? (Issue #1662, registration side.)
 *
 * Re-registering a path that is already a scan root is deliberately NOT a
 * duplicate: it is the same root, and reporting it would fire the warning on
 * every ordinary re-scan — the "does not false-positive" acceptance criterion.
 * Sameness is decided on physical paths, so a symlinked spelling of an existing
 * root is recognised as that root rather than reported as a second one.
 *
 * @param candidatePath - Path about to be registered.
 * @param existingPaths - Currently registered scan-root paths.
 * @returns The existing paths (verbatim) that share the candidate's repository.
 *   Empty when there is no overlap, when the candidate is not a git repository,
 *   or when git could not answer — none of which may block registration.
 */
export async function findScanRootsSharingGitRepository(
  candidatePath: string,
  existingPaths: string[]
): Promise<string[]> {
  const candidateCommonDir = await resolveGitCommonDir(candidatePath);
  if (candidateCommonDir === null) {
    return [];
  }

  const candidateReal = await realpathOrLexical(path.resolve(candidatePath));
  const others = existingPaths.filter((existing) => existing !== candidatePath);

  const otherReals = await Promise.all(
    others.map((existing) => realpathOrLexical(path.resolve(existing)))
  );
  const distinctRoots = others.filter((_, index) => otherReals[index] !== candidateReal);

  const byPath = await resolveGitCommonDirs(distinctRoots);
  return distinctRoots.filter((existing) => byPath.get(existing) === candidateCommonDir);
}
